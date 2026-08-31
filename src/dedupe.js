// Twilio retries a webhook if it doesn't get a response quickly enough, which would
// otherwise trigger a duplicate download+send for the same inbound message. Track
// recently-seen MessageSids and drop repeats within a window comfortably longer than
// Twilio's retry period.
const config = require('./config');

const seen = new Map(); // MessageSid -> expiry timestamp

function isDuplicate(messageSid) {
  if (!messageSid) return false;

  const now = Date.now();
  for (const [sid, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(sid);
  }

  if (seen.has(messageSid)) return true;

  seen.set(messageSid, now + config.dedupeTtlMs);
  return false;
}

module.exports = { isDuplicate };
