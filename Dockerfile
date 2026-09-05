FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      ffmpeg \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# curl_cffi enables yt-dlp's --impersonate flag (browser TLS/HTTP fingerprinting),
# which helps get past bot-detection on X/Twitter, Instagram, etc.
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp[default,curl-cffi]

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# The app creates its own downloads/ and data/ directories at startup (fs.mkdirSync with
# recursive: true in server.js / jobsStore.js), so no explicit mkdir is needed here.

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "src/server.js"]
