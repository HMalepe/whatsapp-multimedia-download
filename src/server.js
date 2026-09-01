const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { MessagingResponse } = require('twilio').twiml;

const config = require('./config');
const { extractUrl, detectPlatform } = require('./helpers');
const { isAllowedNumber, validateTwilioSignature } = require('./security');
const { requireDashboardAuth } = require('./dashboardAuth');
const { downloadVideo, compressToFit, getVideoMeta, generateThumbnail } = require('./downloader');
const { scheduleCleanup, mediaUrlFor, cleanupJobFiles } = require('./storage');
const { sendText, sendMedia } = require('./whatsapp');
const { isDuplicate } = require('./dedupe');
const { enqueue } = require('./queue');
const jobsStore = require('./jobsStore');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

fs.mkdirSync(config.downloadDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

// scheduleCleanup's timers only live in memory, so a restart forgets about any pending
// video expiries. A restart isn't itself a reason to invalidate videos that are still
// well within their TTL (Railway can restart the container for a routine deploy while
// a video from minutes ago is still perfectly downloadable) -- so we don't blanket-wipe
// everything, only what's actually gone stale or was never a real, complete download.
// Job *history* (jobs.json) and thumbnails are untouched either way: thumbnails outlive
// the video file itself, shown grayed-out as a record even after the video expires.
{
  const now = Date.now();
  const readyJobsById = new Map();

  for (const job of jobsStore.listJobs()) {
    if (job.status === 'queued' || job.status === 'downloading') {
      // Mid-flight work can't be resumed after the process that was running it died.
      jobsStore.updateJob(job.id, { status: 'failed', error: 'Interrupted by a server restart.' });
    } else if (job.status === 'ready') {
      readyJobsById.set(job.id, job);
    }
  }

  for (const f of fs.readdirSync(config.downloadDir)) {
    if (!/\.mp4$/i.test(f)) continue;
    const id = f.slice(0, -4);
    const job = readyJobsById.get(id);
    const remainingMs = job && job.videoExpiresAt ? job.videoExpiresAt - now : -1;

    if (job && remainingMs > 0) {
      // Still within its TTL -- keep the file and reschedule its expiry for
      // whatever time is left, since the in-memory timer for it is gone.
      scheduleCleanup(
        path.join(config.downloadDir, f),
        () => jobsStore.updateJob(id, { videoExpired: true }),
        remainingMs
      );
    } else {
      fs.unlink(path.join(config.downloadDir, f), () => {});
      if (job) jobsStore.updateJob(id, { videoExpired: true });
    }
  }
}

// Periodically purge job history (and any leftover thumbnail) older than
// DASHBOARD_HISTORY_DAYS so jobs.json and disk usage don't grow unbounded.
setInterval(() => {
  const removed = jobsStore.purgeOlderThan(config.dashboardHistoryMs);
  for (const job of removed) cleanupJobFiles(job.id);
}, 60 * 60 * 1000).unref();

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Serves the downloaded/compressed video so Twilio/WhatsApp can fetch it for inline video
// messages, and so a person can tap the link directly for videos too large to send inline.
// Content-Disposition: attachment makes a direct browser visit download the file instead of
// trying to stream/play it inline; Twilio's own media fetch ignores this header and just
// reads the bytes + Content-Type, so it doesn't affect the inline-video send path.
app.get('/media/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9-]+\.mp4$/i.test(file)) {
    return res.status(400).send('Bad request');
  }
  const filePath = path.join(config.downloadDir, file);
  res.download(filePath, 'video.mp4', (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.post('/whatsapp/webhook', validateTwilioSignature, (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || '';
  const messageSid = req.body.MessageSid;

  const twiml = new MessagingResponse();

  // Twilio retries the webhook if it doesn't get a fast response, which would otherwise
  // re-trigger a download for the same message. Reply 200 with no new message and skip it.
  if (isDuplicate(messageSid)) {
    res.type('text/xml').send(twiml.toString());
    return;
  }

  if (!isAllowedNumber(from)) {
    twiml.message('This number is not authorized to use this bot.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  const url = extractUrl(body);
  if (!url) {
    twiml.message('Send me a video link (YouTube, TikTok, X/Twitter, Instagram, Facebook, Reddit, or LinkedIn) and I\'ll send the video back.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  twiml.message('⏳ Got it, downloading the best quality version now. This can take a minute for longer videos...');
  res.type('text/xml').send(twiml.toString());

  startJob(url, from);
});

// Kicks off a job: records it in history immediately (so it shows up in the dashboard
// as "queued" right away) and queues the actual work behind MAX_CONCURRENT_JOBS.
function startJob(url, from) {
  const jobId = uuid();
  jobsStore.createJob({
    id: jobId,
    url,
    from,
    platform: detectPlatform(url),
    status: 'queued',
    requestedAt: Date.now(),
  });

  enqueue(() => processVideoRequest(jobId, from, url)).catch((err) => {
    console.error(`Unhandled error processing job ${jobId}:`, err);
  });

  return jobId;
}

async function processVideoRequest(jobId, to, url) {
  jobsStore.updateJob(jobId, { status: 'downloading', startedAt: Date.now() });
  let finalPath;

  try {
    const downloadedPath = await downloadVideo(url, jobId);
    const meta = await getVideoMeta(downloadedPath).catch(() => ({}));
    const stat = fs.statSync(downloadedPath);

    if (stat.size <= config.maxMediaBytes) {
      finalPath = downloadedPath;
    } else {
      finalPath = await compressToFit(downloadedPath, config.maxMediaBytes, jobId);
      fs.unlink(downloadedPath, () => {});
    }

    const servedPath = path.join(config.downloadDir, `${jobId}.mp4`);
    if (finalPath !== servedPath) {
      fs.renameSync(finalPath, servedPath);
      finalPath = servedPath;
    }

    // Only the raw video expires here -- its thumbnail stays as a history record
    // (shown grayed-out in the dashboard) until DASHBOARD_HISTORY_DAYS purges the
    // whole job entry.
    scheduleCleanup(finalPath, () => {
      jobsStore.updateJob(jobId, { videoExpired: true });
    });

    const thumbPath = path.join(config.downloadDir, `${jobId}.jpg`);
    const thumbnailAvailable = await generateThumbnail(finalPath, thumbPath, meta.durationSeconds)
      .then(() => true)
      .catch((err) => {
        console.error(`Thumbnail generation failed for job ${jobId}:`, err.message);
        return false;
      });

    const finalSize = fs.statSync(finalPath).size;
    const deliveryType = finalSize <= config.inlineVideoBytes ? 'inline' : 'link';

    jobsStore.updateJob(jobId, {
      status: 'ready',
      completedAt: Date.now(),
      sizeBytes: finalSize,
      durationSeconds: meta.durationSeconds || null,
      height: meta.height || null,
      deliveryType,
      thumbnailAvailable,
      videoExpiresAt: Date.now() + config.fileTtlMs,
    });

    // Jobs started from the dashboard (paste-a-link) have no WhatsApp sender to notify --
    // the dashboard's own polling already shows the result, so skip the Twilio send.
    if (to) {
      if (deliveryType === 'inline') {
        await sendMedia(to, '✅ Here is your video.', mediaUrlFor(jobId));
      } else {
        // WhatsApp rejects inline video messages above ~16MB. Above that (up to
        // maxMediaBytes) we hand back a direct download link instead of a failed send.
        await sendText(
          to,
          `✅ Your video is ready (${(finalSize / (1024 * 1024)).toFixed(1)}MB) but too large ` +
            `for WhatsApp to play inline. Tap to download:\n${mediaUrlFor(jobId)}`
        );
      }
    }
  } catch (err) {
    console.error(`Job ${jobId} failed for ${url}:`, err.message);
    await cleanupJobFiles(jobId);
    jobsStore.updateJob(jobId, {
      status: 'failed',
      completedAt: Date.now(),
      error: errorMessageFor(err),
    });
    if (to) {
      await sendText(
        to,
        `❌ Sorry, I couldn't download that video. ${errorMessageFor(err)}`
      ).catch((sendErr) => console.error('Failed to notify user of error:', sendErr));
    }
  }
}

function errorMessageFor(err) {
  const msg = err.message || '';
  if (msg.includes('Unable to compress')) {
    return 'The video is too large to send over WhatsApp even after compression.';
  }
  if (msg.includes('timed out')) {
    return 'The download took too long and timed out.';
  }
  return 'The link may be private, unsupported, or region-locked.';
}

// --- Owner dashboard -------------------------------------------------------------

app.get('/dashboard', requireDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.get('/dashboard/api/jobs', requireDashboardAuth, (req, res) => {
  const now = Date.now();
  const jobs = jobsStore.listJobs().map((job) => ({
    ...job,
    // The video file may have expired since the job finished; compute that live
    // rather than relying on a background process to have flagged it in time.
    videoExpired: job.videoExpired || (job.videoExpiresAt ? now > job.videoExpiresAt : false),
    mediaUrl: job.status === 'ready' ? mediaUrlFor(job.id) : null,
    thumbnailUrl: job.thumbnailAvailable ? `/thumbs/${job.id}.jpg` : null,
  }));
  res.json({ jobs, whatsappNumber: config.twilioWhatsAppNumber });
});

// Lets the owner paste a link directly into the dashboard instead of going through
// WhatsApp. `from` is left null -- there's no phone number to notify, the dashboard's
// own polling already shows the result.
app.post('/dashboard/api/jobs', requireDashboardAuth, (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Enter a valid video link.' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'Enter a valid video link.' });
  }

  const jobId = startJob(url, null);
  res.json({ ok: true, jobId });
});

app.delete('/dashboard/api/jobs/:id', requireDashboardAuth, async (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  await cleanupJobFiles(job.id);
  jobsStore.deleteJob(job.id);
  res.json({ ok: true });
});

app.post('/dashboard/api/jobs/:id/retry', requireDashboardAuth, (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const jobId = startJob(job.url, job.from);
  res.json({ ok: true, jobId });
});

app.get('/thumbs/:file', requireDashboardAuth, (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9-]+\.jpg$/i.test(file)) {
    return res.status(400).send('Bad request');
  }
  res.sendFile(path.join(config.downloadDir, file), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.listen(config.port, () => {
  console.log(`WhatsApp video downloader listening on port ${config.port}`);
  if (!config.dashboardEnabled) {
    console.log('Dashboard disabled -- set DASHBOARD_USER and DASHBOARD_PASSWORD to enable /dashboard.');
  }
});
