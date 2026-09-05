// A tiny in-process job queue so at most N downloads/compressions run at once --
// keeps a burst of pasted links from overloading the container's CPU (ffmpeg
// compression is the expensive part) or hitting Railway's memory limits.
const config = require('./config');

const pending = [];
let running = 0;

function pump() {
  if (running >= config.maxConcurrentJobs) return;
  const job = pending.shift();
  if (!job) return;

  running++;
  // Wrapped in Promise.resolve().then(...) rather than calling job.task() directly, so a
  // task that throws synchronously (instead of returning a rejected promise) still gets
  // caught here -- otherwise it would break out of pump() without ever decrementing
  // `running`, permanently wedging the queue.
  Promise.resolve()
    .then(job.task)
    .then(job.resolve, job.reject)
    .finally(() => {
      running--;
      pump();
    });
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    pump();
  });
}

module.exports = { enqueue };
