const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

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

/**
 * Downloads the highest-quality available video+audio for a URL, merged to mp4,
 * using yt-dlp. Works across YouTube, TikTok, X/Twitter, Instagram, Reddit,
 * Facebook, and (when public) LinkedIn -- support depends on yt-dlp's extractors.
 */
async function downloadVideo(url, jobId) {
  await fs.mkdir(config.downloadDir, { recursive: true });
  const outputTemplate = path.join(config.downloadDir, `${jobId}.%(ext)s`);

  await run('yt-dlp', [
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '-f',
    'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '-o',
    outputTemplate,
    url,
  ]);

  const finalPath = path.join(config.downloadDir, `${jobId}.mp4`);
  await fs.access(finalPath);
  return finalPath;
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
 * Re-encodes a video to fit under maxBytes by targeting a computed bitrate.
 * Falls back to progressively lower resolutions if a single bitrate pass
 * still doesn't land under the target (very short/high-motion clips).
 */
async function compressToFit(inputPath, maxBytes, jobId) {
  const duration = await getDuration(inputPath);
  if (!duration) {
    throw new Error('Could not determine video duration for compression');
  }

  const audioBitrateKbps = 96;
  const resolutions = [null, 720, 480, 360]; // null = keep original resolution

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
