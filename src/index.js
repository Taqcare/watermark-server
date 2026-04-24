/**
 * Watermark Server — serviço isolado para aplicar marca d'água em vídeos
 * via FFmpeg nativo. Garante saída sempre em MP4 (H.264 + AAC), independente
 * do navegador do cliente.
 *
 * Endpoints:
 *   GET  /health      — status simples
 *   POST /process     — multipart com `video`, `overlay` (PNG opcional) e `config` (JSON string)
 *                       retorna o MP4 binário (stream)
 *
 * Sem autenticação (CORS controlado por env CORS_ORIGIN).
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

// Garante diretório temp
fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()) }));

// Multer salva em disco para evitar carregar vídeos grandes na memória
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

/**
 * POST /process
 *
 * Multipart fields:
 *   - video    (file, required)   vídeo de entrada
 *   - overlay  (file, optional)   PNG transparente já renderizado (com texto/ícones/escala aplicados)
 *   - config   (string, required) JSON com:
 *        {
 *          position: 'top-left' | 'top-center' | ... | 'center' | ... | 'bottom-right',
 *          opacity: 0..1,                 // multiplicado no overlay
 *          paddingPct: 0..0.5,            // padding como fração da largura (default 0.02)
 *          maxDim: 1920,                  // limite do lado maior do output
 *          moving: false,                 // animação DVD-bouncing
 *          movingSpeed: 20,               // 1..100 — velocidade do bounce
 *          overlayWidthPct: null | 0..100 // largura do overlay como % da largura final do vídeo (opcional)
 *        }
 */
