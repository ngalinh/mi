'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(api) {
  const elements = new Map(), toasts = [], calls = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, hidden: false, innerHTML: '', textContent: '' });
    return elements.get(id);
  };
  const box = { $, confirm: () => true, checkedIds: () => ['1'],
    state: { orders: [{ id: 1 }], rowAccounts: new Map() }, zaloAccounts: [],
    toApiOrder: o => o, load: () => {},
    App: { icon: () => '', friendlyError: s => s, toast: s => toasts.push(s),
      api: async (url, opts) => { calls.push({ url, opts }); return api(url, opts); } },
  };
  const source = fs.readFileSync(require.resolve('../server/public/js/giaohang.js'), 'utf8');
  vm.createContext(box);
  vm.runInContext(source.slice(source.indexOf('  let bulkNotifyPending'), source.indexOf('  // ---- Events')),
    box);
  return { $, toasts, calls, sync: box.syncBulkNotifyStatus, stop: box.stopBulkNotify, send: box.bulkNotify };
}

test('reload adopts server batch, shows stop and restores send after completion', async () => {
  let running = true, stopping = false;
  const h = harness(async url => {
    if (url.endsWith('/stop')) { stopping = true; return { stopping }; }
    return { running, stopping };
  });
  await h.sync();
  assert.equal(h.$('btnBulkNotify').disabled, true);
  assert.equal(h.$('btnStopBulkNotify').hidden, false);
  assert.equal(h.$('btnStopBulkNotify').disabled, false);
  await h.stop();
  assert.equal(h.$('btnStopBulkNotify').disabled, true);
  assert.match(h.$('bulkNotifyStatus').textContent, /Đang dừng/);
  running = stopping = false;
  await h.sync();
  assert.equal(h.$('btnBulkNotify').disabled, false);
  assert.equal(h.$('btnStopBulkNotify').hidden, true);
});

test('failed stop remains retryable and failed polling preserves stop control', async () => {
  let offline = false;
  const h = harness(async url => {
    if (offline || url.endsWith('/stop')) throw Error('offline');
    return { running: true, stopping: false };
  });
  await h.sync();
  await h.stop();
  assert.equal(h.$('btnStopBulkNotify').disabled, false);
  assert.match(h.toasts.at(-1), /Không dừng được/);
  offline = true;
  await h.sync();
  assert.equal(h.$('btnStopBulkNotify').hidden, false);
  assert.equal(h.$('btnBulkNotify').disabled, true);
});

test('bulk request keeps stop usable, blocks duplicate clicks and reports unsent orders', async () => {
  const response = Promise.withResolvers();
  let running = true;
  const h = harness(async (url, opts) => {
    if (url.endsWith('/send-bulk') && opts) return response.promise;
    if (url.endsWith('/stop')) return { stopping: true };
    return { running, stopping: false };
  });
  const pending = h.send();
  assert.equal(h.$('btnBulkNotify').disabled, true);
  await h.send();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send-bulk')).length, 1);
  assert.equal(h.calls[0].opts.timeoutMs, 30 * 60 * 1000);
  await h.sync();
  assert.equal(h.$('btnStopBulkNotify').disabled, false);
  await h.stop();
  running = false;
  response.resolve({ stopped: true, sent: 1, total: 3, failed: 0, skipped: 2 });
  await pending;
  assert.ok(h.toasts.some(t => /2 đơn chưa gửi/.test(t)));
  assert.equal(h.$('btnBulkNotify').disabled, false);
});

test('client timeout keeps server batch stoppable', async () => {
  const h = harness(async (url, opts) => {
    if (url.endsWith('/send-bulk') && opts) throw Error('timeout');
    return { running: true, stopping: false };
  });
  await h.send();
  assert.equal(h.$('btnBulkNotify').disabled, true);
  assert.equal(h.$('btnStopBulkNotify').hidden, false);
  assert.equal(h.$('btnStopBulkNotify').disabled, false);
});

test('older status response cannot overwrite a newer stopped state', async () => {
  const old = Promise.withResolvers();
  let count = 0;
  const h = harness(async () => ++count === 1 ? old.promise : { running: true, stopping: true });
  const pending = h.sync();
  await h.sync();
  old.resolve({ running: false, stopping: false });
  await pending;
  assert.equal(h.$('btnStopBulkNotify').hidden, false);
  assert.equal(h.$('btnStopBulkNotify').disabled, true);
  assert.match(h.$('bulkNotifyStatus').textContent, /Đang dừng/);
});
