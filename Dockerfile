FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      ffmpeg \
      curl \
      unzip \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp needs a JS runtime to decrypt YouTube's signature ("nsig") scheme; without one,
# format extraction silently degrades and some/all formats become unavailable. Deno is the
# only runtime yt-dlp checks for by default.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Installed *after* COPY . . (rather than up with the apt-get layer above) so this layer's
# Docker cache gets invalidated -- and yt-dlp actually re-fetched at its latest version --
# on every single deploy that changes any file in the repo, not just the first build ever.
# YouTube changes its internal signature scheme often enough that a yt-dlp install left
# untouched across several deploys (Docker happily reuses a cached layer whose own
# instructions haven't changed) will start failing downloads with things like
# "HTTP Error 403: Forbidden" purely from being stale, with no code change required to
# trigger it or fix it -- just a fresh `pip install -U`.
# curl_cffi enables yt-dlp's --impersonate flag (browser TLS/HTTP fingerprinting), which
# helps get past bot-detection on X/Twitter, Instagram, etc.
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp[default,curl-cffi]

# The app creates its own downloads/ and data/ directories at startup (fs.mkdirSync with
# recursive: true in server.js / jobsStore.js), so no explicit mkdir is needed here.

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "src/server.js"]
