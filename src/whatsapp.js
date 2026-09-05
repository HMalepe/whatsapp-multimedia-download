const twilio = require('twilio');
const config = require('./config');

// Part 2 (WhatsApp) is optional -- don't construct the Twilio client, let alone require
// valid credentials, unless it's actually configured. Callers only reach sendText/sendMedia
// via the /whatsapp/webhook path, which itself is only registered when whatsappEnabled.
const client = config.whatsappEnabled ? twilio(config.twilioAccountSid, config.twilioAuthToken) : null;

async function sendText(to, body) {
  if (!client) throw new Error('WhatsApp is not configured (set TWILIO_* env vars to enable it).');
  return client.messages.create({
    from: config.twilioWhatsAppNumber,
    to,
    body,
  });
}

async function sendMedia(to, body, mediaUrl) {
  if (!client) throw new Error('WhatsApp is not configured (set TWILIO_* env vars to enable it).');
  return client.messages.create({
    from: config.twilioWhatsAppNumber,
    to,
    body,
    mediaUrl: [mediaUrl],
  });
}

module.exports = { client, sendText, sendMedia };
