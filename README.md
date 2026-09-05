# Video Vault

Paste a video link into a private, password-protected dashboard and get the video back,
downloaded at 720p (`TARGET_HEIGHT`), preferring MP4 or MOV, always at full length — never
trimmed. Trim any downloaded video into a GIF right there in the browser. Powered by
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) under the hood, so it works with links from:

- YouTube
- TikTok
- X / Twitter
- Instagram
- Facebook (public posts/reels)
- Reddit
- LinkedIn (public video posts only — LinkedIn frequently requires login, so this is the
  least reliable of the set)

This is the MVP: **a dashboard, full stop.** WhatsApp/Twilio integration is optional —
see "Part 2" below — and off by default.

This is built for **personal use only**: the dashboard is locked behind a login you set, and
you are responsible for complying with each platform's Terms of Service and applicable
copyright law in your jurisdiction.

## How it works

1. Paste a link into the dashboard. It shows up immediately as a new card.
2. In the background, `yt-dlp` fetches video+audio at `TARGET_HEIGHT` (720p by default),
   preferring an MP4 source, then MOV, then whatever's available at that resolution (or
   lower, only if nothing at 720p exists at all), merged to `.mp4` with `ffmpeg`. The full
   video is always fetched — duration is never trimmed.
3. If the file is bigger than `MAX_MEDIA_MB` (default 100MB), it's re-encoded down (lower
   bitrate at 720p first, then progressively 480p / 360p) until it fits.
4. The card updates live: thumbnail, duration, resolution, file size, and a Download button.
   From there you can also trim it into a GIF, or delete it.
5. The raw video file is deleted automatically after `FILE_TTL_MINUTES` to save disk. Job
   history (link, thumbnail, GIFs, status) persists separately for `DASHBOARD_HISTORY_DAYS`,
   so the dashboard still shows what you downloaded even after the video file itself expires
   — you just can't re-download or re-GIF it without hitting "Re-download" first.

## Prerequisites

- A [Railway](https://railway.app/) account (or any Docker host) to run the app with a public
  HTTPS URL.

## Local setup

```bash
cp .env.example .env
# fill in DASHBOARD_USER and DASHBOARD_PASSWORD (that's the only thing required for the MVP)
npm install
```

You also need `yt-dlp` and `ffmpeg`/`ffprobe` on your PATH locally:

```bash
pip install yt-dlp
# macOS: brew install ffmpeg
# Debian/Ubuntu: sudo apt-get install ffmpeg
```

Run it:

```bash
npm start
```

Visit `http://localhost:3000` and log in with the credentials you set.

## Deploying to Railway

1. Push this repo to GitHub and create a new Railway project from it (Railway auto-detects the
   `Dockerfile`).
2. In Railway's project settings, set `DASHBOARD_USER` and `DASHBOARD_PASSWORD` (see
   `.env.example` for other optional tuning knobs — sizes, TTLs, reliability options). Leave
   `PORT` unset — Railway injects it automatically.
3. Generate a public domain for the service (Railway → Settings → Networking → Generate
   Domain).
4. Deploy. Confirm `https://<your-domain>/health` returns `{"ok":true}`, then visit
   `https://<your-domain>/` and log in.

> Note: Railway's filesystem is ephemeral per-deploy, which is fine here since downloaded
> video files are meant to be temporary (`FILE_TTL_MINUTES`); job history and GIFs persist
> separately in `DATA_DIR` for `DASHBOARD_HISTORY_DAYS` but won't survive a full redeploy on
> Railway's ephemeral disk either. For long-term keepers, download them.

## Using the dashboard

Log in (HTTP Basic Auth — your browser will prompt once and remember it for the session),
then:

- **Paste a link** into the bar at the top. It appears as a new card immediately, with a
  live "downloading…" state.
- **Click a thumbnail** to play the video in a modal — no download needed.
- **Search** by URL, filter by platform, sort by newest/oldest/largest/longest.
- **Download** the video, **Retry** a failed or expired one, or **Delete** it entirely.
- **Make a GIF**: click "🎞 GIF" on any ready video to open the editor — scrub the video,
  click "Set start" / "Set end" to mark the clip, pick fps (8–24) and width (320–640px), and
  hit "Create GIF". It uses `ffmpeg`'s two-pass palette workflow for noticeably better color
  quality than a naive one-pass GIF encode. Clips are capped at `GIF_MAX_DURATION_SECONDS`
  (default 15s) since long, high-fps GIFs get huge fast. GIFs outlive the source video's own
  TTL — they're not deleted until the whole job's history is pruned or you delete them
  yourself — so make the GIF before the raw video expires, then keep it as long as you like.

