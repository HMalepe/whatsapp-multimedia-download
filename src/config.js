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
};

module.exports = config;
