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
  let page = {};
  const App = {
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
    friendlyError: s => 'Friendly: ' + s,
    toast: s => toasts.push(s),
    api: async (url, opts) => {
      calls.push({ url, opts });
      if (opts) return resolve(url, opts);
      return { items, ...page };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../server/public/js/settings.js'), 'utf8');
  const context = { $, App, URLSearchParams, window: { confirm: () => confirm }, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("  const logTerm = $('logTerm');"), source.indexOf('  // ---------------- Log HỆ THỐNG')) + '\nthis.loadLog = loadLog;', context);
  const buttons = ['sent', 'not_sent'].map(decision => ({ dataset: { decision }, disabled: false, closest: () => row }));
  const row = { dataset: { reportId: '7' }, querySelectorAll: () => buttons };
  $('logTerm').querySelectorAll = () => [row];
  return { $, calls, toasts, buttons, load: context.loadLog, setItems: value => { items = value; }, setPage: value => { page = value; },
    click: decision => $('logTerm').listeners.click({ target: { closest: () => buttons.find(b => b.dataset.decision === decision) } }),
  };
}

test('error history is read-only and contains no confirmation controls', async () => {
  const h = harness();
  h.setItems([{ id: 7, status: 'needs_check', error: 'NEEDS_CHECK: timeout', zalo_account: '<script>' }]);
  await h.load();
  assert.match(h.$('logTerm').innerHTML, /ERROR/);
  assert.match(h.$('logTerm').innerHTML, /Friendly: NEEDS_CHECK/);
  assert.doesNotMatch(h.$('logTerm').innerHTML, /data-decision|log-resolution|<script>/);
  assert.equal(h.$('logTerm').listeners.click, undefined);
  assert.equal(h.calls.filter(c => c.opts).length, 0);
});

test('history sends filters to API, appends older rows and resets cursor on filter change', async () => {
  const h = harness();
  h.$('logKind').value = 'ship'; h.$('logStaff').value = 'Tâm';
  h.setItems([{ id: 7, status: 'failed', customer_name: 'Newest' }]);
  h.setPage({ total: 2, nextCursor: 7, facets: { staff: ['Tâm', 'Other'] } });
  await h.load();
  let params = new URL(h.calls.at(-1).url, 'https://test').searchParams;
  assert.equal(params.get('kind'), 'ship'); assert.equal(params.get('staff'), 'Tâm');
  assert.equal(h.$('logCount').textContent, '1 / 2 lượt');
  assert.equal(h.$('logMore').hidden, false);
  assert.match(h.$('logStaff').innerHTML, /Other/);
  h.setItems([{ id: 6, status: 'failed', customer_name: 'Older', phone_original: '<original>' }]);
  h.setPage({ total: 2, nextCursor: null });
  await h.load(true);
  params = new URL(h.calls.at(-1).url, 'https://test').searchParams;
  assert.equal(params.get('beforeId'), '7');
  assert.match(h.$('logTerm').innerHTML, /Newest/); assert.match(h.$('logTerm').innerHTML, /Older/);
  assert.doesNotMatch(h.$('logTerm').innerHTML, /<original>/);
  assert.equal(h.$('logCount').textContent, '2 / 2 lượt'); assert.equal(h.$('logMore').hidden, true);
  h.$('logKind').value = 'hang'; h.setItems([]); h.setPage({ total: 0 });
  await h.load({ type: 'change' });
  params = new URL(h.calls.at(-1).url, 'https://test').searchParams;
  assert.equal(params.has('beforeId'), false); assert.equal(params.get('kind'), 'hang');
  assert.doesNotMatch(h.$('logTerm').innerHTML, /Newest|Older/);
});
