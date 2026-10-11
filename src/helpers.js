const URL_REGEX = /(https?:\/\/[^\s]+)/i;
// Trailing characters that are almost always sentence punctuation rather than part of the
// URL itself (e.g. "check this out: https://youtu.be/abc123!" or trailing ")" from "(link)").
const TRAILING_PUNCTUATION = /[.,!?)\]}'"]+$/;

function extractUrl(text) {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  return match ? match[1].replace(TRAILING_PUNCTUATION, '') : null;
}

const PLATFORMS = [
  { key: 'youtube', label: 'YouTube', color: '#ff0033', host: /(^|\.)(youtube\.com|youtu\.be)$/i },
  { key: 'tiktok', label: 'TikTok', color: '#25f4ee', host: /(^|\.)tiktok\.com$/i },
  { key: 'twitter', label: 'X', color: '#e7e9ea', host: /(^|\.)(twitter\.com|x\.com)$/i },
  { key: 'instagram', label: 'Instagram', color: '#e1306c', host: /(^|\.)instagram\.com$/i },
  { key: 'facebook', label: 'Facebook', color: '#1877f2', host: /(^|\.)(facebook\.com|fb\.watch)$/i },
  { key: 'reddit', label: 'Reddit', color: '#ff4500', host: /(^|\.)(reddit\.com|redd\.it)$/i },
  { key: 'linkedin', label: 'LinkedIn', color: '#0a66c2', host: /(^|\.)linkedin\.com$/i },
];

function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname;
    const match = PLATFORMS.find((p) => p.host.test(hostname));
    if (match) return { key: match.key, label: match.label, color: match.color };
  } catch {
    // Malformed URL -- fall through to "other".
  }
  return { key: 'other', label: 'Other', color: '#8b8fa3' };
}

module.exports = { extractUrl, detectPlatform };
