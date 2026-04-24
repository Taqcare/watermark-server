/**
 * Watermark Server — serviço isolado para aplicar marca d'água em vídeos
 * via FFmpeg nativo. Garante saída sempre em MP4 (H.264 + AAC), independente
 * do navegador do cliente.
 *
 * Endpoints:
 *   GET  /health      — status simples
 *   GET  /debug       — diagnóstico do container (memória, disco, ffmpeg)
 *   POST /process     — multipart com `video`, `overlay` (PNG opcional) e `config` (JSON string)
 *                       retorna o MP4 binário (stream)
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

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'watermark-server', uptime: process.uptime() });
});

app.get('/debug', async (_req, res) => {
  try {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
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
        try {
          const s = fs.statSync(path.join(TMP_DIR, f));
          totalBytes += s.size;
        } catch {}
      }
      tmpStats = { fileCount: files.length, totalBytes };
    } catch (e) {
      tmpStats = { error: e.message };
    }

    res.json({
      ok: true,
      service: 'watermark-server',
      uptime: process.uptime(),
      node: process.version,
      pid: process.pid,
      memoryUsage: mem,
      system: {
        totalMemMB: Math.round(totalMem / 1024 / 1024),
        freeMemMB: Math.round(freeMem / 1024 / 1024),
        cpus: os.cpus().length,
        loadavg: os.loadavg(),
        platform: os.platform(),
        arch: os.arch(),
      },
      ffmpegVersion,
      tmpDir: TMP_DIR,
      tmpStats,
      maxFileMB: MAX_FILE_MB,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(
  '/process',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'overlay', maxCount: 1 },
  ]),
  async (req, res) => {
    const cleanupPaths = [];
    const reqId = crypto.randomBytes(4).toString('hex');
    const t0 = Date.now();
    const log = (...args) => console.log(`[/process ${reqId}]`, ...args);
    const logErr = (...args) => console.error(`[/process ${reqId}]`, ...args);

    try {
      const videoFile = req.files?.video?.[0];
      const overlayFile = req.files?.overlay?.[0];
      if (!videoFile) {
        return res.status(400).json({ error: 'missing video' });
      }
      cleanupPaths.push(videoFile.path);
      if (overlayFile) cleanupPaths.push(overlayFile.path);

      const videoSizeMB = (videoFile.size / 1024 / 1024).toFixed(2);
      const overlaySizeKB = overlayFile ? (overlayFile.size / 1024).toFixed(1) : null;
      log(`📥 input: video="${videoFile.originalname}" size=${videoSizeMB}MB overlay=${overlaySizeKB ? overlaySizeKB + 'KB' : 'none'}`);

      let config = {};
      try {
        config = req.body.config ? JSON.parse(req.body.config) : {};
      } catch (e) {
        return res.status(400).json({ error: 'invalid config json' });
      }
      log('config:', JSON.stringify(config));

      const position = config.position || 'center';
      const opacity = clamp(num(config.opacity, 1), 0, 1);
      const paddingPct = clamp(num(config.paddingPct, 0.02), 0, 0.5);
      const maxDim = clamp(int(config.maxDim, 1920), 360, 3840);
      const moving = !!config.moving;
      const movingSpeed = clamp(num(config.movingSpeed, 20), 1, 100);
      const overlayWidthPct =
        config.overlayWidthPct != null ? clamp(num(config.overlayWidthPct, 20), 1, 100) : null;

      // ----- ETAPA 1: PROBE -----
      const tProbe = Date.now();
      let videoInfo;
      try {
        videoInfo = await probeVideoInfo(videoFile.path);
      } catch (e) {
        logErr('❌ probe falhou:', e.message);
        throw new Error(`Falha ao analisar o vídeo de entrada: ${e.message}`);
      }
      const outputSize = fitDimensionsWithinBounds(videoInfo.width, videoInfo.height, maxDim);
      log(`🔍 probe (${Date.now() - tProbe}ms): ${videoInfo.width}x${videoInfo.height} hasAudio=${videoInfo.hasAudio} -> alvo ${outputSize.width}x${outputSize.height}`);

      // ----- ETAPA 2: PREPARE VIDEO -----
      const basePath = path.join(TMP_DIR, `base_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`);
      cleanupPaths.push(basePath);
      const tBase = Date.now();
      try {
        await runFfmpeg(
          buildScaledVideoArgs({
            inputPath: videoFile.path,
            outPath: basePath,
            width: outputSize.width,
            height: outputSize.height,
            hasAudio: videoInfo.hasAudio,
          }),
          { tag: `${reqId}/prepare-video` },
        );
      } catch (e) {
        logErr('❌ prepare-video falhou:', e.message);
        throw new Error(`Falha ao escalar vídeo base: ${e.message}`);
      }
      const baseSize = safeSize(basePath);
      log(`✅ prepare-video (${Date.now() - tBase}ms): ${(baseSize / 1024 / 1024).toFixed(2)}MB`);

      // ----- ETAPA 3: PREPARE OVERLAY (opcional) -----
      let preparedOverlayPath = null;
      if (overlayFile) {
        preparedOverlayPath = path.join(
          TMP_DIR,
          `overlay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`,
        );
        cleanupPaths.push(preparedOverlayPath);

        const overlayWidthPx =
          overlayWidthPct != null
            ? makeEven(Math.max(2, Math.round((outputSize.width * overlayWidthPct) / 100)))
            : null;

        const tOv = Date.now();
        try {
          await runFfmpeg(
            buildOverlayPrepArgs({
              inputPath: overlayFile.path,
              outPath: preparedOverlayPath,
              opacity,
              width: overlayWidthPx,
            }),
            { tag: `${reqId}/prepare-overlay` },
          );
        } catch (e) {
          logErr('❌ prepare-overlay falhou:', e.message);
          throw new Error(`Falha ao preparar overlay: ${e.message}`);
        }
        const ovSize = safeSize(preparedOverlayPath);
        log(`✅ prepare-overlay (${Date.now() - tOv}ms): ${overlayWidthPx ? overlayWidthPx + 'px' : 'native'} -> ${(ovSize / 1024).toFixed(1)}KB`);
      }

      // ----- ETAPA 4: COMPOSITE -----
      const outName = `out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`;
      const outPath = path.join(TMP_DIR, outName);
      cleanupPaths.push(outPath);

      const tComp = Date.now();
      try {
        await runFfmpeg(
          buildOverlayCompositeArgs({
            videoPath: basePath,
            overlayPath: preparedOverlayPath,
            outPath,
            position,
            paddingPct,
            moving,
            movingSpeed,
            hasAudio: videoInfo.hasAudio,
          }),
          { tag: `${reqId}/composite` },
        );
      } catch (e) {
        logErr('❌ composite falhou:', e.message);
        throw new Error(`Falha ao compor overlay no vídeo: ${e.message}`);
      }

      const finalSize = safeSize(outPath);
      log(`✅ composite (${Date.now() - tComp}ms): ${(finalSize / 1024 / 1024).toFixed(2)}MB`);
      log(`🎉 OK total=${Date.now() - t0}ms -> enviando ${(finalSize / 1024 / 1024).toFixed(2)}MB`);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="watermarked_${sanitizeName(videoFile.originalname)}.mp4"`,
      );
      res.setHeader('Content-Length', finalSize);

      const stream = fs.createReadStream(outPath);
      stream.on('end', () => cleanup(cleanupPaths));
      stream.on('error', (err) => {
        logErr('stream error', err);
        cleanup(cleanupPaths);
      });
      stream.pipe(res);
    } catch (err) {
      logErr('💥 falhou em', `${Date.now() - t0}ms:`, err?.message || err);
      cleanup(cleanupPaths);
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'internal error' });
      } else {
        try { res.end(); } catch {}
      }
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

// ---------------- helpers ----------------

function num(v, def) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : def;
}
function int(v, def) {
  const n = typeof v === 'number' ? Math.round(v) : parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function sanitizeName(name) {
  return (name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w.\-]/g, '_').slice(0, 80);
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function cleanup(paths) {
  for (const p of paths) {
    if (!p) continue;
    fs.unlink(p, () => {});
  }
}

function buildScaledVideoArgs({ inputPath, outPath, width, height, hasAudio }) {
  const args = [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
  ];
  if (hasAudio) args.push('-map', '0:a:0?');
  args.push(
    '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
  );
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push('-an');
  }
  args.push('-threads', '2', outPath);
  return args;
}

function buildOverlayPrepArgs({ inputPath, outPath, opacity, width }) {
  const filterParts = ['format=rgba', `colorchannelmixer=aa=${opacity.toFixed(3)}`];
  if (width != null) {
    filterParts.push(`scale=${width}:-2:flags=lanczos`);
  }
  return [
    '-y',
    '-i', inputPath,
    '-vf', filterParts.join(','),
    '-frames:v', '1',
    outPath,
  ];
}

function buildOverlayCompositeArgs({ videoPath, overlayPath, outPath, position, paddingPct, moving, movingSpeed, hasAudio }) {
  if (!overlayPath) {
    // Sem overlay — apenas remux
    const args = ['-y', '-i', videoPath, '-c', 'copy', '-movflags', '+faststart', outPath];
    return args;
  }

  const { xExpr, yExpr } = overlayPositionExpr({ position, paddingPct, moving, movingSpeed });
  const filterComplex = `[0:v][1:v]overlay=x='${xExpr}':y='${yExpr}':eof_action=pass:format=auto[outv]`;

  const args = [
    '-y',
    '-i', videoPath,
    '-loop', '1',
    '-i', overlayPath,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
  ];
  if (hasAudio) args.push('-map', '0:a:0?');
  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '1024',
  );
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push('-an');
  }
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

function makeEven(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

async function probeVideoInfo(videoPath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,width,height',
    '-of', 'json',
    videoPath,
  ], { silent: true });

  let data = {};
  try {
    data = JSON.parse(stdout || '{}');
  } catch {
    throw new Error('ffprobe retornou JSON inválido');
  }

  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const width = int(videoStream?.width, 0);
  const height = int(videoStream?.height, 0);
  if (!width || !height) {
    throw new Error('Não foi possível identificar as dimensões do vídeo');
  }

  return { width, height, hasAudio: !!audioStream };
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
    const xExpr = `abs(mod(t*${vx}, 2*${rangeX}) - ${rangeX})`;
    const yExpr = `abs(mod(t*${vy}, 2*${rangeY}) - ${rangeY})`;
    return { xExpr, yExpr };
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

async function runFfmpeg(args, opts = {}) {
  return runCommand('ffmpeg', args, opts);
}

function formatCommand(bin, args) {
  return [bin, ...args].join(' ');
}

/**
 * Runs a command capturing stdout/stderr.
 * - When opts.silent is true (e.g. ffprobe), stderr is buffered and only logged on failure.
 * - Otherwise, stderr is streamed line-by-line with [bin:stderr tag] prefix for real-time visibility.
 * - Detects SIGKILL explicitly and reports as probable OOM.
 */
