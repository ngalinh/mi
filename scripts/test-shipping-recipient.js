'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
function harness({ channel = 'zalo', fail = false, missing = false, noLink = false } = {}) {
  const sent = [], reports = [], synced = [], resolved = [];
  let fallbackCalls = 0;
  const mocks = {
    './accountFallback': { canTryNextAccount: () => false, sendFacebookWithFallback: (send, r, p) => send(p) },
    './accountQueue': { once: (key, fn) => fn(), pendingReport: fn => fn(), withBrowserBatch: fn => fn(), accountQueue: async function* (list, send) { for (const item of list) yield { item, result: await send(item) }; } },
    './notificationHold': { getHold: () => null, isUncertain: () => false },
    './lock': { withLock: fn => fn() },
    './playwrightProxy': Object.fromEntries(['sendBaoHang', 'sendBaoHangFb'].map(k => [k, async p => { sent.push(p); return { ok: !fail, error: fail ? 'KHONG_THAY_HOI_THOAI' : null }; }])),
    './accountResolver': { resolveForOrder: async (o, opts) => { resolved.push({ o, opts }); return { channel, profile: 'test' }; }, isRetryableAccountError: () => true },
    './shippingNotify': { buildDeliveryMessage: o => ({ sendable: true, message: `Delivery for ${o.recipient}` }) },
    './bassoApi': { getTabUsers: async () => ({ tabUsers: [] }), findCustomerByOrderCode: async () => { fallbackCalls++; return { phone: 'third' }; }, syncShipStatusByCode: async p => { synced.push(p); return {}; } },
    './db': { normPhone: p => String(p).trim(), listZaloContacts: () => missing ? [] : [{ phone: 'selected', zalo_name: 'Selected customer' }], getShippingNotified: () => null, getShippingTemplates: () => ({}), getZaloName: p => p === 'selected' ? 'Selected customer' : '', getFbLink: p => !noLink ? `fb/${p}` : '', getContactReportTarget: p => p === 'selected' ? 'personal' : 'group', addReport: p => { reports.push(p); return { id: 1, ...p }; }, updateReport: (id, p) => { Object.assign(reports[0], p); return reports[0]; }, markShippingNotified: () => {} },
  };
  const box = { module: { exports: {} }, console: { log() {}, warn() {} }, require: n => { if (!mocks[n]) throw Error(n); return mocks[n]; } };
  vm.runInNewContext(read('server/shippingSendService.js'), box);
  return { service: box.module.exports, sent, reports, synced, resolved, fallbackCalls: () => fallbackCalls };
}
const order = { id: 1, phone: 'delivery', recipient: 'Physical recipient', notifyPhone: 'selected', items: [{ orderCode: 'ABC' }] };
for (const channel of ['zalo', 'facebook']) {
  test(`manual ${channel} destination keeps delivery message and records actual contact`, async () => {
    const h = harness({ channel });
    assert.equal((await h.service.sendShippingOne(order)).ok, true);
    assert.equal(h.sent[0].keyword, 'selected');
    assert.equal(h.sent[0].name, 'Selected customer');
    assert.equal(h.sent[0].message, 'Delivery for Physical recipient');
    assert.equal(h.resolved[0].o.phone, 'selected');
    assert.equal(h.reports[0].phone, 'selected');
    assert.equal(h.reports[0].phoneOriginal, 'delivery');
    assert.equal(h.reports[0].phoneSource, 'manual_contact');
    assert.equal(h.synced[0].phone, 'selected');
    assert.equal(order.phone, 'delivery');
    if (channel === 'zalo') assert.equal(h.sent[0].notifyTarget, 'personal');
  });
  test(`manual ${channel} failure cannot fall back to a different customer`, async () => {
    const h = harness({ channel, fail: true, noLink: channel === 'facebook' });
    assert.equal((await h.service.sendShippingOne(order)).ok, false);
    assert.equal(h.fallbackCalls(), 0);
  });
}
test('removed contact fails before resolving or sending', async () => {
  const h = harness({ missing: true });
  assert.equal((await h.service.sendShippingOne(order)).ok, false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.resolved.length, 0);
});
test('bulk preserves each destination and manual sender', async () => {
  const h = harness();
  const r = await h.service.sendShippingBulk([{ ...order, account: 'Manual', profile: 'manual' }, { ...order, id: 2, notifyPhone: '' }]);
  assert.equal(r.sent, 2);
  assert.deepEqual(h.sent.map(p => p.keyword), ['selected', 'delivery']);
  assert.equal(h.resolved[0].opts.profile, 'manual');
});
test('default destination retains existing customer fallback', async () => {
  const h = harness({ fail: true });
  await h.service.sendShippingOne({ ...order, notifyPhone: '' });
  assert.equal(h.fallbackCalls(), 1);
});
test('UI payload preserves shipping recipient and applies contact to preview/single/bulk', () => {
  let source = read('server/public/js/giaohang.js');
  source = source.slice(0, source.lastIndexOf('  bind();')) + 'globalThis.ui = { state, toApiOrder, withRowAccountOverride }; })();';
  const box = { document: {}, localStorage: { getItem: () => null } };
  vm.runInNewContext(source, box);
  box.ui.state.rowRecipients.set('1', 'selected');
  const payload = box.ui.withRowAccountOverride(box.ui.toApiOrder(order), 1);
  assert.equal(payload.notifyPhone, 'selected');
  assert.equal(payload.phone, 'delivery');
  assert.equal(payload.recipient, 'Physical recipient');
  box.ui.state.rowRecipients.delete('1');
  assert.equal(box.ui.toApiOrder(order).notifyPhone, '');
});
