'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({ owner = { phone: 'owner', customerName: 'Buyer' }, links = { owner: 'https://facebook.com/buyer' }, lookupError, skipZalo = false, skipFb = false, seen = false } = {}) {
  const calls = { resolve: [], zalo: [], fb: [], lookup: [], marked: [], sync: [], reports: [] };
  const queue = {
    once: (_, fn) => fn(),
    pendingReport: fn => fn(),
    withBrowserBatch: fn => fn(),
    accountQueue: async function* () {},
  };
  // Use the production fallback helper; cache lookups exactly as accountQueue.once does.
  const cache = new Map();
  queue.once = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const deps = {
    './accountFallback': require('../server/accountFallback'),
    './accountQueue': queue,
    './playwrightProxy': {
      sendBaoHang: async p => { calls.zalo.push(p); return { ok: true }; },
      sendBaoHangFb: async p => { calls.fb.push(p); return { ok: true }; },
    },
    './accountResolver': {
      resolveForOrder: async (order, opts) => {
        calls.resolve.push({ order, opts });
        const fb = opts.channel === 'facebook' || opts.account === 'FB';
        return { channel: fb ? 'facebook' : 'zalo', profile: fb ? 'fb' : 'zalo',
          source: opts.account ? 'explicit' : 'store', skip: fb ? skipFb : skipZalo,
          skipReason: fb ? 'fb_no_account' : 'brand' };
      },
      isRetryableAccountError: e => /^KHONG_THAY_HOI_THOAI/.test(e || ''),
    },
    './shippingNotify': require('../server/shippingNotify'),
    './bassoApi': {
      getTabUsers: async () => ({ tabUsers: [{ name: 'Tam', user_id: '1' }] }),
      findCustomerByOrderCode: async code => {
        calls.lookup.push(code);
        if (lookupError) throw new Error(lookupError);
        return typeof owner === 'function' ? owner(code) : owner;
      },
      syncShipStatusByCode: async p => { calls.sync.push(p); return { matches: [] }; },
    },
    './db': {
      getShippingNotified: () => seen ? { sentAt: 'earlier' } : null,
      getShippingTemplates: () => ({}), getZaloName: () => '',
      getFbLink: p => links[p] || '', getContactReportTarget: () => '',
      addReport: p => ({ id: 1, ...p }),
      updateReport: (id, p) => { calls.reports.push(p); return { id, ...p }; },
      markShippingNotified: (...p) => calls.marked.push(p),
    },
    './lock': { withLock: fn => fn() },
  };
  const box = { module: { exports: {} }, console: { log() {}, warn() {} },
    require: name => { if (!(name in deps)) throw new Error(name); return deps[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/shippingSendService.js'), 'utf8'), box);
  const order = { id: 1, shippingId: 3, phone: 'recipient', recipient: 'Receiver',
    trackingCode: 'D0610333', shipperLink: 'https://express.ahamove.com/tracking',
    items: [{ approveUser: 'Tam', orderCode: 'BS1' }] };
  return { calls, order, send: box.module.exports.sendShippingOne };
}
test('AhaMove checks owner contact before resolver and bypasses missing Zalo account', async () => {
  const h = harness({ skipZalo: true });
  assert.equal((await h.send(h.order)).ok, true);
  assert.equal(h.calls.zalo.length, 0);
  assert.equal(h.calls.fb[0].keyword, 'owner');
  assert.equal(h.calls.resolve[0].order.phone, 'owner');
  assert.equal(h.calls.resolve[0].opts.channel, 'facebook');
  assert.equal(h.calls.lookup.length, 1);
  assert.equal(h.calls.marked[0][1], 'owner');
  assert.equal(h.calls.sync[0].phone, 'owner');
  assert.equal(h.calls.reports.at(-1).phoneOriginal, 'recipient');
});
test('same-phone owner with Facebook link is routed directly to Facebook', async () => {
  const h = harness({ owner: { phone: 'recipient' }, links: { recipient: 'https://facebook.com/buyer' } });
  assert.equal((await h.send(h.order)).ok, true);
  assert.equal(h.calls.fb.length, 1);
  assert.equal(h.calls.zalo.length, 0);
});
test('AhaMove without Facebook link retains Zalo sending', async () => {
  const h = harness({ links: {} });
  assert.equal((await h.send(h.order)).ok, true);
  assert.equal(h.calls.zalo[0].keyword, 'recipient');
  assert.equal(h.calls.fb.length, 0);
});
test('manual Zalo channel or account is respected', async () => {
  for (const opts of [{ channel: 'zalo' }, { account: 'Zalo' }]) {
    const h = harness();
    assert.equal((await h.send(h.order, opts)).ok, true);
    assert.equal(h.calls.zalo.length, 1);
    assert.equal(h.calls.lookup.length, 0);
  }
});
test('ambiguous owners or failed lookup do not send to the recipient', async () => {
  for (const options of [
    { lookupError: 'lookup failed' },
    { owner: code => ({ phone: code }) },
    { owner: null },
  ]) {
    const h = harness(options);
    h.order.items.push({ orderCode: 'BS2' });
    assert.equal((await h.send(h.order)).ok, false);
    assert.equal(h.calls.zalo.length + h.calls.fb.length, 0);
  }
});
test('missing Facebook account reports failure without falling back to Zalo', async () => {
  const h = harness({ skipFb: true });
  const r = await h.send(h.order);
  assert.equal(r.ok, false);
  assert.match(r.error, /Facebook/);
  assert.equal(h.calls.zalo.length + h.calls.fb.length, 0);
});
test('other carriers keep their existing routing', async () => {
  const h = harness();
  h.order.shippingId = 7;
  assert.equal((await h.send(h.order)).ok, true);
  assert.equal(h.calls.lookup.length, 0);
  assert.equal(h.calls.zalo.length, 1);
});
test('already sent and missing link are rejected before lookup or send', async () => {
  for (const seen of [true, false]) {
    const h = harness({ seen });
    if (!seen) h.order.shipperLink = '';
    assert.equal((await h.send(h.order)).ok, false);
    assert.equal(h.calls.lookup.length, 0);
    assert.equal(h.calls.zalo.length + h.calls.fb.length, 0);
  }
});
