require('dotenv').config();
const path = require('path');

// Parses a numeric env var, falling back to `fallback` for anything that isn't a finite
// number above `min` (unset, empty, non-numeric, zero/negative where that would break
// invariants elsewhere -- e.g. MAX_CONCURRENT_JOBS=0 would silently deadlock the queue).
// Warns instead of failing outright, since a bad value is almost always a typo, not intent.
function numEnv(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.warn(`Ignoring invalid ${name}=${JSON.stringify(raw)} (expected a number >= ${min}); using ${fallback}.`);
    return fallback;
  }
  return value;
}

const config = {
  // --- Core app (dashboard) ---
  // Overall size ceiling we'll compress/download a video down to.
  maxMediaBytes: numEnv('MAX_MEDIA_MB', 100, { min: 1 }) * 1024 * 1024,
  targetHeight: numEnv('TARGET_HEIGHT', 720, { min: 144 }),
  downloadDir: path.resolve(process.cwd(), process.env.DOWNLOAD_DIR || 'downloads'),
  fileTtlMs: numEnv('FILE_TTL_MINUTES', 60, { min: 1 }) * 60 * 1000,
  port: numEnv('PORT', 3000, { min: 1 }),
  // Netscape-format cookies.txt content, base64-encoded, exported from a logged-in browser.
  // This lets yt-dlp fetch content that requires being logged in (most LinkedIn videos,
  // some Instagram/Facebook/X posts, age-gated YouTube videos). See README for how to export.
  cookiesBase64: process.env.COOKIES_BASE64 || null,
  // Path to an existing cookies.txt on disk (alternative to COOKIES_BASE64).
  cookiesFile: process.env.COOKIES_FILE || null,
  impersonateBrowser: process.env.IMPERSONATE_BROWSER !== 'false',
  downloadRetries: numEnv('DOWNLOAD_RETRIES', 2, { min: 0 }),
  // Must be at least 1 -- 0 would make the queue's `running >= max` check permanently
  // true, so nothing would ever be dequeued and every job would sit "queued" forever.
  maxConcurrentJobs: numEnv('MAX_CONCURRENT_JOBS', 1, { min: 1 }),

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
  dashboardHistoryMs: numEnv('DASHBOARD_HISTORY_DAYS', 7, { min: 1 }) * 24 * 60 * 60 * 1000,
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || 'data'),

  // GIF export: max clip length allowed in one GIF (longer clips + high fps get huge fast).
  gifMaxDurationSeconds: numEnv('GIF_MAX_DURATION_SECONDS', 15, { min: 1 }),

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
  inlineVideoBytes: numEnv('WHATSAPP_INLINE_VIDEO_MB', 16, { min: 1 }) * 1024 * 1024,
  validateTwilioSignature: process.env.VALIDATE_TWILIO_SIGNATURE !== 'false',
  dedupeTtlMs: numEnv('DEDUPE_TTL_MINUTES', 30, { min: 1 }) * 60 * 1000,
};

if (config.whatsappEnabled && !config.publicBaseUrl) {
  console.warn(
    'WhatsApp (Part 2) is configured but PUBLIC_BASE_URL is not set -- Twilio will not be ' +
      'able to fetch media from a relative URL, so video delivery will fail. Set PUBLIC_BASE_URL ' +
      'to this deployment\'s public HTTPS domain.'
  );
}

module.exports = config;
