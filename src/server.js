const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

const config = require('./config');
const { extractUrl, detectPlatform } = require('./helpers');
const { requireDashboardAuth } = require('./dashboardAuth');
const {
  downloadVideo,
  compressToFit,
  getVideoMeta,
  generateThumbnail,
  generateGif,
} = require('./downloader');
const { scheduleCleanup, mediaUrlFor, cleanupJobFiles } = require('./storage');
const { sendText, sendMedia } = require('./whatsapp');
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
// Job *history* (jobs.json) and thumbnails/GIFs are untouched either way: they outlive the
// raw video file, shown as a record even after the video itself expires.
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

// Periodically purge job history (and any leftover thumbnail/GIFs) older than
// DASHBOARD_HISTORY_DAYS so jobs.json and disk usage don't grow unbounded.
setInterval(() => {
  const removed = jobsStore.purgeOlderThan(config.dashboardHistoryMs);
  for (const job of removed) cleanupJobFiles(job.id);
}, 60 * 60 * 1000).unref();

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

// Flush any debounced-but-not-yet-written job update before the process actually exits
// (Railway sends SIGTERM on every redeploy/restart).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    jobsStore.flush();
    process.exit(0);
  });
}

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Media serving -----------------------------------------------------------------
// Gated behind the same login as the dashboard: once you've authenticated for the page,
// the browser automatically resends those credentials for the <video>/<img> tags that
// point here, so this stays invisible in normal use. (Part 2/WhatsApp will need its own
// arrangement here, since Twilio's media fetch can't complete a Basic Auth challenge --
// e.g. a short-lived signed URL minted at send time -- rather than loosening this.)