app.post(
  '/process',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'overlay', maxCount: 1 },
  ]),
  async (req, res) => {
    const cleanupPaths = [];
    try {
      const videoFile = req.files?.video?.[0];
      const overlayFile = req.files?.overlay?.[0];
      if (!videoFile) {
        return res.status(400).json({ error: 'missing video' });
      }
      cleanupPaths.push(videoFile.path);
      if (overlayFile) cleanupPaths.push(overlayFile.path);

      let config = {};
      try {
        config = req.body.config ? JSON.parse(req.body.config) : {};
      } catch (e) {
        return res.status(400).json({ error: 'invalid config json' });
      }

      const position = config.position || 'center';
      const opacity = clamp(num(config.opacity, 1), 0, 1);
      const paddingPct = clamp(num(config.paddingPct, 0.02), 0, 0.5);
      const maxDim = clamp(int(config.maxDim, 1920), 360, 3840);
      const moving = !!config.moving;
      const movingSpeed = clamp(num(config.movingSpeed, 20), 1, 100);
      const overlayWidthPct =
        config.overlayWidthPct != null ? clamp(num(config.overlayWidthPct, 20), 1, 100) : null;

      const outName = `out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`;
      const outPath = path.join(TMP_DIR, outName);
      cleanupPaths.push(outPath);

      const videoInfo = await probeVideoDimensions(videoFile.path);
      const outputSize = fitDimensionsWithinBounds(videoInfo.width, videoInfo.height, maxDim);

      const basePath = path.join(TMP_DIR, `base_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`);
      cleanupPaths.push(basePath);

      console.log('[ffmpeg][prepare-video]', videoFile.path, '->', `${outputSize.width}x${outputSize.height}`);
      await runFfmpeg(
        buildScaledVideoArgs({
          inputPath: videoFile.path,
          outPath: basePath,
          width: outputSize.width,
          height: outputSize.height,
        }),
      );

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

        console.log(
          '[ffmpeg][prepare-overlay]',
          overlayFile.path,
          '->',
          overlayWidthPx ? `${overlayWidthPx}px` : 'native',
        );

        await runFfmpeg(
          buildOverlayPrepArgs({
            inputPath: overlayFile.path,
            outPath: preparedOverlayPath,
            opacity,
            width: overlayWidthPx,
          }),
        );
      }

      await runFfmpeg(
        buildOverlayCompositeArgs({
          videoPath: basePath,
          overlayPath: preparedOverlayPath,
          outPath,
          position,
          paddingPct,
          moving,
          movingSpeed,
        }),
      );

      // Stream do MP4 final
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="watermarked_${sanitizeName(videoFile.originalname)}.mp4"`,
      );

      const stat = fs.statSync(outPath);
      res.setHeader('Content-Length', stat.size);

      const stream = fs.createReadStream(outPath);
      stream.on('end', () => cleanup(cleanupPaths));
      stream.on('error', (err) => {
        console.error('stream error', err);
        cleanup(cleanupPaths);
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[/process] erro', err);
      cleanup(cleanupPaths);
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'internal error' });
      } else {
        try { res.end(); } catch {}
      }
    }
  },
);

// Multer error handler (e.g. file too large)
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
  console.log(`[watermark-server] up on :${PORT} | tmp=${TMP_DIR} | maxMB=${MAX_FILE_MB}`);
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

function cleanup(paths) {
  for (const p of paths) {
    if (!p) continue;
    fs.unlink(p, () => {});
  }
}

/**
 * Monta um pipeline mais robusto em múltiplas etapas para reduzir o risco
 * de crash em filtros complexos do FFmpeg dentro do container.
 */
function buildScaledVideoArgs({ inputPath, outPath, width, height }) {
  return [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', `scale=${width}:${height}:flags=lanczos`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-threads', '2',
    outPath,
  ];
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

function buildOverlayCompositeArgs({ videoPath, overlayPath, outPath, position, paddingPct, moving, movingSpeed }) {
  if (!overlayPath) {
    return ['-y', '-i', videoPath, '-c', 'copy', outPath];
  }

  const { xExpr, yExpr } = overlayPositionExpr({ position, paddingPct, moving, movingSpeed });
  const filterComplex = `[0:v][1:v]overlay=x='${xExpr}':y='${yExpr}':eof_action=pass:format=auto[outv]`;

  return [
    '-y',
    '-i', videoPath,
    '-loop', '1',
    '-i', overlayPath,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'copy',
    '-shortest',
    '-threads', '2',
    outPath,
  ];
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

async function probeVideoDimensions(videoPath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    videoPath,
  ]);

  let data = {};
  try {
    data = JSON.parse(stdout || '{}');
  } catch {
    throw new Error('ffprobe retornou JSON inválido');
  }

  const stream = data?.streams?.[0];
  const width = int(stream?.width, 0);
  const height = int(stream?.height, 0);
  if (!width || !height) {
    throw new Error('Não foi possível identificar as dimensões do vídeo');
  }

  return { width, height };
}

/**
 * Calcula expressões `x` e `y` para o filtro overlay.
 *
 * Variáveis disponíveis no overlay do ffmpeg:
 *   main_w, main_h — dimensões do vídeo base
 *   overlay_w, overlay_h — dimensões do overlay (após scale)
 *   t — tempo em segundos
 *
 * Modo estático: posição fixa baseada em `position` + `paddingPct`.
 * Modo movimento: bounce tipo DVD usando abs(mod(...)) — produz movimento triangular suave.
 */
function overlayPositionExpr({ position, paddingPct, moving, movingSpeed }) {
  const padW = `(main_w*${paddingPct.toFixed(4)})`;
  const padH = `(main_h*${paddingPct.toFixed(4)})`;
  const maxX = `(main_w-overlay_w-${padW})`;
  const maxY = `(main_h-overlay_h-${padH})`;

  if (moving) {
    // velocidades em px/s — proporcionais a movingSpeed e ao tamanho do vídeo
    // movingSpeed=20 => ~ 80px/s em vídeo de 1080p
    const vx = (4 * movingSpeed).toFixed(2); // px/s
    const vy = (3 * movingSpeed).toFixed(2);
    // Bounce triangular: abs(((t*v) mod (2*range)) - range)
    const rangeX = `(main_w-overlay_w)`;
    const rangeY = `(main_h-overlay_h)`;
    const xExpr = `abs(mod(t*${vx}, 2*${rangeX}) - ${rangeX})`;
    const yExpr = `abs(mod(t*${vy}, 2*${rangeY}) - ${rangeY})`;
    return { xExpr, yExpr };
  }

  // Estático
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

async function runFfmpeg(args) {
  console.log('[ffmpeg]', formatCommand('ffmpeg', args));
  return runCommand('ffmpeg', args);
}

function formatCommand(bin, args) {
  return [bin, ...args].join(' ');
}

function runCommand(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const tail = (stderr || stdout).slice(-4000);
      console.error(`[${bin}] exit`, code, signal, tail);
      reject(
        new Error(
          `${bin} falhou${code != null ? ` com código ${code}` : ''}${signal ? ` (signal ${signal})` : ''}: ${tail || 'sem stderr'}`,
        ),
      );
    });
  });
}
