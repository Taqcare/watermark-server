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
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const PORT = parseInt(process.env.PORT || '8080', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '300', 10);
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'watermark');
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || String(60 * 60 * 1000), 10); // 1h

// Supabase (para upload do MP4 resultado de volta ao Storage e bypass do proxy)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_RESULT_BUCKET = process.env.SUPABASE_RESULT_BUCKET || 'temp-uploads';
const SUPABASE_RESULT_TTL_SECONDS = parseInt(process.env.SUPABASE_RESULT_TTL_SECONDS || '3600', 10);
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
if (!supabaseAdmin) {
  console.warn('[watermark-server] ⚠ SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados — fallback para download via /jobs/:id/result');
}

fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '1mb' }));
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

// ---- POST /jobs-from-url ---- async: aceita URLs (Supabase Storage signed URLs)
// Body JSON: { videoUrl: string, videoName?: string, overlayUrl?: string|null, config: object }
app.post('/jobs-from-url', async (req, res) => {
  try {
    const { videoUrl, videoName, overlayUrl, config } = req.body || {};
    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({ error: 'missing videoUrl' });
    }
    if (config && typeof config !== 'object') {
      return res.status(400).json({ error: 'invalid config' });
    }

    const safeVideoName = (videoName || 'video.mp4').replace(/[^\w.\-]/g, '_');
    const jobId = newJob(safeVideoName);
    const job = jobs.get(jobId);

    console.log(`[job ${jobId}] 📡 from-url: video="${safeVideoName}" overlay=${overlayUrl ? 'yes' : 'no'}`);

    // download síncrono mas rápido (resposta volta após download iniciar). Para manter API consistente com /jobs,
    // baixamos em background e respondemos jobId imediatamente.
    setImmediate(async () => {
      try {
        const videoPath = path.join(TMP_DIR, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}_${safeVideoName}`);
        job.cleanupPaths.push(videoPath);
        const tDl = Date.now();
        const videoBytes = await downloadToFile(videoUrl, videoPath, MAX_FILE_MB * 1024 * 1024);
        console.log(`[job ${jobId}] ⬇ video baixado em ${Date.now() - tDl}ms (${(videoBytes / 1024 / 1024).toFixed(2)}MB)`);

        let overlayFile = null;
        if (overlayUrl) {
          const overlayPath = path.join(TMP_DIR, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}_overlay.png`);
          job.cleanupPaths.push(overlayPath);
          const tOv = Date.now();
          const overlayBytes = await downloadToFile(overlayUrl, overlayPath, 50 * 1024 * 1024);
          console.log(`[job ${jobId}] ⬇ overlay baixado em ${Date.now() - tOv}ms (${(overlayBytes / 1024).toFixed(1)}KB)`);
          overlayFile = { path: overlayPath, originalname: 'overlay.png', size: overlayBytes };
        }

        const videoFile = { path: videoPath, originalname: safeVideoName, size: videoBytes };
        await runPipeline(jobId, videoFile, overlayFile, config || {});
      } catch (err) {
        console.error(`[job ${jobId}] 💥 from-url`, err?.message || err);
        updateJob(jobId, { status: 'error', error: err?.message || 'internal error' });
      }
    });

    res.status(202).json({ jobId });
  } catch (err) {
    console.error('jobs-from-url error', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});

