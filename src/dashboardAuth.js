const crypto = require('crypto');
const config = require('./config');

const COOKIE_NAME = 'vv_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Pad to equal length before comparing so the length itself doesn't leak via timing;
  // timingSafeEqual requires equal-length buffers.
  const len = Math.max(bufA.length, bufB.length, 1);
  const paddedA = Buffer.alloc(len);
  const paddedB = Buffer.alloc(len);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

// Derived from the configured credentials rather than a separately-generated and stored
// secret -- no extra file/env var to manage, and changing the password naturally
// invalidates every existing session.
function sessionSecret() {
  return crypto
    .createHash('sha256')
    .update(`${config.dashboardUser || ''}:${config.dashboardPassword || ''}`)
    .digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

function createSessionToken() {
  const payload = String(Date.now() + SESSION_MAX_AGE_MS); // embedded expiry
  return `${payload}.${sign(payload)}`;
}

function isValidSessionToken(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(sign(payload), signature)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res) {
  const token = createSessionToken();
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
  ];
  // Secure requires HTTPS; Railway terminates TLS in front of the app, but a local
  // `npm start` over plain http wouldn't be able to set/send a Secure cookie at all.
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
}

// Very light brute-force guard on the login form itself: a handful of wrong passwords
// from the same IP within a window locks that IP out briefly. Not meant to withstand a
// determined distributed attacker -- just to stop naive automated guessing against a
// personal, publicly-reachable login page.
const loginAttempts = new Map(); // ip -> { count, windowStart }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function isLockedOut(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: Date.now() });
  } else {
    entry.count++;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

function checkCredentials(username, password) {
  return (
    typeof username === 'string' &&
    typeof password === 'string' &&
    safeEqual(username, config.dashboardUser) &&
    safeEqual(password, config.dashboardPassword)
  );
}

// Gates the whole app behind a login. Without this, the app's public Railway URL would
// let anyone browse the download history and re-download videos. Session-cookie based
// (rather than HTTP Basic Auth) so it works properly with mobile browsers -- Basic Auth's
// native OS popup has no autocomplete/autofill support and, on iOS Safari specifically, the
// username field can get auto-capitalized, silently breaking a case-sensitive login with no
// useful error, just a re-prompt loop.
function requireDashboardAuth(req, res, next) {
  if (!config.dashboardEnabled) {
    return res
      .status(404)
      .send('Dashboard is disabled. Set DASHBOARD_USER and DASHBOARD_PASSWORD to enable it.');
  }

  const cookies = parseCookies(req.headers.cookie);
  if (isValidSessionToken(cookies[COOKIE_NAME])) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  if (req.path === '/' || req.path === '/dashboard') {
    return res.redirect('/login');
  }
  // /media, /thumbs, /gifs -- there's nothing sensible to redirect an <img>/<video> tag to.
  return res.status(401).send('Not signed in.');
}

module.exports = {
  requireDashboardAuth,
  checkCredentials,
  setSessionCookie,
  clearSessionCookie,
  isLockedOut,
  recordFailedAttempt,
  clearAttempts,
};
