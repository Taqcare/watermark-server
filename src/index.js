/**
 * Watermark Server — modo assíncrono (job + polling).
 *
 * Endpoints:
 *   GET  /health               — status
 *   GET  /debug                — diagnóstico
 *   POST /jobs                 — cria job (multipart: video, overlay, config) -> { jobId }
 *   GET  /jobs/:id             — { status: queued|processing|done|error, error?, sizeBytes? }
 *   GET  /jobs/:id/result      — baixa o MP4 (somente quando status=done)
 *
 * Compatibilidade legada:
 *   POST /process              — mantido (síncrono) para clientes antigos.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8080', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '300', 10);
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'watermark');
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || String(60 * 60 * 1000), 10); // 1h

fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()) }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(8).toString('hex');
    const safe = file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, `${Date.now()}_${id}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

// ---------------- in-memory job registry ----------------
/**
 * jobs: Map<jobId, {
 *   status: 'queued'|'processing'|'done'|'error',
 *   createdAt: number,
 *   updatedAt: number,
 *   error?: string,
 *   outPath?: string,
 *   sizeBytes?: number,
 *   originalName?: string,
 *   cleanupPaths: string[],
 * }>
 */
const jobs = new Map();

function newJob(originalName) {
  const id = crypto.randomBytes(8).toString('hex');
  jobs.set(id, {
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    originalName,
    cleanupPaths: [],
  });
  return id;
}
function updateJob(id, patch) {
  const j = jobs.get(id);
  if (!j) return;
  Object.assign(j, patch, { updatedAt: Date.now() });
}

// GC periódico de jobs antigos
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs.entries()) {
    if (now - j.updatedAt > JOB_TTL_MS) {
      cleanup(j.cleanupPaths || []);
      jobs.delete(id);
      console.log(`[gc] removed job ${id} (age=${Math.round((now - j.updatedAt) / 1000)}s)`);
    }
  }
}, 5 * 60 * 1000).unref?.();

// ---------------- endpoints ----------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'watermark-server', uptime: process.uptime(), jobs: jobs.size });
});

app.get('/debug', async (_req, res) => {
  try {
    const mem = process.memoryUsage();
    let ffmpegVersion = null;
    try {
      const { stdout } = await runCommand('ffmpeg', ['-version'], { silent: true });
      ffmpegVersion = (stdout || '').split('\n')[0];
    } catch (e) {
      ffmpegVersion = `error: ${e.message}`;
    }
    let tmpStats = null;
    try {
      const files = fs.readdirSync(TMP_DIR);
      let totalBytes = 0;
      for (const f of files) {
        try { totalBytes += fs.statSync(path.join(TMP_DIR, f)).size; } catch {}
      }
      tmpStats = { fileCount: files.length, totalBytes };
    } catch (e) {
      tmpStats = { error: e.message };
    }
    res.json({
      ok: true, service: 'watermark-server', uptime: process.uptime(),
      node: process.version, pid: process.pid, memoryUsage: mem,
      system: {
        totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMemMB: Math.round(os.freemem() / 1024 / 1024),
        cpus: os.cpus().length, loadavg: os.loadavg(),
        platform: os.platform(), arch: os.arch(),
      },
      ffmpegVersion, tmpDir: TMP_DIR, tmpStats, maxFileMB: MAX_FILE_MB,
      jobsActive: jobs.size,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- POST /jobs ---- async: aceita vídeo, devolve { jobId } imediatamente
app.post(
  '/jobs',
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 }]),
  (req, res) => {
    const videoFile = req.files?.video?.[0];
    const overlayFile = req.files?.overlay?.[0];
    if (!videoFile) return res.status(400).json({ error: 'missing video' });

    let config = {};
    try { config = req.body.config ? JSON.parse(req.body.config) : {}; }
    catch { return res.status(400).json({ error: 'invalid config json' }); }

    const jobId = newJob(videoFile.originalname);
    const job = jobs.get(jobId);
    job.cleanupPaths.push(videoFile.path);
    if (overlayFile) job.cleanupPaths.push(overlayFile.path);

    // dispara processamento em background
    setImmediate(() => {
      runPipeline(jobId, videoFile, overlayFile, config).catch((err) => {
        console.error(`[job ${jobId}] 💥`, err?.message || err);
        updateJob(jobId, { status: 'error', error: err?.message || 'internal error' });
      });
    });

    res.status(202).json({ jobId });
  },
);

// ---- GET /jobs/:id ----
app.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json({
    status: j.status,
    error: j.error || null,
    sizeBytes: j.sizeBytes || null,
    originalName: j.originalName || null,
    ageMs: Date.now() - j.createdAt,
  });
});

