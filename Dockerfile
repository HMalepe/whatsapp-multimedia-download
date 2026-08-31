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

RUN mkdir -p /app/downloads

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
