const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { MessagingResponse } = require('twilio').twiml;

const config = require('./config');
const { extractUrl } = require('./helpers');
const { isAllowedNumber, validateTwilioSignature } = require('./security');
const { downloadVideo, compressToFit } = require('./downloader');
const { scheduleCleanup, mediaUrlFor, cleanupJobFiles } = require('./storage');
const { sendText, sendMedia } = require('./whatsapp');
const { isDuplicate } = require('./dedupe');
const { enqueue } = require('./queue');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

fs.mkdirSync(config.downloadDir, { recursive: true });

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

  // Queued so at most MAX_CONCURRENT_JOBS downloads/compressions run at once, and
  // processed asynchronously so we don't block the webhook response.
  enqueue(() => processVideoRequest(from, url)).catch((err) => {
    console.error('Unhandled error processing request:', err);
  });
});

async function processVideoRequest(to, url) {
  const jobId = uuid();
  let finalPath;

  try {
    const downloadedPath = await downloadVideo(url, jobId);
    const stat = fs.statSync(downloadedPath);

    if (stat.size <= config.maxMediaBytes) {
      finalPath = downloadedPath;
    } else {
      finalPath = await compressToFit(downloadedPath, config.maxMediaBytes, jobId);
      fs.unlink(downloadedPath, () => {});
    }

    const servedName = `${jobId}.mp4`;
    const servedPath = path.join(config.downloadDir, servedName);
    if (finalPath !== servedPath) {
      fs.renameSync(finalPath, servedPath);
      finalPath = servedPath;
    }

    scheduleCleanup(finalPath);

    const finalSize = fs.statSync(finalPath).size;
    if (finalSize <= config.inlineVideoBytes) {
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
  } catch (err) {
    console.error(`Job ${jobId} failed for ${url}:`, err.message);
    await cleanupJobFiles(jobId);
    await sendText(
      to,
      `❌ Sorry, I couldn't download that video. ${errorMessageFor(err)}`
    ).catch((sendErr) => console.error('Failed to notify user of error:', sendErr));
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

app.listen(config.port, () => {
  console.log(`WhatsApp video downloader listening on port ${config.port}`);
});