app.get('/media/:file', requireDashboardAuth, (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9-]+\.mp4$/i.test(file)) {
    return res.status(400).send('Bad request');
  }
  const filePath = path.join(config.downloadDir, file);
  res.download(filePath, 'video.mp4', (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
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

// GIFs are served plainly (no forced download) so <img> previews work inline; the
// dashboard's download button uses the anchor `download` attribute instead.
app.get('/gifs/:file', requireDashboardAuth, (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9-]+_gif_[a-f0-9-]+\.gif$/i.test(file)) {
    return res.status(400).send('Bad request');
  }
  res.sendFile(path.join(config.downloadDir, file), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

// --- Job lifecycle -------------------------------------------------------------------

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
      finalPath = await compressToFit(downloadedPath, config.maxMediaBytes, jobId, meta.durationSeconds);
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

    // Part 2 (WhatsApp): jobs started from the dashboard have no phone number to notify --
    // the dashboard's own polling already shows the result -- so this only fires for jobs
    // that came in over the (optional) WhatsApp webhook.
    if (to) {
      if (deliveryType === 'inline') {
        await sendMedia(to, '✅ Here is your video.', mediaUrlFor(jobId));
      } else {
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
    return 'The video is too large to fit under the size limit even after compression.';
  }
  if (msg.includes('timed out')) {
    return 'The download took too long and timed out.';
  }
  return 'The link may be private, unsupported, or region-locked.';
}

// HTTP Basic Auth credentials, once cached by the browser, are attached automatically to
// *any* request to this origin -- unlike cookies there's no SameSite protection, so a
// malicious page could auto-submit a plain HTML form (a "simple" cross-origin POST needs no
// CORS preflight) to e.g. POST /api/jobs and trigger a download as the logged-in owner,
// without ever knowing the password. Requiring this header blocks that: a cross-origin page
// can't add a custom header to a simple request, and adding one to a fetch() would trigger a
// CORS preflight this server doesn't allow. Our own dashboard.html sets it on every
// state-changing call.
function requireSameOriginFetch(req, res, next) {
  if (req.get('X-Vault-Fetch') !== '1') {
    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }
  next();
}

// --- Dashboard (the app) -------------------------------------------------------------

app.get('/', requireDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
// Kept as an alias so any previously-bookmarked /dashboard link still works.
app.get('/dashboard', requireDashboardAuth, (req, res) => res.redirect('/'));

app.get('/api/jobs', requireDashboardAuth, (req, res) => {
  const now = Date.now();
  const jobs = jobsStore.listJobs().map((job) => ({
    ...job,
    // The video file may have expired since the job finished; compute that live
    // rather than relying on a background process to have flagged it in time.
    videoExpired: job.videoExpired || (job.videoExpiresAt ? now > job.videoExpiresAt : false),
    mediaUrl: job.status === 'ready' ? mediaUrlFor(job.id) : null,
    thumbnailUrl: job.thumbnailAvailable ? `/thumbs/${job.id}.jpg` : null,
    gifs: (job.gifs || []).map((g) => ({ ...g, url: `/gifs/${job.id}_gif_${g.id}.gif` })),
  }));
  res.json({
    jobs,
    whatsappEnabled: config.whatsappEnabled,
    whatsappNumber: config.twilioWhatsAppNumber,
    gifMaxDurationSeconds: config.gifMaxDurationSeconds,
  });
});

// Paste-a-link: the dashboard's primary way of starting a download. `from` is left null --
// there's no phone number to notify, the dashboard's own polling already shows the result.
app.post('/api/jobs', requireDashboardAuth, requireSameOriginFetch, (req, res) => {
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

app.delete('/api/jobs/:id', requireDashboardAuth, requireSameOriginFetch, async (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  await cleanupJobFiles(job.id);
  jobsStore.deleteJob(job.id);
  res.json({ ok: true });
});

app.post('/api/jobs/:id/retry', requireDashboardAuth, requireSameOriginFetch, (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const jobId = startJob(job.url, job.from);
  res.json({ ok: true, jobId });
});

// --- GIF export ------------------------------------------------------------------------

app.post('/api/jobs/:id/gif', requireDashboardAuth, requireSameOriginFetch, async (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'ready' || job.videoExpired) {
    return res.status(409).json({ error: 'This video is no longer available -- re-download it first.' });
  }

  const start = Number(req.body && req.body.start);
  const end = Number(req.body && req.body.end);
  const fpsRaw = req.body && req.body.fps !== undefined ? Number(req.body.fps) : 12;
  const widthRaw = req.body && req.body.width !== undefined ? Number(req.body.width) : 480;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return res.status(400).json({ error: 'Invalid start/end range.' });
  }
  if (!Number.isFinite(fpsRaw) || !Number.isFinite(widthRaw)) {
    return res.status(400).json({ error: 'Invalid fps/width.' });
  }
  if (job.durationSeconds && start >= job.durationSeconds) {
    return res.status(400).json({ error: 'Start time is past the end of the video.' });
  }

  const fps = Math.min(30, Math.max(4, fpsRaw));
  const width = Math.min(720, Math.max(120, widthRaw));
  // Clamp by both the configured max clip length and (when known) however much video
  // actually remains after `start` -- otherwise a too-large `end` would make ffmpeg stop
  // early when the source runs out, while the saved record still claimed the longer,
  // requested range.
  const remaining = job.durationSeconds ? job.durationSeconds - start : Infinity;
  const duration = Math.min(end - start, config.gifMaxDurationSeconds, remaining);

  const videoPath = path.join(config.downloadDir, `${job.id}.mp4`);
  const gifId = uuid();
  const gifPath = path.join(config.downloadDir, `${job.id}_gif_${gifId}.gif`);

  try {
    await generateGif(videoPath, gifPath, { start, duration, fps, width });
    const { size } = await fs.promises.stat(gifPath);
    if (size === 0) throw new Error('ffmpeg produced an empty file');

    const gifRecord = { id: gifId, start, end: start + duration, fps, width, sizeBytes: size, createdAt: Date.now() };
    const gifs = [...(job.gifs || []), gifRecord];
    jobsStore.updateJob(job.id, { gifs });

    res.json({ ok: true, gif: { ...gifRecord, url: `/gifs/${job.id}_gif_${gifId}.gif` } });
  } catch (err) {
    console.error(`GIF generation failed for job ${job.id}:`, err.message);
    await fs.promises.unlink(gifPath).catch(() => {});
    res.status(500).json({ error: 'Could not create the GIF from that range.' });
  }
});

app.delete('/api/jobs/:id/gif/:gifId', requireDashboardAuth, requireSameOriginFetch, async (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const gifs = job.gifs || [];
  const remaining = gifs.filter((g) => g.id !== req.params.gifId);
  if (remaining.length === gifs.length) return res.status(404).json({ error: 'Not found' });

  await fs.promises
    .unlink(path.join(config.downloadDir, `${job.id}_gif_${req.params.gifId}.gif`))
    .catch(() => {});
  jobsStore.updateJob(job.id, { gifs: remaining });
  res.json({ ok: true });
});

// --- Part 2: WhatsApp (optional) -----------------------------------------------------

if (config.whatsappEnabled) {
  const { MessagingResponse } = require('twilio').twiml;
  const { isAllowedNumber, validateTwilioSignature } = require('./security');
  const { isDuplicate } = require('./dedupe');

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
} else {
  app.post('/whatsapp/webhook', (req, res) => {
    res.status(404).send('WhatsApp is not configured on this deployment (see README: Part 2).');
  });
}

app.listen(config.port, () => {
  console.log(`Video Vault listening on port ${config.port}`);
  console.log(
    config.dashboardEnabled
      ? 'Dashboard ready at /'
      : 'Dashboard disabled -- set DASHBOARD_USER and DASHBOARD_PASSWORD to enable it.'
  );
  console.log(config.whatsappEnabled ? 'WhatsApp (Part 2) enabled.' : 'WhatsApp (Part 2) not configured -- dashboard-only mode.');
});
