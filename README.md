# whatsapp-multimedia-download

Send a video link over WhatsApp to your own Twilio number and get the video sent back,
downloaded at 720p (`TARGET_HEIGHT`), preferring MP4 or MOV, always at full length — never
trimmed. Powered by [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) under the hood, so it works
with links from:

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
   then in the background runs `yt-dlp` to fetch video+audio at `TARGET_HEIGHT` (720p by
   default), preferring an MP4 source, then MOV, then whatever's available at that
   resolution (or lower, only if nothing at 720p exists at all), merged to `.mp4` with
   `ffmpeg`. The full video is always fetched — duration is never trimmed.
4. If the file is bigger than `MAX_MEDIA_MB` (default 100MB), it's re-encoded down (lower
   bitrate at 720p first, then progressively 480p / 360p) until it fits — duration still
   isn't touched, only bitrate/resolution trade down.
5. The app serves the final file from `/media/:id.mp4` on its own public URL. If it's small
   enough for WhatsApp to play inline (`WHATSAPP_INLINE_VIDEO_MB`, default 16MB — WhatsApp's
   own hard limit, not something this app can raise), it's sent as a normal video message.
   Otherwise you get a text reply with a direct link to download it from that URL instead,
   since WhatsApp would reject an inline video message above that size.
6. Files are deleted automatically after `FILE_TTL_MINUTES`. Job history (link, thumbnail,
   status, size, error) persists separately for `DASHBOARD_HISTORY_DAYS`, so the dashboard
   still shows what you downloaded even after the video file itself has expired.

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
   `ALLOWED_WHATSAPP_NUMBERS`, `MAX_MEDIA_MB`, `FILE_TTL_MINUTES`, and `DASHBOARD_USER`
   / `DASHBOARD_PASSWORD` if you want the owner dashboard). Leave `PORT` unset — Railway
   injects it automatically.
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

## Owner dashboard

Visit `https://<your-domain>/dashboard` for a private page listing every video you've ever
sent to the bot — thumbnails, live status, search, platform filters, and one-click
retry/delete. It's disabled (404) until you set both `DASHBOARD_USER` and
`DASHBOARD_PASSWORD`, since this app otherwise sits on a public Railway URL and the dashboard
shows your download history; once set, the whole `/dashboard` and `/thumbs` surface is
gated behind HTTP Basic Auth (your browser will prompt for the credentials once and remember
them for the session).

What you get:
- **Live cards** for every job — a shimmering "downloading…" state with an elapsed timer,
  then a thumbnail (grabbed ~10% into the clip so it's not just a black intro frame), duration
  badge, resolution, file size, and a color-coded platform tag. The page polls every 3
  seconds and toasts you when a video finishes or fails.
- **Click a thumbnail** to play the video right there in a modal, no download needed.
- **Search** by URL, filter by platform, sort by newest/oldest/largest/longest.
- **Retry** re-queues the same link as a new job — handy for a failed download or one whose
  video file has since expired (the thumbnail and metadata stick around, grayed out, as a
  history record — only the raw video is deleted on `FILE_TTL_MINUTES`).
- **Delete** removes a job's file, thumbnail, and history entry for good.

Job history and thumbnails live in `DATA_DIR`/`DOWNLOAD_DIR` and are pruned automatically
after `DASHBOARD_HISTORY_DAYS` (default 7) so they don't grow forever.

## Improving reliability

Most download failures aren't missing `yt-dlp` support — they're login walls or
bot-detection. Two things close most of that gap:

1. **Cookies from a logged-in browser session.** This is the biggest lever, especially for
   LinkedIn, and it also helps Instagram, Facebook, and X for content that's rate-limited or
   gated for anonymous requests:
   - Install a browser extension like "Get cookies.txt LOCALLY" (Chrome/Firefox).
   - Log into linkedin.com / instagram.com / x.com / facebook.com in that browser.
   - Export cookies for each site into one combined `cookies.txt` (Netscape format).
   - Base64-encode it and set it as `COOKIES_BASE64` in your environment:
     `base64 -w0 cookies.txt` (macOS: `base64 -i cookies.txt`).
   - The app decodes it to a file at startup and passes it to every `yt-dlp` call.
   - Since these are *your own* session cookies giving the bot access to *your own* logged-in
     view, treat `COOKIES_BASE64` as a secret — only set it via Railway's environment
     variables, never commit it. Re-export periodically, as sites expire login sessions.

2. **Browser impersonation** (`IMPERSONATE_BROWSER=true`, on by default) makes `yt-dlp` mimic
   a real browser's TLS/HTTP fingerprint via `curl_cffi`, which helps get past bot-detection
   on X/Twitter and others even without cookies.

The app also **automatically retries** transient failures (network errors, rate limiting)
with a short backoff (`DOWNLOAD_RETRIES`, default 2 extra attempts), while failing fast on
errors that a retry can't fix (private/removed content, login-required, unsupported URL).

Even with both of these, expect occasional failures: a platform can still rate-limit or
block a given request, and any post that's been deleted, made private, or is genuinely
login-only (e.g. someone else's private LinkedIn post) will never be fetchable. Also keep
`yt-dlp` itself current — platforms change their sites often and extraction breaks until
`yt-dlp` is updated; rebuild the Docker image periodically to pick up the latest `yt-dlp`
release (the Dockerfile already installs with `-U`, so a fresh build pulls the latest).

## Limitations

- **WhatsApp's ~16MB inline video cap is a hard platform limit**, not something this app can
  raise. Videos under it play inline in the chat; videos over it (up to `MAX_MEDIA_MB`,
  default 100MB) are sent as a download link instead, since WhatsApp would reject them as a
  video message. Very long videos that still can't fit under `MAX_MEDIA_MB` even at 360p will
  fail outright — that's the genuine ceiling for very long/high-motion content.
- **Genuinely private/login-only content still won't work**, even with cookies and
  impersonation configured (see "Improving reliability" above) — e.g. someone else's private
  LinkedIn post, a deleted video, or a region-locked one your account can't see either.
- **Bounded concurrency**: at most `MAX_CONCURRENT_JOBS` (default 1) downloads run at once;
  anything beyond that queues in-memory and processes in order. This is built for personal,
  occasional use, not for parallelizing many simultaneous downloads.
- **Duplicate-safe**: repeat webhook deliveries for the same inbound message (Twilio retries
  if it doesn't get a fast enough response) are recognized by `MessageSid` and ignored, so a
  slow response never triggers two downloads for one link.
- **Security**: only numbers listed in `ALLOWED_WHATSAPP_NUMBERS` can trigger downloads, and
  incoming webhook requests are verified against Twilio's request signature
  (`VALIDATE_TWILIO_SIGNATURE=true` by default) to stop spoofed requests.

## Project structure

```
src/
  server.js        Express app: webhook, media/thumb serving, dashboard API
  config.js        Environment variable loading/validation
  security.js      Allowlist check + Twilio signature validation
  dashboardAuth.js HTTP Basic Auth guarding /dashboard, /thumbs
  whatsapp.js      Twilio client (send text / send media)
  downloader.js    yt-dlp download + ffmpeg compression + thumbnail/metadata
  storage.js       Served-file URL helper + scheduled cleanup
  jobsStore.js     JSON-file-backed job history for the dashboard
  helpers.js       URL extraction + platform detection from message text
  queue.js         In-process concurrency-capped job queue
  dedupe.js        Twilio MessageSid dedupe (ignores webhook retries)
public/
  dashboard.html   The owner dashboard (self-contained, no build step)
Dockerfile         Node + Python/yt-dlp + ffmpeg runtime for Railway
```
