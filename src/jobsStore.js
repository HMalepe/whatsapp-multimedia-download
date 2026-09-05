// A tiny JSON-file-backed job history so the dashboard has something to show even
// across restarts, without pulling in a database for a single-user personal tool.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_FILE = path.join(config.dataDir, 'jobs.json');

const jobs = new Map(); // id -> job
let writeTimer = null;

function load() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    for (const job of arr) jobs.set(job.id, job);
  } catch {
    // No existing file, or it's corrupt -- start with empty history rather than crash.
  }
}
load();

function writeNow() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify([...jobs.values()]));
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeNow, 250);
  writeTimer.unref();
}

// Bypasses the debounce and writes immediately. A process killed (e.g. Railway sending
// SIGTERM on a redeploy) within that 250ms window would otherwise lose whatever job/GIF
// update just happened, even though the file itself still exists on disk -- call this from
// a shutdown handler so the most recent state always makes it out.
function flush() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  writeNow();
}

function createJob(job) {
  jobs.set(job.id, job);
  persist();
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  persist();
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function listJobs() {
  return [...jobs.values()].sort((a, b) => b.requestedAt - a.requestedAt);
}

function deleteJob(id) {
  const existed = jobs.delete(id);
  if (existed) persist();
  return existed;
}

// Purges job history older than maxAgeMs, returning the removed jobs so the caller
// can also clean up their thumbnail/video files.
function purgeOlderThan(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  const removed = [];
  for (const [id, job] of jobs) {
    if (job.requestedAt < cutoff) {
      jobs.delete(id);
      removed.push(job);
    }
  }
  if (removed.length) persist();
  return removed;
}

module.exports = { createJob, updateJob, getJob, listJobs, deleteJob, purgeOlderThan, flush };
