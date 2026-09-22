'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isShippingTime, SCHEDULE_TIME } = require('../server/shippingSchedule');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('non-Ahamove carriers wait until 17:30 Vietnam, including Grab and unknown metadata', () => {
  assert.equal(SCHEDULE_TIME, '17:30');
  for (const shippingId of [2, 4, 7, 99, null]) {
    assert.equal(isShippingTime({ shippingId }, new Date('2026-09-22T10:29:59Z')), false);
    assert.equal(isShippingTime({ shippingId }, new Date('2026-09-22T10:30:00Z')), true);
    assert.equal(isShippingTime({ shippingId }, new Date('2026-09-22T12:00:00Z')), true);
    assert.equal(isShippingTime({ shippingId }, new Date('2026-09-22T17:00:00Z')), false);
  }
});
test('Ahamove retains immediate delivery, including string carrier IDs', () => {
  for (const order of [{ shippingId: 3 }, { shippingId: '3' }, { shipping_id: 3 }]) {
    assert.equal(isShippingTime(order, new Date('2026-09-22T01:00:00Z')), true);
  }
});

for (const trigger of ['interval', 'webhook', 'ship-poll', 'ship-catch', 'manual']) {
  test(`arrival shipping ${trigger} observes cutoff without marking waiting orders`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../server/autoNotify.js'), 'utf8');
    const body = source.slice(source.indexOf('async function executeNotifyPass('), source.indexOf('async function runAutoNotify('));
    for (const time of ['2026-09-22T10:29:00Z', '2026-09-22T10:30:00Z']) {
      const recorded = [];
      const box = { Date: class extends Date { constructor() { super(time); } },
        require: () => ({ isShippingTime }), cfg: { timezone: 'Asia/Ho_Chi_Minh' },
        state: {}, withLock: fn => fn(), withBrowserBatch: fn => fn(), checkLocalHealth: async () => true,
        fetchAllByStatus: async () => [{ id: 1, shippingId: 3 }, { id: 2, shippingId: 4 }],
        autoKey: o => o.id, getDelayedMap: () => new Map(), getAutoRecord: () => null,
        recordAutoNotified: id => recorded.push(id), isTransientError: () => false,
        notifyOne: async () => ({ ok: true }), console: { log() {} },
        accountQueue: async function* (items, send) { for (const item of items) yield { item, result: await send(item) }; },
      };
      vm.createContext(box); vm.runInContext(body, box);
      const summary = { results: [], sent: 0, failed: 0 };
      await box.executeNotifyPass({ kind: 'ship', trigger, statusFilter: 'not_sent', summary,
        classify: async () => ({ decision: 'send' }), keyOf: o => o.id });
      assert.deepEqual(recorded, trigger === 'manual' || time.includes('10:30') ? [1, 2] : [1]);
    }
  });
}

test('shipping management poll waits, manual bypasses, without consuming attempts', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/shippingAutoNotify.js'), 'utf8');
  const body = source.slice(source.indexOf('async function runShippingAuto('), source.indexOf('async function runSafetyNet('));
  for (const trigger of ['interval', 'manual']) {
    const sent = [];
    const box = { Date: class extends Date { constructor() { super('2026-09-22T10:29:00Z'); } },
      config: { autoNotify: { timezone: 'Asia/Ho_Chi_Minh' } }, cfg: { maxRetries: 3 }, isShippingTime,
      state: { enabled: true }, SEEDED_KEY: 'seed', safeGet: () => 'seeded',
      withLock: fn => fn(), withBrowserBatch: fn => fn(), checkLocalHealth: async () => true,
      fetchRecentOrders: async () => [{ id: 1, shippingId: 3 }, { id: 2, shippingId: 7 }],
      getShippingNotified: () => null, isShippingAutoSeen: () => false,
      classify: () => ({ decision: 'send' }), recordShippingAutoFail: () => { throw Error('Unexpected attempt'); },
      shippingSendService: { sendShippingOne: async o => { sent.push(o.id); return { ok: true }; } },
      accountQueue: async function* (items, send) { for (const item of items) yield { item, result: await send(item) }; },
      console: { error() {}, warn() {} },
    };
    vm.createContext(box); vm.runInContext(body, box);
    const result = await box.runShippingAuto({ trigger });
    assert.equal(result.error, undefined);
    assert.deepEqual(sent, trigger === 'manual' ? [1, 2] : [1]);
  }
});
