# Watermark Server

Serviço Node.js isolado que aplica marca d'água em vídeos usando **FFmpeg nativo**, garantindo saída sempre em **MP4 (H.264 + AAC)** — independente do navegador do usuário final.

Esse serviço é **totalmente independente** do `telegram-mtproto-server`. Roda em seu próprio container e tem seu próprio domínio/porta.

## Como funciona

```
Frontend (Marca D'água)
  ─ renderiza um PNG transparente do overlay (texto + ícones + escala)
  ─ POST multipart /process  (video + overlay PNG + config JSON)
       │
       ▼
Watermark Server (Node + Express)
  ─ salva uploads em disco temp
  ─ executa FFmpeg: scale + overlay (estático ou movimento DVD) + H.264/AAC + faststart
  ─ devolve MP4 binário (stream)
  ─ limpa arquivos temp
```

## Endpoints

- `GET /health` — health check
- `POST /process` — multipart síncrono (legado): `video` + `overlay` + `config` JSON
- `POST /jobs` — multipart assíncrono (mesmos campos) → `{ jobId }`
- `POST /jobs-from-url` — JSON assíncrono (Supabase signed URLs):
  ```json
  {
    "videoUrl": "https://...signed",
    "videoName": "video.mp4",
    "overlayUrl": "https://...signed-or-null",
    "config": { "position": "center", "opacity": 0.3, "moving": false }
  }
  ```
  → `{ jobId }`
- `POST /jobs-from-url-censor` — JSON assíncrono (censura blur/pixel em região retangular):
  ```json
  {
    "videoUrl": "https://...signed",
    "videoName": "video.mp4",
    "region": { "x": 0, "y": 0, "w": 1, "h": 0.5 },
    "censorType": "blur",
    "intensity": "medio"
  }
  ```
  → `{ jobId }`
- `GET /jobs/:id` — `{ status, error?, sizeBytes?, resultUrl?, resultPath?, ageMs }`
- `GET /jobs/:id/result` — baixa MP4 (fallback se Supabase não configurado)


## Variáveis de ambiente

| Var | Default | Descrição |
|---|---|---|
| `PORT` | `8080` | Porta HTTP |
| `CORS_ORIGIN` | `*` | Origens CORS permitidas (vírgula). Recomendado: `https://dash.joiasmodels.com,https://dash-joiasmodels.lovable.app` |
| `MAX_FILE_MB` | `300` | Tamanho máximo por upload |
| `TMP_DIR` | `/tmp/watermark` | Diretório temp |

## Rodar localmente

```bash
cd watermark-server
cp .env.example .env
npm install
npm run dev
```

Requer `ffmpeg` instalado (`apt-get install ffmpeg` no Linux ou `brew install ffmpeg` no Mac).

## Deploy no Easypanel

1. **Criar novo App** no Easypanel:
   - Tipo: **App from Dockerfile**
   - Source: GitHub repo (subpasta `watermark-server`) **ou** upload manual

2. **Build settings:**
   - Build context: `watermark-server/` (raiz do serviço)
   - Dockerfile: `Dockerfile`

3. **Environment variables:**
   ```
   PORT=8080
   CORS_ORIGIN=https://dash.joiasmodels.com,https://dash-joiasmodels.lovable.app
   MAX_FILE_MB=300
   ```

4. **Resources sugeridos** (vídeos grandes consomem CPU):
   - Memory: 2 GB
   - CPU: 2 vCPU
   - Disk: 10 GB (para temp)

5. **Network / Port:**
   - Internal port: `8080`
   - Domain: anexar um domínio público (ex.: `watermark.seudominio.com`) com HTTPS pelo Easypanel

6. **Health check (opcional):**
   - Path: `/health`
   - Interval: 30s

7. **Subir!** O Dockerfile já instala `ffmpeg` automaticamente.

## Configurar no frontend (Lovable)

Após o deploy, copie o domínio público e adicione no `.env` do projeto:

```
VITE_WATERMARK_API_URL=https://watermark.seudominio.com
```

Faça novo build do frontend para aplicar.

## Notas

- **Sem auth**: o endpoint é público; restrinja CORS para os domínios do app.
- **Sem persistência**: arquivos são deletados após o stream.
- **Timeout**: vídeos muito longos podem estourar o timeout do proxy do Easypanel (default ~5min). Ajuste via `Proxy timeout` se precisar processar vídeos > 100MB.
- **Saída garantida em MP4**: independente do formato de entrada (mov, mp4, webm, mkv, etc.).
