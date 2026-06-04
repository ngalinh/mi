'use strict';
const crypto = require('crypto');

/**
 * Job queue tuần tự (1 browser, chạy lần lượt) — tránh nhiều job thao tác browser cùng lúc.
 * POST trả jobId ngay; client poll /api/job/:id để lấy kết quả (tránh timeout qua tunnel).
 */

const jobs = new Map(); // id -> { id, status, result, error, createdAt, startedAt, finishedAt, payload }
const queue = [];
let running = false;

function createJob(payload, handler) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued', // queued | running | done | error
    payload,
    result: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    _handler: handler,
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return id;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job) continue;
      job.status = 'running';
      job.startedAt = Date.now();
      try {
        job.result = await job._handler(job.payload);
        job.status = 'done';
      } catch (err) {
        job.status = 'error';
        job.error = err && err.message ? err.message : String(err);
      } finally {
        job.finishedAt = Date.now();
        delete job._handler;
      }
    }
  } finally {
    running = false;
  }
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const { _handler, ...rest } = job;
  return rest;
}

// Dọn job cũ > 1 giờ định kỳ
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

module.exports = { createJob, getJob };
