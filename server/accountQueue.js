'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { withLock } = require('./lock');
const active = new AsyncLocalStorage();
const laneScope = require('../shared/notificationLane');
const urgent = new Map();

// Cooperatively borrow the lane only between customers, never during a send.
async function drainPriority(before = async () => {}) {
  const jobs = urgent.get(laneScope.current());
  if (!jobs?.length || active.getStore()?.priority) return;
  await before();
  while (jobs.length) {
    const job = jobs.shift();
    try { job.resolve(await active.run({ priority: true }, job.fn)); }
    catch (err) { job.reject(err); }
  }
}

function withPriorityBatch(fn) {
  const lane = laneScope.current();
  const jobs = urgent.get(lane) || [];
  urgent.set(lane, jobs);
  const result = new Promise((resolve, reject) => jobs.push({ fn, resolve, reject }));
  // Also run when there is no bulk loop to yield to us.
  withLock(() => drainPriority(), lane).catch(err => {
    for (const job of jobs.splice(0)) job.reject(err);
  });
  return result;
}

// Resume at a fallback account without repeating earlier sends or reports.
function once(key, create) {
  const task = active.getStore()?.task;
  if (!task) return create();
  if (!task.memo.has(key)) task.memo.set(key, create());
  return task.memo.get(key);
}

function pendingReport(create, abandon) {
  return once('report', () => {
    const report = create();
    const task = active.getStore()?.task;
    if (task) task.abandon = () => abandon(report);
    return report;
  });
}

async function dispatchSend(path, payload, send) {
  return withLock(async () => {
    const state = active.getStore();
    const profile = payload.profile || 'default';
    const task = state?.task;
    const key = JSON.stringify([path, profile, payload.account, payload.keyword, payload.name,
      payload.message, payload.fbLink, payload.imagePaths, payload.notifyTarget, payload.strictMatch]);
    if (task?.attempts.has(key)) return task.attempts.get(key);
    // Discovery and fallback enqueue work; they never open another browser.
    if (task && task.profile !== profile) return { ok: false, deferred: true, profile };
    const batch = state?.batch;
    if (batch?.unavailable.has(profile)) {
      const result = batch.unavailable.get(profile);
      // Remember the skipped account when this task resumes on a fallback.
      // Otherwise it keeps bouncing between the unavailable and fallback profiles.
      if (task) task.attempts.set(key, result);
      return result;
    }
    if (batch) {
      if (batch.profile !== profile) {
        await batch.close();
        batch.profile = profile;
      }
      if (batch.sent) await require('./notifyService').delayBetweenCustomers();
      if (batch.shouldStop()) return { ok: false, stopped: true };
      batch.sent = true;
    }
    let result;
    try {
      const { prepareMessage, ...ready } = payload;
      if (prepareMessage) ready.message = await prepareMessage();
      if (batch?.shouldStop()) return { ok: false, stopped: true };
      result = await send({ ...ready, browserLane: require('../shared/notificationLane').current(), keepContext: !!batch, closeAfterSend: true }); }
    catch (err) { result = { ok: false, error: err.message }; }
    if (task) task.attempts.set(key, result);
    if (batch && /^(?:CHUA_DANG_NHAP|ACCOUNT_UNAVAILABLE):/.test(result.error || '')) {
      batch.unavailable.set(profile, result);
      await batch.close();
    }
    return result;
  });
}

async function withBrowserBatch(fn) {
  return withLock(async () => {
    const batch = { profile: null, sent: false, unavailable: new Map(), shouldStop: () => false };
    batch.close = async () => {
      if (batch.profile == null) return;
      await require('./playwrightProxy').closeBrowserProfile(batch.profile);
      batch.profile = null;
    };
    return active.run({ batch, priority: active.getStore()?.priority }, async () => {
      try { return await fn(batch); }
      finally { await batch.close(); }
    });
  });
}

async function* accountQueue(items, send, { shouldStop = () => false } = {}) {
  const batch = active.getStore()?.batch;
  if (!batch) throw new Error('accountQueue requires withBrowserBatch');
  batch.shouldStop = shouldStop;
  const tasks = items.map(item => ({ item, profile: null, memo: new Map(), attempts: new Map() }));
  const pending = [...tasks];
  try {
    while (pending.length && !shouldStop()) {
      await drainPriority(() => batch.close());
      if (shouldStop()) break;
      const aha = laneScope.current() === 'ship'
        ? pending.filter(t => Number(t.item.shippingId ?? t.item.shipping_id) === 3) : [];
      const candidates = aha.length ? aha : pending;
      const chosen = candidates.find(t => t.profile == null)
        || candidates.find(t => t.profile === batch.profile) || candidates[0];
      const i = pending.indexOf(chosen);
      const task = pending.splice(i, 1)[0];
      const result = await active.run({ batch, task, priority: active.getStore()?.priority }, () => send(task.item));
      if (result.deferred) {
        task.profile = result.profile;
        pending.push(task);
        continue;
      }
      if (result.stopped && task.abandon) task.abandon();
      task.done = true;
      yield { item: task.item, result };
    }
  } finally {
    for (const task of tasks) if (!task.done && task.abandon) task.abandon();
  }
}

module.exports = { once, pendingReport, dispatchSend, withBrowserBatch, accountQueue, withPriorityBatch };
