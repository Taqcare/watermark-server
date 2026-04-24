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

      const args = buildFfmpegArgs({
        videoPath: videoFile.path,
        overlayPath: overlayFile ? overlayFile.path : null,
        outPath,
        position,
        opacity,
        paddingPct,
        maxDim,
        moving,
        movingSpeed,
        overlayWidthPct,
      });

      console.log('[ffmpeg]', args.join(' '));

      await runFfmpeg(args);

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
 * Constrói os args do ffmpeg.
 *
 * Estratégia:
 *  1. Escala o vídeo respeitando maxDim, mantendo proporção e dimensões pares.
 *  2. Se houver overlay:
 *      - opcional: redimensiona overlay com base em overlayWidthPct (em relação à largura final do vídeo).
 *      - aplica opacity via filtro `format=rgba,colorchannelmixer=aa=<opacity>`.
 *      - posiciona estaticamente OU animado (DVD-bouncing) via expressões abs/mod sobre `t`.
 *  3. Encoda em H.264 + yuv420p + AAC + +faststart.
 */
function buildFfmpegArgs(opts) {
  const {
    videoPath,
    overlayPath,
    outPath,
    position,
    opacity,
    paddingPct,
    maxDim,
    moving,
    movingSpeed,
    overlayWidthPct,
  } = opts;

  // Escala mantendo proporção; força dimensões pares (encoder x264 exige).
  // Usa min(iw, maxDim) na maior dimensão para não upscalar.
  const scaleFilter = `scale='if(gt(iw,ih),min(${maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${maxDim},ih))':flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2`;

  const filterParts = [];
  // Vídeo base
  filterParts.push(`[0:v]${scaleFilter}[base]`);

  if (overlayPath) {
    // 1) prepara overlay: resize opcional + opacity
    const overlayChain = [];
    if (overlayWidthPct != null) {
      // Largura do overlay = overlayWidthPct% da largura do base
      // Usamos `scale2ref` para referenciar o tamanho do base
      // Mas é mais simples: usamos `scale=W*pct:-1` referenciando main_w via overlay's filter.
      // Como `scale` no overlay não tem main_w, fazemos via scale com expressão de tamanho fixo
      // baseado no maxDim — não ideal. Solução: usar `scale2ref`.
    }
    // Aplica opacity sempre (mesmo 1.0 é ok)
    overlayChain.push(`format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}`);

    if (overlayWidthPct != null) {
      // Usamos scale2ref para escalar o overlay relativo ao base
      // [1:v]format=rgba,colorchannelmixer=aa=...[ov0]
      // [ov0][base]scale2ref=w='iw*pct/100':h='ow/mdar'[ov][base2]
      filterParts.push(`[1:v]${overlayChain.join(',')}[ov0]`);
      filterParts.push(
        `[ov0][base]scale2ref=w='iw*${(overlayWidthPct / 100).toFixed(4)}':h='ow/mdar'[ov][base2]`,
      );
    } else {
      filterParts.push(`[1:v]${overlayChain.join(',')}[ov]`);
      // base permanece como [base]
      filterParts.push(`[base]null[base2]`);
    }

    // Posicionamento
    const { xExpr, yExpr } = overlayPositionExpr({
      position,
      paddingPct,
      moving,
      movingSpeed,
    });

    filterParts.push(`[base2][ov]overlay=x='${xExpr}':y='${yExpr}':format=auto[outv]`);
  } else {
    filterParts.push(`[base]null[outv]`);
  }

  const filterComplex = filterParts.join(';');

  const args = ['-y', '-i', videoPath];
  if (overlayPath) args.push('-i', overlayPath);

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-shortest',
    outPath,
  );

  return args;
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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        console.error('[ffmpeg] exit', code, stderr.slice(-2000));
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}