// ---- POST /jobs-from-url-censor ---- async: aplica blur/pixel em região retangular do vídeo
// Body JSON: {
//   videoUrl: string, videoName?: string,
//   region: { x, y, w, h },        // normalizado 0..1
//   censorType: 'blur'|'pixel',
//   intensity: 'leve'|'medio'|'pesado'
// }
app.post('/jobs-from-url-censor', async (req, res) => {
  try {
    const { videoUrl, videoName, region, censorType, intensity } = req.body || {};
    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({ error: 'missing videoUrl' });
    }
    if (!region || typeof region !== 'object') {
      return res.status(400).json({ error: 'missing region' });
    }
    const ct = censorType === 'pixel' ? 'pixel' : 'blur';
    const it = ['leve', 'medio', 'pesado'].includes(intensity) ? intensity : 'medio';

    const safeVideoName = (videoName || 'video.mp4').replace(/[^\w.\-]/g, '_');
    const jobId = newJob(safeVideoName);
    const job = jobs.get(jobId);
    job.kind = 'censor';

    console.log(`[job ${jobId}] 📡 censor-from-url: video="${safeVideoName}" type=${ct} intensity=${it}`);

    setImmediate(async () => {
      try {
        const videoPath = path.join(TMP_DIR, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}_${safeVideoName}`);
        job.cleanupPaths.push(videoPath);
        const tDl = Date.now();
        const videoBytes = await downloadToFile(videoUrl, videoPath, MAX_FILE_MB * 1024 * 1024);
        console.log(`[job ${jobId}] ⬇ video baixado em ${Date.now() - tDl}ms (${(videoBytes / 1024 / 1024).toFixed(2)}MB)`);

        const videoFile = { path: videoPath, originalname: safeVideoName, size: videoBytes };
        await runCensorPipeline(jobId, videoFile, { region, censorType: ct, intensity: it });
      } catch (err) {
        console.error(`[job ${jobId}] 💥 censor-from-url`, err?.message || err);
        updateJob(jobId, { status: 'error', error: err?.message || 'internal error' });
      }
    });

    res.status(202).json({ jobId });
  } catch (err) {
    console.error('jobs-from-url-censor error', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  }
});

// ---- GET /jobs/:id ----
app.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json({
    status: j.status,
    error: j.error || null,
    sizeBytes: j.sizeBytes || null,
    originalName: j.originalName || null,
    resultUrl: j.resultUrl || null,
    resultPath: j.resultPath || null,
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

  // Upload do resultado para o Supabase Storage (bypass do proxy do Easypanel no caminho de volta)
  let resultUrl = null;
  let resultPath = null;
  if (supabaseAdmin) {
    try {
      const tUp = Date.now();
      const safeName = sanitizeName(videoFile.originalname);
      resultPath = `_watermark-results/${jobId}/watermarked_${safeName}.mp4`;
      const fileBuffer = fs.readFileSync(outPath);
      const up = await supabaseAdmin.storage
        .from(SUPABASE_RESULT_BUCKET)
        .upload(resultPath, fileBuffer, { contentType: 'video/mp4', upsert: true });
      if (up.error) throw up.error;
      const signed = await supabaseAdmin.storage
        .from(SUPABASE_RESULT_BUCKET)
        .createSignedUrl(resultPath, SUPABASE_RESULT_TTL_SECONDS);
      if (signed.error || !signed.data?.signedUrl) throw signed.error || new Error('signed url ausente');
      resultUrl = signed.data.signedUrl;
      log(`☁ uploaded result to Supabase (${Date.now() - tUp}ms): ${resultPath}`);
    } catch (e) {
      logErr('⚠ falha no upload Supabase (resultado ficará disponível via /jobs/:id/result):', e?.message || e);
    }
  }

  log(`🎉 done total=${Date.now() - t0}ms`);

  updateJob(jobId, { status: 'done', outPath, sizeBytes: finalSize, resultUrl, resultPath });
}

// ---------------- censor pipeline ----------------

// Mesmos valores do frontend (src/pages/GeradorPreview.tsx — INTENSITY_BLUR).
// O preview aplica CSS `blur(blurPx)` com blurPx = round(INTENSITY_BLUR * min(W,H) / 720)
// CSS blur() é gaussiano, então usamos `gblur` no FFmpeg com sigma equivalente.
const CENSOR_BLUR_BASE = { leve: 12, medio: 24, pesado: 48 };
// Mesmos valores do frontend (INTENSITY_PIXEL).
const CENSOR_PIXEL_FACTOR = { leve: 0.012, medio: 0.025, pesado: 0.045 };

async function runCensorPipeline(jobId, videoFile, params) {
  const log = (...a) => console.log(`[job ${jobId}]`, ...a);
  const logErr = (...a) => console.error(`[job ${jobId}]`, ...a);
  const t0 = Date.now();
  const job = jobs.get(jobId);
  if (!job) throw new Error('job desapareceu');

  updateJob(jobId, { status: 'processing' });

  const region = {
    x: clamp(num(params.region?.x, 0), 0, 1),
    y: clamp(num(params.region?.y, 0), 0, 1),
    w: clamp(num(params.region?.w, 1), 0.001, 1),
    h: clamp(num(params.region?.h, 1), 0.001, 1),
  };
  const censorType = params.censorType === 'pixel' ? 'pixel' : 'blur';
  const intensity = ['leve', 'medio', 'pesado'].includes(params.intensity) ? params.intensity : 'medio';

  const videoSizeMB = (videoFile.size / 1024 / 1024).toFixed(2);
  log(`📥 censor input: video="${videoFile.originalname}" size=${videoSizeMB}MB type=${censorType} intensity=${intensity} region=${JSON.stringify(region)}`);

  const tProbe = Date.now();
  let videoInfo;
  try { videoInfo = await probeVideoInfo(videoFile.path); }
  catch (e) { throw new Error(`Falha ao analisar o vídeo: ${e.message}`); }
  const outputSize = fitDimensionsWithinBounds(videoInfo.width, videoInfo.height, 1920);
  log(`🔍 probe (${Date.now() - tProbe}ms): ${videoInfo.width}x${videoInfo.height} hasAudio=${videoInfo.hasAudio} -> ${outputSize.width}x${outputSize.height}`);

  const W = outputSize.width;
  const H = outputSize.height;
  // Coordenadas EXATAS da região, espelhando o frontend (Math.round em sw/sh).
  // FFmpeg crop/overlay aceitam offsets ímpares; só largura/altura do crop precisam ser pares
  // quando usamos overlay com formato yuv420p, então arredondamos APENAS rw/rh para par.
  let rw = makeEven(Math.max(2, Math.round(W * region.w)));
  let rh = makeEven(Math.max(2, Math.round(H * region.h)));
  let rx = Math.max(0, Math.min(W - rw, Math.round(W * region.x)));
  let ry = Math.max(0, Math.min(H - rh, Math.round(H * region.y)));
  if (rw > W) rw = makeEven(W);
  if (rh > H) rh = makeEven(H);

  let regionFilter;
  if (censorType === 'blur') {
    // CSS blur(N px) ≈ gaussian com sigma=N. Escala com a menor dimensão (mesma fórmula do preview).
    const sigma = Math.max(1, Math.round((CENSOR_BLUR_BASE[intensity] * Math.min(W, H)) / 720));
    // gblur tem limite de sigma por step ≈ 50; encadeia múltiplas passes se necessário.
    const STEP = 30;
    const passes = [];
    let remaining = sigma;
    while (remaining > 0) {
      const s = Math.min(STEP, remaining);
      passes.push(`gblur=sigma=${s}:steps=2`);
      remaining -= s;
    }
    regionFilter = passes.join(',');
  } else {
    const factor = CENSOR_PIXEL_FACTOR[intensity];
    const longer = Math.max(rw, rh);
    const blockPx = Math.max(6, Math.round(longer * factor));
    const downW = Math.max(1, Math.round(rw / blockPx));
    const downH = Math.max(1, Math.round(rh / blockPx));
    // Mesma técnica do preview: downscale (area/bilinear) + upscale com smoothing alto (lanczos)
    regionFilter = `scale=${downW}:${downH}:flags=area,scale=${rw}:${rh}:flags=lanczos`;
  }

  const filterComplex = [
    `[0:v]scale=${W}:${H}:flags=lanczos,split=2[full][rgn]`,
    `[rgn]crop=${rw}:${rh}:${rx}:${ry},${regionFilter}[censored]`,
    `[full][censored]overlay=${rx}:${ry}:format=auto[outv]`,
  ].join(';');

  const outPath = path.join(TMP_DIR, `censor_out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`);
  job.cleanupPaths.push(outPath);

  const args = ['-y', '-i', videoFile.path, '-filter_complex', filterComplex, '-map', '[outv]'];
  if (videoInfo.hasAudio) args.push('-map', '0:a:0?');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
  );
  if (videoInfo.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  else args.push('-an');
  args.push('-threads', '2', outPath);

  const tComp = Date.now();
  try {
    await runFfmpeg(args, { tag: `${jobId}/censor` });
  } catch (e) { throw new Error(`Falha ao aplicar censura: ${e.message}`); }
  const finalSize = safeSize(outPath);
  log(`✅ censor (${Date.now() - tComp}ms): ${(finalSize / 1024 / 1024).toFixed(2)}MB`);

  let resultUrl = null;
  let resultPath = null;
  if (supabaseAdmin) {
    try {
      const tUp = Date.now();
      const safeName = sanitizeName(videoFile.originalname);
      resultPath = `_censor-results/${jobId}/censored_${safeName}.mp4`;
      const fileBuffer = fs.readFileSync(outPath);
      const up = await supabaseAdmin.storage
        .from(SUPABASE_RESULT_BUCKET)
        .upload(resultPath, fileBuffer, { contentType: 'video/mp4', upsert: true });
      if (up.error) throw up.error;
      const signed = await supabaseAdmin.storage
        .from(SUPABASE_RESULT_BUCKET)
        .createSignedUrl(resultPath, SUPABASE_RESULT_TTL_SECONDS);
      if (signed.error || !signed.data?.signedUrl) throw signed.error || new Error('signed url ausente');
      resultUrl = signed.data.signedUrl;
      log(`☁ uploaded censor result to Supabase (${Date.now() - tUp}ms): ${resultPath}`);
    } catch (e) {
      logErr('⚠ falha no upload Supabase (resultado ficará disponível via /jobs/:id/result):', e?.message || e);
    }
  }

  log(`🎉 censor done total=${Date.now() - t0}ms`);

  updateJob(jobId, { status: 'done', outPath, sizeBytes: finalSize, resultUrl, resultPath });
}

// ---------------- helpers ----------------

function num(v, def) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : def; }
function int(v, def) { const n = typeof v === 'number' ? Math.round(v) : parseInt(v, 10); return Number.isFinite(n) ? n : def; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function sanitizeName(name) { return (name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w.\-]/g, '_').slice(0, 80); }
function safeSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function cleanup(paths) { for (const p of paths) { if (!p) continue; fs.unlink(p, () => {}); } }

/**
 * Baixa um arquivo de uma URL (http/https) para `destPath`. Segue até 5 redirects.
 * Aborta se o tamanho exceder `maxBytes`. Retorna o número de bytes salvos.
 */
function downloadToFile(url, destPath, maxBytes, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`URL inválida: ${url}`)); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(parsed, (res) => {
      // redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Excesso de redirects'));
        const next = new URL(res.headers.location, parsed).toString();
        return resolve(downloadToFile(next, destPath, maxBytes, redirectsLeft - 1));
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Download HTTP ${res.statusCode} em ${parsed.hostname}`));
      }
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      if (contentLength && contentLength > maxBytes) {
        res.resume();
        return reject(new Error(`Arquivo excede limite (${(contentLength / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`));
      }
      let bytes = 0;
      const ws = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          ws.destroy();
          res.destroy();
          fs.unlink(destPath, () => {});
          reject(new Error(`Arquivo excedeu ${(maxBytes / 1024 / 1024).toFixed(0)}MB durante download`));
        }
      });
      res.pipe(ws);
      ws.on('finish', () => resolve(bytes));
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => { req.destroy(new Error('Download timeout (120s)')); });
  });
}

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