Job history and thumbnails/GIFs live in `DATA_DIR`/`DOWNLOAD_DIR` and are pruned automatically
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

- **Long videos have a real ceiling.** If a video still can't fit under `MAX_MEDIA_MB` even
  at 360p, the download fails outright — that's the genuine ceiling for very long or
  high-motion content.
- **Genuinely private/login-only content still won't work**, even with cookies and
  impersonation configured (see "Improving reliability" above) — e.g. someone else's private
  LinkedIn post, a deleted video, or a region-locked one your account can't see either.
- **Bounded concurrency**: at most `MAX_CONCURRENT_JOBS` (default 1) downloads run at once;
  anything beyond that queues in-memory and processes in order. This is built for personal,
  occasional use, not for parallelizing many simultaneous downloads.
- **Security**: the whole app (dashboard, media/thumbnail/GIF serving, the API) is gated
  behind HTTP Basic Auth once `DASHBOARD_USER`/`DASHBOARD_PASSWORD` are set. It's disabled
  entirely (every route 401/404s with a message telling you to set them) until you do.

## Part 2 (optional): WhatsApp via Twilio

Everything above works with zero Twilio setup. If you also want to text a link to a WhatsApp
number and get the video back that way, set every `TWILIO_*` variable in `.env.example`'s
"Part 2" section — the `/whatsapp/webhook` route turns itself on automatically once all of
them are present, and off (404) if any are missing.

### Prerequisites

A [Twilio](https://www.twilio.com/) account with WhatsApp enabled — either the free
**WhatsApp Sandbox** (fastest to set up, good for personal use) or a provisioned WhatsApp
Business sender.

### Connecting Twilio

**Option A — WhatsApp Sandbox (quickest):**

1. In the Twilio Console, go to **Messaging → Try it out → Send a WhatsApp message** and join
   your sandbox from your phone as instructed.
2. Under **Sandbox settings**, set "When a message comes in" to:
   `https://<your-domain>/whatsapp/webhook` (method `POST`).
3. Set `TWILIO_WHATSAPP_NUMBER` to the sandbox number shown there, e.g.
   `whatsapp:+14155238886`.
4. Set `ALLOWED_WHATSAPP_NUMBERS` to your own number in the same format, e.g.
   `whatsapp:+15551234567`.
5. Set `PUBLIC_BASE_URL` to your Railway domain (Twilio needs to fetch media from an
   absolute, publicly reachable URL — this isn't needed for dashboard-only use).

**Option B — your own WhatsApp Business sender:** follow Twilio's
[WhatsApp Business sender setup](https://www.twilio.com/docs/whatsapp) to provision a
dedicated number, then point its webhook at `https://<your-domain>/whatsapp/webhook` the
same way.

### Usage

Text your Twilio WhatsApp number a message containing a link. You'll get an immediate
"downloading" reply, followed by the video itself once it's ready (usually 10–60 seconds
depending on length/platform) — or a download link if it's too large for WhatsApp's ~16MB
inline video limit (`WHATSAPP_INLINE_VIDEO_MB`, a hard platform limit this app can't raise).
It also shows up on the dashboard like any pasted link, with `from` set to the sender's
number instead of "unknown".

Repeat webhook deliveries for the same inbound message (Twilio retries if it doesn't get a
fast enough response) are recognized by `MessageSid` and ignored, so a slow response never
triggers two downloads for one link; incoming webhook requests are also verified against
Twilio's request signature (`VALIDATE_TWILIO_SIGNATURE=true` by default) to stop spoofed
requests.

## Project structure

```
src/
  server.js        Express app: dashboard, API, media/thumb/gif serving, (optional) webhook
  config.js        Environment variable loading
  dashboardAuth.js HTTP Basic Auth guarding the whole app
  security.js      Part 2: allowlist check + Twilio signature validation
  whatsapp.js      Part 2: Twilio client (send text / send media)
  downloader.js    yt-dlp download + ffmpeg compression + thumbnail/metadata + GIF export
  storage.js       Served-file URL helper + scheduled cleanup
  jobsStore.js     JSON-file-backed job history for the dashboard
  helpers.js       URL extraction + platform detection from message text
  queue.js         In-process concurrency-capped job queue
  dedupe.js        Part 2: Twilio MessageSid dedupe (ignores webhook retries)
public/
  dashboard.html   The dashboard (self-contained, no build step)
Dockerfile         Node + Python/yt-dlp + ffmpeg runtime for Railway
```
