# whatsapp-multimedia-download

Send a video link over WhatsApp to your own Twilio number and get the video sent back,
downloaded at the highest quality that will fit in a WhatsApp message. Powered by
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) under the hood, so it works with links from:

- YouTube
- TikTok
- X / Twitter
- Instagram
- Facebook (public posts/reels)
- Reddit
- LinkedIn (public video posts only — LinkedIn frequently requires login, so this is the
  least reliable of the set)

This is built for **personal use only**: a hard-coded allowlist restricts the bot to your
own WhatsApp number(s), and you are responsible for complying with each platform's Terms of
Service and applicable copyright law in your jurisdiction.

## How it works

1. You send a message containing a video link to your Twilio WhatsApp number.
2. Twilio POSTs the message to this app's `/whatsapp/webhook` endpoint.
3. The app checks the sender is on your allowlist, replies immediately with "downloading...",
   then in the background runs `yt-dlp` to fetch the best available video+audio and merges it
   to `.mp4` with `ffmpeg`.
4. If the file is bigger than WhatsApp's media limit (~16MB for video), it's re-encoded down
   (first at the original resolution with a lower bitrate, then progressively down to 720p /
   480p / 360p) until it fits.
5. The app serves the final file from `/media/:id.mp4` on its own public URL, and calls the
   Twilio API to send that URL back to you as a WhatsApp media message.
6. Files are deleted automatically after `FILE_TTL_MINUTES`.

## Prerequisites

- A [Twilio](https://www.twilio.com/) account with WhatsApp enabled — either the free
  **WhatsApp Sandbox** (fastest to set up, good for personal use) or a provisioned WhatsApp
  Business sender.
- A [Railway](https://railway.app/) account (or any Docker host) to run the app with a public
  HTTPS URL.

## Local setup

```bash
cp .env.example .env
# fill in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, ALLOWED_WHATSAPP_NUMBERS
npm install
```

You also need `yt-dlp` and `ffmpeg`/`ffprobe` on your PATH locally:

```bash
pip install yt-dlp
# macOS: brew install ffmpeg
# Debian/Ubuntu: sudo apt-get install ffmpeg
```

For local testing without a public URL, use a tunnel (e.g. `ngrok http 3000`) and set
`PUBLIC_BASE_URL` to the tunnel's HTTPS URL. You can also set
`VALIDATE_TWILIO_SIGNATURE=false` while testing with `curl` directly.

Run it:

```bash
npm start
```

## Deploying to Railway

1. Push this repo to GitHub and create a new Railway project from it (Railway auto-detects the
   `Dockerfile`).
2. In Railway's project settings, set the environment variables from `.env.example`
   (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`,
   `ALLOWED_WHATSAPP_NUMBERS`, `MAX_MEDIA_MB`, `FILE_TTL_MINUTES`). Leave `PORT` unset —
   Railway injects it automatically.
3. Generate a public domain for the service (Railway → Settings → Networking → Generate
   Domain), then set `PUBLIC_BASE_URL` to that `https://...up.railway.app` URL.
4. Deploy. Confirm `https://<your-domain>/health` returns `{"ok":true}`.

> Note: Railway's filesystem is ephemeral per-deploy, which is fine here since downloaded
> files are meant to be temporary (served once, then deleted after `FILE_TTL_MINUTES`).

## Connecting Twilio

### Option A — WhatsApp Sandbox (quickest)

1. In the Twilio Console, go to **Messaging → Try it out → Send a WhatsApp message** and join
   your sandbox from your phone as instructed.
2. Under **Sandbox settings**, set "When a message comes in" to:
   `https://<your-domain>/whatsapp/webhook` (method `POST`).
3. Set `TWILIO_WHATSAPP_NUMBER` to the sandbox number shown there, e.g.
   `whatsapp:+14155238886`.
4. Set `ALLOWED_WHATSAPP_NUMBERS` to your own number in the same format, e.g.
   `whatsapp:+15551234567`.

### Option B — Your own WhatsApp Business sender

Follow Twilio's [WhatsApp Business sender setup](https://www.twilio.com/docs/whatsapp) to
provision a dedicated number, then point its webhook at
`https://<your-domain>/whatsapp/webhook` the same way.

## Usage

Text your Twilio WhatsApp number a message containing a link, e.g.:

```
https://www.youtube.com/watch?v=...
```

You'll get an immediate "downloading" reply, followed by the video itself once it's ready
(usually 10–60 seconds depending on length/platform).

## Limitations

- **WhatsApp media size cap (~16MB for video)**: long or high-resolution videos get
  automatically compressed to fit, which trades away some quality. There's no way around this
  cap — it's enforced by WhatsApp, not this app.
- **LinkedIn / private or login-gated content**: `yt-dlp` can't fetch anything that requires
  being logged in, so private posts, age-gated content, or platforms that tighten
  anti-scraping measures may intermittently fail. When a platform changes its site and breaks
  extraction, upgrading `yt-dlp` (`pip install -U yt-dlp`) usually fixes it — consider
  updating it periodically in the Dockerfile.
- **Single-request processing**: this is built for personal, occasional use — it does not
  queue/parallelize multiple simultaneous downloads.
- **Security**: only numbers listed in `ALLOWED_WHATSAPP_NUMBERS` can trigger downloads, and
  incoming webhook requests are verified against Twilio's request signature
  (`VALIDATE_TWILIO_SIGNATURE=true` by default) to stop spoofed requests.

## Project structure

```
src/
  server.js      Express app, webhook + media serving routes
  config.js       Environment variable loading/validation
  security.js     Allowlist check + Twilio signature validation
  whatsapp.js     Twilio client (send text / send media)
  downloader.js   yt-dlp download + ffmpeg compression
  storage.js      Served-file URL helper + scheduled cleanup
  helpers.js      URL extraction from message text
Dockerfile        Node + Python/yt-dlp + ffmpeg runtime for Railway
```
