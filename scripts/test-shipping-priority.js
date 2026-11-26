'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const lane = require('../shared/notificationLane');
const { withLock } = require('../server/lock');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function queue() {
  const filename = require.resolve('../server/accountQueue');
  const req = createRequire(filename);
  const box = { module: { exports: {} }, require: name => name === './playwrightProxy'
    ? { closeBrowserProfile: async () => {} } : req(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box);
  return box.module.exports;
}

test('new AhaMove work runs after current customer and before remaining bulk; no overlap', async () => {
  const q = queue(), entered = gate(), release = gate(), events = [];
  const bulk = lane.run('ship', () => q.withBrowserBatch(async () => {
    for await (const result of q.accountQueue([{ id: 1 }, { id: 2 }], async o => {
      events.push(o.id);
      if (o.id === 1) { entered.resolve(); await release.promise; events.push('finished'); }
      return { ok: true };
    })) assert.equal(result.result.ok, true);
  }));
  await entered.promise;
  const urgent = lane.run('ship', () => q.withPriorityBatch(() => q.withBrowserBatch(async () => {
    for await (const r of q.accountQueue([{ shippingId: 3 }], async () => { events.push('aha'); return { ok: true }; })) {}
  })));
  assert.deepEqual(events, [1]);
  release.resolve();
  await Promise.all([bulk, urgent]);
  assert.deepEqual(events, [1, 'finished', 'aha', 2]);
});

test('priority errors release the lane and idle priority jobs run', async () => {
  const q = queue(), events = [];
  await lane.run('ship', () => q.withPriorityBatch(async () => events.push('idle')));
  await assert.rejects(lane.run('ship', () => q.withPriorityBatch(async () => { throw Error('failed'); })), /failed/);
  await lane.run('ship', () => q.withPriorityBatch(async () => events.push('next')));
  assert.deepEqual(events, ['idle', 'next']);
});

test('AhaMove in bulk precedes other carriers including across deferred profiles', async () => {
  const q = queue(), sent = [], attempts = new Set();
  await lane.run('ship', () => q.withBrowserBatch(async () => {
    for await (const r of q.accountQueue([{ id: 1, shippingId: 1 }, { id: 2, shippingId: '3' }, { id: 3, shippingId: 1 }], async o => {
      if (!attempts.has(o.id)) { attempts.add(o.id); return { deferred: true, profile: 'X' }; }
      sent.push(o.id); return { ok: true };
    })) {}
  }));
  assert.deepEqual(sent, [2, 1, 3]);
});

test('priority poll scans while normal pass is running and honors eligibility guards', async () => {
  const source = fs.readFileSync(require.resolve('../server/shippingAutoNotify'), 'utf8');
  const body = source.slice(source.indexOf('async function runShippingAuto('), source.indexOf('async function runSafetyNet('));
  const q = queue(), entered = gate(), release = gate(), sent = [];
  const held = withLock(async () => { entered.resolve(); await release.promise; }, 'ship');
  await entered.promise;
  let scanned = false;
  const box = { ...q, state: { enabled: true, running: true }, cfg: { lookbackDays: 3 },
    require: name => { assert.equal(name, '../shared/notificationLane'); return lane; },
    SEEDED_KEY: 'seeded', safeGet: () => true, isAhamove: o => Number(o.shippingId) === 3,
    fetchRecentOrders: async () => { scanned = true; return [1,2,3,4,5,6].map(id => ({ id, shippingId: id === 6 ? 1 : 3 })); },
    checkLocalHealth: async () => true, getHold: key => key === 'shipping:2',
    getShippingNotified: id => id === 3, isShippingAutoSeen: id => id === 4,
    classify: o => ({ decision: o.id === 5 ? 'skip' : 'send', reason: 'no_link_yet' }),
    shippingSendService: { sendShippingOne: async o => { sent.push(o.id); return { ok: true }; } },
    console, withLock };
  vm.runInNewContext(body, box);
  const result = box.runShippingAuto({ trigger: 'interval', priorityOnly: true });
  await new Promise(r => setImmediate(r));
  assert.equal(scanned, true);
  assert.deepEqual(sent, []);
  release.resolve(); await held;
  const summary = await result;
  assert.equal(summary.error, undefined);
  assert.equal(summary.sent, 1);
  assert.deepEqual(sent, [1]);
  assert.equal(box.state.running, true);
  assert.equal(box.state.runningPriority, false);
});

test('failed priority job does not abort bulk or prevent the next priority job', async () => {
  const q = queue(), entered = gate(), release = gate(), events = [];
  const bulk = lane.run('ship', () => q.withBrowserBatch(async () => {
    for await (const r of q.accountQueue([{ id: 1 }, { id: 2 }], async o => {
      events.push(o.id);
      if (o.id === 1) { entered.resolve(); await release.promise; }
      return { ok: true };
    })) {}
  }));
  await entered.promise;
  const failed = assert.rejects(lane.run('ship', () => q.withPriorityBatch(async () => { throw Error('send failed'); })), /send failed/);
  const next = lane.run('ship', () => q.withPriorityBatch(async () => events.push('aha')));
  release.resolve();
  await Promise.all([bulk, failed, next]);
  assert.deepEqual(events, [1, 'aha', 2]);
});

test('stopping bulk while priority is running does not send the remaining customers', async () => {
  const q = queue(), entered = gate(), release = gate(), events = [];
  let stop = false;
  const bulk = lane.run('ship', () => q.withBrowserBatch(async () => {
    for await (const r of q.accountQueue([{ id: 1 }, { id: 2 }], async o => {
      events.push(o.id);
      if (o.id === 1) { entered.resolve(); await release.promise; }
      return { ok: true };
    }, { shouldStop: () => stop })) {}
  }));
  await entered.promise;
  const priority = lane.run('ship', () => q.withPriorityBatch(async () => { events.push('aha'); stop = true; }));
  release.resolve();
  await Promise.all([bulk, priority]);
  assert.deepEqual(events, [1, 'aha']);
});
