const URL_REGEX = /(https?:\/\/[^\s]+)/i;

function extractUrl(text) {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  return match ? match[1] : null;
}

module.exports = { extractUrl };
