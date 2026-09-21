'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { withLock } = require('./lock');
const active = new AsyncLocalStorage();

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
    try { result = await send({ ...payload, browserLane: require('../shared/notificationLane').current(), keepContext: !!batch, closeAfterSend: true }); }
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
    return active.run({ batch }, async () => {
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
      let i = pending.findIndex(t => t.profile == null);
      if (i < 0) i = pending.findIndex(t => t.profile === batch.profile);
      if (i < 0) i = 0;
      const task = pending.splice(i, 1)[0];
      const result = await active.run({ batch, task }, () => send(task.item));
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

module.exports = { once, pendingReport, dispatchSend, withBrowserBatch, accountQueue };
