const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

const timers = new Map();

function scheduleCleanup(filePath, onExpire, ttlMs = config.fileTtlMs) {
  const existing = timers.get(filePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    fs.unlink(filePath).catch(() => {});
    timers.delete(filePath);
    if (onExpire) onExpire();
  }, Math.max(0, ttlMs));
  timer.unref();
  timers.set(filePath, timer);
}

function mediaUrlFor(jobId) {
  return `${config.publicBaseUrl}/media/${jobId}.mp4`;
}

async function cleanupJobFiles(jobId) {
  const dir = config.downloadDir;
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((f) => f.startsWith(jobId))
      .map((f) => fs.unlink(path.join(dir, f)).catch(() => {}))
  );
}

module.exports = { scheduleCleanup, mediaUrlFor, cleanupJobFiles };
