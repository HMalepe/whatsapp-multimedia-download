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
  maxMediaBytes: Number(process.env.MAX_MEDIA_MB || 16) * 1024 * 1024,
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
};

module.exports = config;
