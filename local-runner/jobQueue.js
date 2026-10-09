'use strict';
const sendTrace = require('../shared/sendTrace');
const crypto = require('crypto');

/**
 * Hai hàng đợi báo hàng/báo ship độc lập; mỗi hàng đợi vẫn chạy tuần tự.
 * POST trả jobId ngay; client poll /api/job/:id để lấy kết quả (tránh timeout qua tunnel).
 */

const jobs = new Map(); // id -> { id, status, result, error, createdAt, startedAt, finishedAt, payload }
const laneScope = require('../shared/notificationLane');
const queues = { hang: [], ship: [] };
const running = new Set();

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
  sendTrace.log('runner.queued', { traceId: payload.traceId, jobId: id, profile: payload.profile, account: payload.account, lane: payload.browserLane, ...sendTrace.messageMeta(payload.message) });
  jobs.set(id, job);
  const lane = laneScope.normalize(payload.browserLane);
  queues[lane].push(id);
  pump(lane);
  return id;
}

async function pump(lane) {
  if (running.has(lane)) return;
  running.add(lane);
  const queue = queues[lane];
  try {
    while (queue.length) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job) continue;
      job.status = 'running';
      job.startedAt = Date.now();
      try {
        job.result = await sendTrace.run({ traceId: job.payload.traceId, jobId: id, profile: job.payload.profile, account: job.payload.account, lane }, async () => {
          sendTrace.log('runner.started', { queueWaitMs: job.startedAt - job.createdAt });
          return laneScope.run(lane, () => job._handler(job.payload));
        });
        if (job.result?.ok === false) throw new Error(job.result.error || 'NEEDS_CHECK: handler kết thúc nhưng không xác nhận thành công.');
        job.status = 'done';
        sendTrace.log('runner.done', { traceId: job.payload.traceId, jobId: id, runnerOk: job.result?.ok, durationMs: Date.now() - job.startedAt });
      } catch (err) {
        job.status = 'error';
        job.error = err && err.message ? err.message : String(err);
        sendTrace.log('runner.error', { traceId: job.payload.traceId, jobId: id, error: job.error, stack: err?.stack, durationMs: Date.now() - job.startedAt });
      } finally {
        job.finishedAt = Date.now();
        delete job._handler;
      }
    }
  } finally {
    running.delete(lane);
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
