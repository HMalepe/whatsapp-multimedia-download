const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

async function sendText(to, body) {
  return client.messages.create({
    from: config.twilioWhatsAppNumber,
    to,
    body,
  });
}

async function sendMedia(to, body, mediaUrl) {
  return client.messages.create({
    from: config.twilioWhatsAppNumber,
    to,
    body,
    mediaUrl: [mediaUrl],
  });
}

module.exports = { client, sendText, sendMedia };
