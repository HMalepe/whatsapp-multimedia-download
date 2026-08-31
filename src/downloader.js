const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const config = require('./config');

// Resolve a cookies.txt to hand yt-dlp, if one was configured. Using cookies from a
// logged-in browser session is what actually gets sites like LinkedIn, Instagram and
// X/Twitter to serve content that anonymous requests get blocked or rate-limited on.
function resolveCookiesFile() {
  if (config.cookiesFile) return config.cookiesFile;
  if (config.cookiesBase64) {
    fsSync.mkdirSync(config.downloadDir, { recursive: true });
    const cookiesPath = path.join(config.downloadDir, 'cookies.txt');
    fsSync.writeFileSync(cookiesPath, Buffer.from(config.cookiesBase64, 'base64'));
    return cookiesPath;
  }
  return null;
}

const cookiesFilePath = resolveCookiesFile();

// Errors that retrying won't fix -- fail fast on these instead of burning retries.
const NON_RETRYABLE_PATTERNS = [
  /unsupported url/i,
  /private video/i,
  /video unavailable/i,
  /this (post|video|content) (is|has been) (private|removed|unavailable)/i,
  /requires? (a )?login/i,
  /sign in to confirm/i,
  /copyright/i,
  /no video formats found/i,
  /unable to extract/i,
];

function isRetryable(err) {
  const msg = err.message || '';
  return !NON_RETRYABLE_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

// Always targets `config.targetHeight` (720p by default) rather than the absolute
// best available: mp4 first, then mov, then any container at that resolution, and
// only drops below that resolution as a last resort if nothing at 720p exists at
// all. Never trims duration -- full-length video is always requested; only
// resolution/bitrate are ever traded down to hit a size target.
function buildFormatSelector() {
  const h = config.targetHeight;
  return [
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
    `best[height<=${h}][ext=mp4]`,
    `bestvideo[height<=${h}][ext=mov]+bestaudio[ext=m4a]`,
    `best[height<=${h}][ext=mov]`,
    `bestvideo[height<=${h}]+bestaudio`,
    `best[height<=${h}]`,
    'best',
  ].join('/');
}

function buildYtDlpArgs(url, outputTemplate) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '-f',
    buildFormatSelector(),
    '--merge-output-format',
    'mp4',
  ];

  if (cookiesFilePath) {
    args.push('--cookies', cookiesFilePath);
  }
  if (config.impersonateBrowser) {
    // Mimics a real browser's TLS/HTTP fingerprint, which helps get past the
    // bot-detection that X/Twitter, Instagram and others apply to plain requests.
    // Requires the curl_cffi Python package (installed in the Dockerfile); yt-dlp
    // silently ignores this if that dependency isn't available.
    args.push('--impersonate', 'chrome');
  }

  args.push('-o', outputTemplate, url);
  return args;
}

/**
 * Downloads the highest-quality available video+audio for a URL, merged to mp4,
 * using yt-dlp. Works across YouTube, TikTok, X/Twitter, Instagram, Reddit,
 * Facebook, and (when public, or with cookies configured) LinkedIn -- support
 * depends on yt-dlp's extractors. Retries transient failures (network hiccups,
 * rate limiting) with a short backoff; login/removed/unsupported errors fail fast.
 */
async function downloadVideo(url, jobId) {
  await fs.mkdir(config.downloadDir, { recursive: true });
  const outputTemplate = path.join(config.downloadDir, `${jobId}.%(ext)s`);
  const args = buildYtDlpArgs(url, outputTemplate);

  const maxAttempts = Math.max(1, config.downloadRetries + 1);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await run('yt-dlp', args);
      const finalPath = path.join(config.downloadDir, `${jobId}.mp4`);
      await fs.access(finalPath);
      return finalPath;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryable(err)) {
        await sleep(1500 * attempt);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

async function getDuration(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Re-encodes a video to fit under maxBytes by targeting a computed bitrate, at
 * config.targetHeight (720p by default) -- never above it, since the source was
 * already downloaded at that resolution. Full duration is always preserved; only
 * resolution/bitrate step down (720p -> 480p -> 360p) if a single bitrate pass at
 * 720p still doesn't land under the target (very long or high-motion video).
 */
async function compressToFit(inputPath, maxBytes, jobId) {
  const duration = await getDuration(inputPath);
  if (!duration) {
    throw new Error('Could not determine video duration for compression');
  }

  const audioBitrateKbps = 96;
  const resolutions = [config.targetHeight, 480, 360].filter(
    (h, i, arr) => arr.indexOf(h) === i && h <= config.targetHeight
  );

  for (const height of resolutions) {
    const targetTotalKbps = (maxBytes * 8) / duration / 1000;
    const videoBitrateKbps = Math.max(150, Math.floor(targetTotalKbps * 0.92 - audioBitrateKbps));
    const outPath = path.join(config.downloadDir, `${jobId}_c${height || 'orig'}.mp4`);

    const args = [
      '-y',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-b:v',
      `${videoBitrateKbps}k`,
      '-maxrate',
      `${Math.floor(videoBitrateKbps * 1.2)}k`,
      '-bufsize',
      `${videoBitrateKbps * 2}k`,
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-b:a',
      `${audioBitrateKbps}k`,
    ];
    if (height) {
      args.push('-vf', `scale=-2:${height}`);
    }
    args.push(outPath);

    await run('ffmpeg', args, { timeoutMs: 15 * 60 * 1000 });

    const { size } = await fs.stat(outPath);
    if (size <= maxBytes) {
      return outPath;
    }
    await fs.unlink(outPath).catch(() => {});
  }

  throw new Error('Unable to compress video under the WhatsApp size limit');
}

module.exports = { downloadVideo, compressToFit, getDuration };