// ---- GET /jobs/:id/result ----
app.get('/jobs/:id/result', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  if (j.status !== 'done' || !j.outPath) {
    return res.status(409).json({ error: `job not ready (status=${j.status})` });
  }
  const size = safeSize(j.outPath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="watermarked_${sanitizeName(j.originalName || 'video')}.mp4"`,
  );
  res.setHeader('Content-Length', size);
  const stream = fs.createReadStream(j.outPath);
  stream.on('end', () => {
    cleanup(j.cleanupPaths);
    jobs.delete(req.params.id);
  });
  stream.on('error', (err) => {
    console.error(`[job ${req.params.id}] stream error`, err);
    cleanup(j.cleanupPaths);
    jobs.delete(req.params.id);
  });
  stream.pipe(res);
});

// ---- LEGACY POST /process (síncrono — mantido por compatibilidade) ----
app.post(
  '/process',
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 }]),
  async (req, res) => {
    const videoFile = req.files?.video?.[0];
    const overlayFile = req.files?.overlay?.[0];
    if (!videoFile) return res.status(400).json({ error: 'missing video' });

    let config = {};
    try { config = req.body.config ? JSON.parse(req.body.config) : {}; }
    catch { return res.status(400).json({ error: 'invalid config json' }); }

    const jobId = newJob(videoFile.originalname);
    const job = jobs.get(jobId);
    job.cleanupPaths.push(videoFile.path);
    if (overlayFile) job.cleanupPaths.push(overlayFile.path);

    try {
      await runPipeline(jobId, videoFile, overlayFile, config);
      const j = jobs.get(jobId);
      if (j.status !== 'done') throw new Error(j.error || 'falhou');

      const size = safeSize(j.outPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="watermarked_${sanitizeName(videoFile.originalname)}.mp4"`);
      res.setHeader('Content-Length', size);
      const stream = fs.createReadStream(j.outPath);
      stream.on('end', () => { cleanup(j.cleanupPaths); jobs.delete(jobId); });
      stream.on('error', () => { cleanup(j.cleanupPaths); jobs.delete(jobId); });
      stream.pipe(res);
    } catch (err) {
      const j = jobs.get(jobId);
      if (j) cleanup(j.cleanupPaths);
      jobs.delete(jobId);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'internal error' });
      else { try { res.end(); } catch {} }
    }
  },
);

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Arquivo excede ${MAX_FILE_MB}MB` });
  }
  if (err) {
    console.error('app error', err);
    return res.status(500).json({ error: err.message || 'internal error' });
  }
  res.status(404).json({ error: 'not found' });
});

app.listen(PORT, () => {
  console.log(`[watermark-server] up on :${PORT} | tmp=${TMP_DIR} | maxMB=${MAX_FILE_MB} | node=${process.version}`);
  console.log(`[watermark-server] memTotal=${Math.round(os.totalmem() / 1024 / 1024)}MB cpus=${os.cpus().length}`);
});

// ---------------- pipeline ----------------

async function runPipeline(jobId, videoFile, overlayFile, config) {
  const log = (...a) => console.log(`[job ${jobId}]`, ...a);
  const logErr = (...a) => console.error(`[job ${jobId}]`, ...a);
  const t0 = Date.now();
  const job = jobs.get(jobId);
  if (!job) throw new Error('job desapareceu');

  updateJob(jobId, { status: 'processing' });

  const videoSizeMB = (videoFile.size / 1024 / 1024).toFixed(2);
  const overlaySizeKB = overlayFile ? (overlayFile.size / 1024).toFixed(1) : null;
  log(`📥 input: video="${videoFile.originalname}" size=${videoSizeMB}MB overlay=${overlaySizeKB ? overlaySizeKB + 'KB' : 'none'}`);
  log('config:', JSON.stringify(config));

  const position = config.position || 'center';
  const opacity = clamp(num(config.opacity, 1), 0, 1);
  const paddingPct = clamp(num(config.paddingPct, 0.02), 0, 0.5);
  const maxDim = clamp(int(config.maxDim, 1920), 360, 3840);
  const moving = !!config.moving;
  const movingSpeed = clamp(num(config.movingSpeed, 20), 1, 100);
  const overlayWidthPct = config.overlayWidthPct != null ? clamp(num(config.overlayWidthPct, 20), 1, 100) : null;

  // probe
  const tProbe = Date.now();
  let videoInfo;
  try { videoInfo = await probeVideoInfo(videoFile.path); }
  catch (e) { throw new Error(`Falha ao analisar o vídeo: ${e.message}`); }
  const outputSize = fitDimensionsWithinBounds(videoInfo.width, videoInfo.height, maxDim);
  log(`🔍 probe (${Date.now() - tProbe}ms): ${videoInfo.width}x${videoInfo.height} hasAudio=${videoInfo.hasAudio} -> ${outputSize.width}x${outputSize.height}`);

  // base scale
  const basePath = path.join(TMP_DIR, `base_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`);
  job.cleanupPaths.push(basePath);
  const tBase = Date.now();
  try {
    await runFfmpeg(buildScaledVideoArgs({
      inputPath: videoFile.path, outPath: basePath,
      width: outputSize.width, height: outputSize.height, hasAudio: videoInfo.hasAudio,
    }), { tag: `${jobId}/prepare-video` });
  } catch (e) { throw new Error(`Falha ao escalar vídeo: ${e.message}`); }
  log(`✅ prepare-video (${Date.now() - tBase}ms): ${(safeSize(basePath) / 1024 / 1024).toFixed(2)}MB`);

  // overlay prep
  let preparedOverlayPath = null;
  if (overlayFile) {
    preparedOverlayPath = path.join(TMP_DIR, `overlay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`);
    job.cleanupPaths.push(preparedOverlayPath);
    const overlayWidthPx = overlayWidthPct != null
      ? makeEven(Math.max(2, Math.round((outputSize.width * overlayWidthPct) / 100)))
      : null;
    const tOv = Date.now();
    try {
      await runFfmpeg(buildOverlayPrepArgs({
        inputPath: overlayFile.path, outPath: preparedOverlayPath,
        opacity, width: overlayWidthPx,
      }), { tag: `${jobId}/prepare-overlay` });
    } catch (e) { throw new Error(`Falha ao preparar overlay: ${e.message}`); }
    log(`✅ prepare-overlay (${Date.now() - tOv}ms): ${overlayWidthPx ? overlayWidthPx + 'px' : 'native'} -> ${(safeSize(preparedOverlayPath) / 1024).toFixed(1)}KB`);
  }

  // composite
  const outPath = path.join(TMP_DIR, `out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`);
  job.cleanupPaths.push(outPath);
  const tComp = Date.now();
  try {
    await runFfmpeg(buildOverlayCompositeArgs({
      videoPath: basePath, overlayPath: preparedOverlayPath, outPath,
      position, paddingPct, moving, movingSpeed, hasAudio: videoInfo.hasAudio,
    }), { tag: `${jobId}/composite` });
  } catch (e) { throw new Error(`Falha ao compor overlay: ${e.message}`); }

  const finalSize = safeSize(outPath);
  log(`✅ composite (${Date.now() - tComp}ms): ${(finalSize / 1024 / 1024).toFixed(2)}MB`);
  log(`🎉 done total=${Date.now() - t0}ms`);

  updateJob(jobId, { status: 'done', outPath, sizeBytes: finalSize });
}

// ---------------- helpers ----------------

function num(v, def) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : def; }
function int(v, def) { const n = typeof v === 'number' ? Math.round(v) : parseInt(v, 10); return Number.isFinite(n) ? n : def; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function sanitizeName(name) { return (name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w.\-]/g, '_').slice(0, 80); }
function safeSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function cleanup(paths) { for (const p of paths) { if (!p) continue; fs.unlink(p, () => {}); } }

function buildScaledVideoArgs({ inputPath, outPath, width, height, hasAudio }) {
  const args = ['-y', '-i', inputPath, '-map', '0:v:0'];
  if (hasAudio) args.push('-map', '0:a:0?');
  args.push(
    '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  else args.push('-an');
  args.push('-threads', '2', outPath);
  return args;
}

function buildOverlayPrepArgs({ inputPath, outPath, opacity, width }) {
  const filterParts = ['format=rgba', `colorchannelmixer=aa=${opacity.toFixed(3)}`];
  if (width != null) filterParts.push(`scale=${width}:-2:flags=lanczos`);
  return ['-y', '-i', inputPath, '-vf', filterParts.join(','), '-frames:v', '1', outPath];
}

function buildOverlayCompositeArgs({ videoPath, overlayPath, outPath, position, paddingPct, moving, movingSpeed, hasAudio }) {
  if (!overlayPath) {
    return ['-y', '-i', videoPath, '-c', 'copy', '-movflags', '+faststart', outPath];
  }
  const { xExpr, yExpr } = overlayPositionExpr({ position, paddingPct, moving, movingSpeed });
  const filterComplex = `[0:v][1:v]overlay=x='${xExpr}':y='${yExpr}':eof_action=pass:format=auto[outv]`;
  const args = [
    '-y', '-i', videoPath, '-loop', '1', '-i', overlayPath,
    '-filter_complex', filterComplex, '-map', '[outv]',
  ];
  if (hasAudio) args.push('-map', '0:a:0?');
  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  else args.push('-an');
  args.push('-shortest', '-threads', '2', outPath);
  return args;
}

function fitDimensionsWithinBounds(width, height, maxDim) {
  const scale = Math.min(1, maxDim / width, maxDim / height);
  return {
    width: makeEven(Math.max(2, Math.round(width * scale))),
    height: makeEven(Math.max(2, Math.round(height * scale))),
  };
}
function makeEven(value) { const r = Math.max(2, Math.round(value)); return r % 2 === 0 ? r : r - 1; }

async function probeVideoInfo(videoPath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=index,codec_type,width,height',
    '-of', 'json', videoPath,
  ], { silent: true });
  let data = {};
  try { data = JSON.parse(stdout || '{}'); } catch { throw new Error('ffprobe JSON inválido'); }
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const width = int(v?.width, 0); const height = int(v?.height, 0);
  if (!width || !height) throw new Error('Não foi possível identificar dimensões');
  return { width, height, hasAudio: !!a };
}

function overlayPositionExpr({ position, paddingPct, moving, movingSpeed }) {
  const padW = `(main_w*${paddingPct.toFixed(4)})`;
  const padH = `(main_h*${paddingPct.toFixed(4)})`;
  const maxX = `(main_w-overlay_w-${padW})`;
  const maxY = `(main_h-overlay_h-${padH})`;
  if (moving) {
    const vx = (4 * movingSpeed).toFixed(2);
    const vy = (3 * movingSpeed).toFixed(2);
    const rangeX = `(main_w-overlay_w)`;
    const rangeY = `(main_h-overlay_h)`;
    return {
      xExpr: `abs(mod(t*${vx}, 2*${rangeX}) - ${rangeX})`,
      yExpr: `abs(mod(t*${vy}, 2*${rangeY}) - ${rangeY})`,
    };
  }
  let xExpr;
  if (position.includes('left')) xExpr = padW;
  else if (position.includes('right')) xExpr = maxX;
  else xExpr = `(main_w-overlay_w)/2`;
  let yExpr;
  if (position.includes('top')) yExpr = padH;
  else if (position.includes('bottom')) yExpr = maxY;
  else yExpr = `(main_h-overlay_h)/2`;
  return { xExpr, yExpr };
}

async function runFfmpeg(args, opts = {}) { return runCommand('ffmpeg', args, opts); }
function formatCommand(bin, args) { return [bin, ...args].join(' '); }

function runCommand(bin, args, opts = {}) {
  const tag = opts.tag ? `[${bin}:${opts.tag}]` : `[${bin}]`;
  const silent = !!opts.silent;
  const t0 = Date.now();
  if (!silent) console.log(`${tag} ▶ start cmd:`, formatCommand(bin, args));
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (!silent) console.log(`${tag} pid=${proc.pid}`);
    let stdout = ''; let stderrBuf = ''; let rem = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderrBuf += chunk;
      if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-100_000);
      if (!silent) {
        const combined = rem + chunk;
        const lines = combined.split(/\r?\n/);
        rem = lines.pop() || '';
        for (const line of lines) if (line.trim()) console.log(`${tag}[stderr] ${line}`);
      }
    });
    proc.on('error', (err) => { console.error(`${tag} spawn error:`, err.message); reject(err); });
    proc.on('close', (code, signal) => {
      const dur = Date.now() - t0;
      if (!silent && rem.trim()) console.log(`${tag}[stderr] ${rem}`);
      if (code === 0) {
        if (!silent) console.log(`${tag} ✅ exit=0 dur=${dur}ms`);
        resolve({ stdout, stderr: stderrBuf });
        return;
      }
      const tail = (stderrBuf || stdout).slice(-4000);
      const isOOM = signal === 'SIGKILL' || code === 137;
      console.error(`${tag} ❌ exit=${code} signal=${signal} dur=${dur}ms`);
      if (tail) console.error(`${tag}[stderr-tail] ${tail}`);
      if (isOOM) reject(new Error(`FFmpeg morto pelo SO (SIGKILL/137) após ${dur}ms — provável OOM. Stderr: ${tail.slice(-500)}`));
      else reject(new Error(`${bin} falhou (code=${code}${signal ? `, signal=${signal}` : ''}) após ${dur}ms: ${tail || 'sem stderr'}`));
    });
  });
}
