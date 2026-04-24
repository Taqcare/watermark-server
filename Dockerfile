FROM node:20-slim

# Instala FFmpeg nativo
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala deps primeiro (melhor cache)
COPY package.json ./
RUN npm install --omit=dev

# Copia código
COPY src ./src

# Pasta temp para uploads
RUN mkdir -p /tmp/watermark && chmod 777 /tmp/watermark

ENV NODE_ENV=production
ENV PORT=8080
ENV TMP_DIR=/tmp/watermark

EXPOSE 8080

CMD ["node", "src/index.js"]
