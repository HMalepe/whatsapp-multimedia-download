require('dotenv').config();
const path = require('path');

const config = {
  // --- Core app (dashboard) ---
  // Overall size ceiling we'll compress/download a video down to.
  maxMediaBytes: Number(process.env.MAX_MEDIA_MB || 100) * 1024 * 1024,
  targetHeight: Number(process.env.TARGET_HEIGHT || 720),
  downloadDir: path.resolve(process.cwd(), process.env.DOWNLOAD_DIR || 'downloads'),
  fileTtlMs: Number(process.env.FILE_TTL_MINUTES || 60) * 60 * 1000,
  port: Number(process.env.PORT || 3000),
  // Netscape-format cookies.txt content, base64-encoded, exported from a logged-in browser.
  // This lets yt-dlp fetch content that requires being logged in (most LinkedIn videos,
  // some Instagram/Facebook/X posts, age-gated YouTube videos). See README for how to export.
  cookiesBase64: process.env.COOKIES_BASE64 || null,
  // Path to an existing cookies.txt on disk (alternative to COOKIES_BASE64).
  cookiesFile: process.env.COOKIES_FILE || null,
  impersonateBrowser: process.env.IMPERSONATE_BROWSER !== 'false',
  downloadRetries: Number(process.env.DOWNLOAD_RETRIES || 2),
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS || 1),

  // Public HTTPS base URL of this deployment (no trailing slash). Only needed for Part 2
  // (WhatsApp): Twilio has to fetch media from an absolute, publicly reachable URL. Without
  // it, the dashboard just uses relative URLs, which works fine for browser use on its own.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  // The dashboard (/) -- a private, password-protected page listing every download with
  // thumbnails. This is the whole app in its current form. Disabled (with a clear message)
  // unless both credentials are set, since this app sits on a public URL once deployed.
  dashboardUser: process.env.DASHBOARD_USER || null,
  dashboardPassword: process.env.DASHBOARD_PASSWORD || null,
  dashboardEnabled: Boolean(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD),
  // How long job history (metadata + thumbnail) is kept after the video file itself has
  // expired and been deleted -- independent of, and longer than, FILE_TTL_MINUTES.
  dashboardHistoryMs: Number(process.env.DASHBOARD_HISTORY_DAYS || 7) * 24 * 60 * 60 * 1000,
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || 'data'),

  // GIF export: max clip length allowed in one GIF (longer clips + high fps get huge fast).
  gifMaxDurationSeconds: Number(process.env.GIF_MAX_DURATION_SECONDS || 15),

  // --- Part 2: WhatsApp (optional) ---
  // All unset by default. Set every TWILIO_* var below to turn the /whatsapp/webhook route
  // on; leave any of them out and the app runs as a dashboard-only video vault.
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || null,
  twilioWhatsAppNumber: process.env.TWILIO_WHATSAPP_NUMBER || null,
  whatsappEnabled: Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_NUMBER
  ),
  allowedNumbers: (process.env.ALLOWED_WHATSAPP_NUMBERS || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
  // WhatsApp's own hard cap for a playable inline video message -- not really adjustable,
  // this is enforced by WhatsApp/Twilio, not by this app.
  inlineVideoBytes: Number(process.env.WHATSAPP_INLINE_VIDEO_MB || 16) * 1024 * 1024,
  validateTwilioSignature: process.env.VALIDATE_TWILIO_SIGNATURE !== 'false',
  dedupeTtlMs: Number(process.env.DEDUPE_TTL_MINUTES || 30) * 60 * 1000,
};

module.exports = config;
