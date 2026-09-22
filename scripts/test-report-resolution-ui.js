'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ confirm = true, resolve = async () => ({ ok: true }) } = {}) {
  const elements = new Map(), calls = [], toasts = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', dataset: {}, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelectorAll() { return []; },
    });
    return elements.get(id);
  };
  let items = [{ id: 7, status: 'needs_check', error: 'NEEDS_CHECK: timeout', message: 'hello', zalo_account: 'Account X' }];
  const App = {
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
    friendlyError: s => 'Friendly: ' + s,
    toast: s => toasts.push(s),
    api: async (url, opts) => {
      calls.push({ url, opts });
      if (opts) return resolve(url, opts);
      return { items };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../server/public/js/settings.js'), 'utf8');
  const context = { $, App, URLSearchParams, window: { confirm: () => confirm }, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("  const logTerm = $('logTerm');"), source.indexOf('  // ---------------- Log HỆ THỐNG')) + '\nthis.loadLog = loadLog;', context);
  const buttons = ['sent', 'not_sent'].map(decision => ({ dataset: { decision }, disabled: false, closest: () => row }));
  const row = { dataset: { reportId: '7' }, querySelectorAll: () => buttons };
  $('logTerm').querySelectorAll = () => [row];
  return { $, calls, toasts, buttons, load: context.loadLog, setItems: value => { items = value; },
    click: decision => $('logTerm').listeners.click({ target: { closest: () => buttons.find(b => b.dataset.decision === decision) } }),
  };
}

test('uncertain history shows reason, escaped account, and recovery controls; sent_check cannot release a hold', async () => {
  const h = harness();
  h.setItems([{ id: 7, status: 'needs_check', error: 'NEEDS_CHECK: timeout', zalo_account: '<script>' }]);
  await h.load();
  assert.match(h.$('logTerm').innerHTML, /CẦN KT/);
  assert.match(h.$('logTerm').innerHTML, /Friendly: NEEDS_CHECK/);
  assert.match(h.$('logTerm').innerHTML, /data-decision="not_sent"/);
  assert.doesNotMatch(h.$('logTerm').innerHTML, /<script>/);
  h.setItems([{ id: 8, status: 'sent_check', error: 'update failed' }]);
  await h.load();
  assert.match(h.$('logTerm').innerHTML, /ĐÃ GỬI/);
  assert.doesNotMatch(h.$('logTerm').innerHTML, /data-decision/);
});

for (const decision of ['sent', 'not_sent']) {
  test(`${decision} only resolves the report and reloads history without sending`, async () => {
    const h = harness();
    await h.click(decision);
    const writes = h.calls.filter(c => c.opts);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, '/api/reports/7/resolve-uncertain');
    assert.equal(writes[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(writes[0].opts.body), { decision });
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[1].url.startsWith('/api/reports?'));
  });
}

test('cancel makes no request', async () => {
  const h = harness({ confirm: false });
  await h.click('not_sent');
  assert.equal(h.calls.length, 0);
});

test('double click and opposite decision cannot submit while pending, including after reload', async () => {
  const gate = Promise.withResolvers();
  const h = harness({ resolve: () => gate.promise });
  const pending = h.click('not_sent');
  assert.ok(h.buttons.every(b => b.disabled));
  await h.load();
  assert.match(h.$('logTerm').innerHTML, /data-decision="sent" disabled/);
  await h.click('sent');
  await h.click('not_sent');
  assert.equal(h.calls.filter(c => c.opts).length, 1);
  gate.resolve({ ok: true });
  await pending;
  assert.ok(h.buttons.every(b => !b.disabled));
});

test('rejected resolution keeps the row and allows another attempt', async () => {
  const h = harness({ resolve: async () => { throw Error('Chỉ Admin'); } });
  await h.load();
  const before = h.$('logTerm').innerHTML;
  await h.click('sent');
  assert.equal(h.$('logTerm').innerHTML, before);
  assert.match(h.toasts.at(-1), /Chỉ Admin/);
  assert.ok(h.buttons.every(b => !b.disabled));
  await h.click('sent');
  assert.equal(h.calls.filter(c => c.opts).length, 2);
});