function runCommand(bin, args, opts = {}) {
  const tag = opts.tag ? `[${bin}:${opts.tag}]` : `[${bin}]`;
  const silent = !!opts.silent;
  const t0 = Date.now();

  if (!silent) {
    console.log(`${tag} ▶ start pid=? cmd:`, formatCommand(bin, args));
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (!silent) {
      console.log(`${tag} pid=${proc.pid}`);
    }

    let stdout = '';
    let stderrBuf = '';
    let stderrLineRemainder = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderrBuf += chunk;
      // keep buffer bounded
      if (stderrBuf.length > 200_000) {
        stderrBuf = stderrBuf.slice(-100_000);
      }

      if (!silent) {
        const combined = stderrLineRemainder + chunk;
        const lines = combined.split(/\r?\n/);
        stderrLineRemainder = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            console.log(`${tag}[stderr] ${line}`);
          }
        }
      }
    });

    proc.on('error', (err) => {
      console.error(`${tag} spawn error:`, err.message);
      reject(err);
    });

    proc.on('close', (code, signal) => {
      const dur = Date.now() - t0;
      if (!silent && stderrLineRemainder.trim()) {
        console.log(`${tag}[stderr] ${stderrLineRemainder}`);
      }

      if (code === 0) {
        if (!silent) console.log(`${tag} ✅ exit=0 dur=${dur}ms`);
        resolve({ stdout, stderr: stderrBuf });
        return;
      }

      const tail = (stderrBuf || stdout).slice(-4000);
      const isOOM = signal === 'SIGKILL' || code === 137;
      console.error(`${tag} ❌ exit code=${code} signal=${signal} dur=${dur}ms`);
      if (tail) console.error(`${tag}[stderr-tail] ${tail}`);

      if (isOOM) {
        reject(new Error(
          `FFmpeg foi morto pelo SO (SIGKILL/137) após ${dur}ms — provável OOM. Aumente a memória do container no Easypanel ou reduza a resolução do vídeo. Stderr: ${tail.slice(-500) || 'sem stderr'}`,
        ));
      } else {
        reject(new Error(
          `${bin} falhou (code=${code}${signal ? `, signal=${signal}` : ''}) após ${dur}ms: ${tail || 'sem stderr'}`,
        ));
      }
    });
  });
}
