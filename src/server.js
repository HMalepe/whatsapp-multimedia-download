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

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

fs.mkdirSync(config.downloadDir, { recursive: true });

app.get('/health', (req, res) => res.json({ ok: true }));

// Serves the downloaded/compressed video so Twilio/WhatsApp can fetch it.
app.get('/media/:file', (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9-]+\.mp4$/i.test(file)) {
    return res.status(400).send('Bad request');
  }
  const filePath = path.join(config.downloadDir, file);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.post('/whatsapp/webhook', validateTwilioSignature, (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || '';

  const twiml = new MessagingResponse();

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

  // Process asynchronously so we don't block the webhook response.
  processVideoRequest(from, url).catch((err) => {
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
    await sendMedia(to, '✅ Here is your video.', mediaUrlFor(jobId));
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
