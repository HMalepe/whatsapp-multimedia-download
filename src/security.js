const twilio = require('twilio');
const config = require('./config');

function isAllowedNumber(from) {
  if (config.allowedNumbers.length === 0) return false;
  return config.allowedNumbers.includes(from);
}

function validateTwilioSignature(req, res, next) {
  if (!config.validateTwilioSignature) return next();

  const signature = req.headers['x-twilio-signature'];
  const fullUrl = `${config.publicBaseUrl}${req.originalUrl}`;

  const valid = twilio.validateRequest(config.twilioAuthToken, signature, fullUrl, req.body);

  if (!valid) {
    return res.status(403).send('Invalid Twilio signature');
  }
  next();
}

module.exports = { isAllowedNumber, validateTwilioSignature };
