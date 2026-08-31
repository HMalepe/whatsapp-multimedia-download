require('dotenv').config();
const path = require('path');

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  twilioAccountSid: required('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: required('TWILIO_AUTH_TOKEN'),
  twilioWhatsAppNumber: required('TWILIO_WHATSAPP_NUMBER'),
  publicBaseUrl: required('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  allowedNumbers: (process.env.ALLOWED_WHATSAPP_NUMBERS || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
  // Overall ceiling we'll compress/download a video down to.
  maxMediaBytes: Number(process.env.MAX_MEDIA_MB || 100) * 1024 * 1024,
  // WhatsApp's own hard cap for a playable inline video message -- not really adjustable,
  // this is enforced by WhatsApp/Twilio, not by this app. Anything under this is sent as a
  // normal video message; anything over it (up to maxMediaBytes) is sent as a download link
  // instead, since WhatsApp will reject an inline video message above this size.
  inlineVideoBytes: Number(process.env.WHATSAPP_INLINE_VIDEO_MB || 16) * 1024 * 1024,
  targetHeight: Number(process.env.TARGET_HEIGHT || 720),
  downloadDir: path.resolve(process.cwd(), process.env.DOWNLOAD_DIR || 'downloads'),
  fileTtlMs: Number(process.env.FILE_TTL_MINUTES || 60) * 60 * 1000,
  port: Number(process.env.PORT || 3000),
  validateTwilioSignature: process.env.VALIDATE_TWILIO_SIGNATURE !== 'false',
  // Netscape-format cookies.txt content, base64-encoded, exported from a logged-in browser.
  // This lets yt-dlp fetch content that requires being logged in (most LinkedIn videos,
  // some Instagram/Facebook/X posts, age-gated YouTube videos). See README for how to export.
  cookiesBase64: process.env.COOKIES_BASE64 || null,
  // Path to an existing cookies.txt on disk (alternative to COOKIES_BASE64).
  cookiesFile: process.env.COOKIES_FILE || null,
  impersonateBrowser: process.env.IMPERSONATE_BROWSER !== 'false',
  downloadRetries: Number(process.env.DOWNLOAD_RETRIES || 2),
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS || 1),
  dedupeTtlMs: Number(process.env.DEDUPE_TTL_MINUTES || 30) * 60 * 1000,

  // Owner dashboard (/dashboard) -- a private, password-protected page listing every
  // download with thumbnails. Disabled unless both credentials are set, since this app
  // otherwise sits on a public Railway URL and the dashboard shows your download history.
  dashboardUser: process.env.DASHBOARD_USER || null,
  dashboardPassword: process.env.DASHBOARD_PASSWORD || null,
  dashboardEnabled: Boolean(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD),
  // How long job history (metadata + thumbnail) is kept after the video file itself has
  // expired and been deleted -- independent of, and longer than, FILE_TTL_MINUTES.
  dashboardHistoryMs: Number(process.env.DASHBOARD_HISTORY_DAYS || 7) * 24 * 60 * 60 * 1000,
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || 'data'),
};

module.exports = config;
