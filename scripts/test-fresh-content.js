'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function api(rowsFor) {
  const calls = [];
  const box = { module: { exports: {} }, __dirname, URL, URLSearchParams, console,
    require: name => {
      if (name === './config') return { basso: { baseUrl: 'https://basso.test', listCacheTtlMs: 60000 } };
      if (name === 'node-fetch') return async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/login')) return { ok: true, json: async () => ({ data: { access_token: 'test' } }) };
        calls.push(u);
        return { ok: true, json: async () => ({ data: await rowsFor(u) }) };
      };
      return require(name);
    } };
  vm.runInNewContext(read('server/bassoApi.js'), box);
  return { ...box.module.exports, calls };
}
const key = { customerId: 1, dateInventory: 1780000000, fresh: true };
test('content lookup finds exact customer/date beyond page one, without a phone', async () => {
  const h = api(u => Number(u.searchParams.get('page')) === 1
    ? { rows: Array.from({ length: 100 }, (_, i) => ({ customer_id: i + 2, date_inventory: key.dateInventory })), total: 101 }
    : { rows: [{ customer_id: 1, date_inventory: key.dateInventory, content: 'new debt' }], total: 101 });
  const r = await h.getOrderContent(key);
  assert.equal(r.noiDungBaoHang, 'new debt');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].searchParams.get('from'), h.calls[0].searchParams.get('to'));
  assert.ok(h.calls[0].searchParams.get('from'));
});
test('a single wrong row never becomes the selected customer content', async () => {
  const h = api(() => ({ rows: [{ customer_id: 999, date_inventory: key.dateInventory, content: 'wrong customer debt' }] }));
  assert.equal((await h.getOrderContent(key)).found, false);
});
test('fresh read replaces cached content including an empty value', async () => {
  let content = 'old';
  const h = api(() => ({ rows: [{ customer_id: 1, date_inventory: key.dateInventory, content }] }));
  assert.equal((await h.getOrderContent(key)).noiDungBaoHang, 'old');
  content = '';
  const r = await h.getOrderContent(key);
  assert.equal(r.found, true);
  assert.equal(r.noiDungBaoHang, '');
  assert.equal(h.calls.length, 2);
});
test('modal sends no override for unchanged Basso text, preserving explicit edits', async () => {
  const src = read('server/public/js/dashboard.js');
  const body = src.slice(src.indexOf('  async function sendFromModal()'), src.indexOf('  // ---------------- Gửi Zalo'));
  for (const edited of [false, true]) {
    const el = { modalAccount: { value: '' }, modalKenhSale: { value: '' }, modalMsg: { value: edited ? 'custom' : 'old debt', dataset: { bassoContent: 'old debt' } }, modalSend: {} };
    let override;
    const ctx = { modalId: '1', modalKind: 'hang', $: id => el[id], closeModal() {}, sendZalo: async (_id, text) => { override = text; } };
    vm.createContext(ctx); vm.runInContext(body, ctx);
    await ctx.sendFromModal();
    assert.equal(override, edited ? 'custom' : undefined);
  }
});
test('history retry fetches new content instead of overriding with stored debt', async () => {
  const src = read('server/index.js');
  const body = src.slice(src.indexOf("app.post('/api/reports/:id/retry'"), src.indexOf('// Fail-closed: production'));
  let handler, opts;
  const ctx = { app: { post: (_p, h) => { handler = h; } }, getReportById: () => ({ status: 'failed', customer_id: 1, date_inventory: key.dateInventory, message: 'old debt' }),
    getActor: () => 'test', notifyOrders: async (_orders, o) => { opts = o; return {}; } };
  vm.runInNewContext(body, ctx);
  await handler({ params: { id: 1 } }, { json() {}, status() { return this; } });
  assert.equal(opts.messageOverride, undefined);
});
