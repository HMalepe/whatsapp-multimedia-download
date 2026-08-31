const crypto = require('crypto');
const config = require('./config');

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

// HTTP Basic Auth in front of the owner dashboard. This app otherwise runs on a public
// Railway URL, so without this anyone who finds the domain could browse your download
// history and re-download your videos.
function requireDashboardAuth(req, res, next) {
  if (!config.dashboardEnabled) {
    return res
      .status(404)
      .send('Dashboard is disabled. Set DASHBOARD_USER and DASHBOARD_PASSWORD to enable it.');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep !== -1) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (safeEqual(user, config.dashboardUser) && safeEqual(pass, config.dashboardPassword)) {
        return next();
      }
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Video Vault", charset="UTF-8"');
  res.status(401).send('Authentication required');
}

module.exports = { requireDashboardAuth };
