'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '../server/public/js/giaohang.js'), 'utf8');
function setup(orders, options = {}) {
  const elements = Object.fromEntries(Object.entries({
    fCarrier: '3', fStatus: 'exported', fStaff: 'Tam', fDate: '2026-09-23',
    fQ: ' ABC ', fPreparedDate: options.preparedDate || '', btnNotifyFiltered: '', btnBulkNotify: '',
  }).map(([key, value]) => [key, { value, innerHTML: key, disabled: false }]));
  const requests = [], messages = [];
  let confirms = 0;
  const context = vm.createContext({
    URLSearchParams, Set, $: id => elements[id],
    state: { branch: 'ha-noi', rowAccounts: new Map([['21', 'manual']]) },
    zaloAccounts: [{ key: 'manual', name: 'Chosen' }], acctSendName: a => a.name,
    load: () => {}, confirm: () => { confirms++; return options.confirm !== false; },
    App: { friendlyError: s => s, toast: s => messages.push(s), api: async (url, opts) => {
      requests.push({ url, body: opts && JSON.parse(opts.body) });
      if (!opts) { if (options.fetchError) throw Error('fetch failed'); return { orders }; }
      if (options.sendError) throw Error('send failed');
      const batch = JSON.parse(opts.body).orders;
      return { total: batch.length, sent: batch.length, failed: 0, results: [] };
    } },
  });
  for (const [start, end] of [
    ['  function baseParams()', '  // Lọc theo NGÀY SOẠN HÀNG:'],
    ['  function canPreviewMsg(', '  // Cột "ND ship":'],
    ['  function toApiOrder(', '  let msgCurrentId'],
    ['  function withRowAccountOverride(', '  async function bulkNotify()'],
    ['  async function fetchFilteredOrders(', '  function bind()'],
  ]) vm.runInContext(client.slice(client.indexOf(start), client.indexOf(end)), context);
  return { context, requests, elements, messages, confirmations: () => confirms };
}
const order = id => ({ id, statusCode: 'exported', items: [], preparedAt: '23/09/2026 10:00' });
test('all-page selection retains all filters, skips sent/ineligible, deduplicates and batches', async () => {
  const s = setup([...Array.from({ length: 25 }, (_, i) => order(i + 1)), order(1),
    { ...order(30), shipSentAt: 'sent' }, { ...order(31), statusCode: 'waiting' }]);
  await vm.runInContext('notifyFiltered()', s.context);
  const params = new URL(s.requests[0].url, 'http://test').searchParams;
  assert.deepEqual(Object.fromEntries(params), { shipping_id: '3', status: 'exported', user_approve: 'Tam', filter_date: '2026-09-23', key: 'ABC', branch: 'ha-noi' });
  assert.deepEqual(s.requests.slice(1).map(r => r.body.orders.length), [20, 5]);
  assert.equal(s.requests[2].body.orders[0].profile, 'manual');
  assert.equal(s.elements.btnNotifyFiltered.disabled, false);
});
test('prepared-date filter ignores creation date and includes only exact prepared day', async () => {
  const s = setup([order(1), { ...order(2), preparedAt: '22/09/2026 10:00' }, { ...order(3), preparedAt: '' }], { preparedDate: '2026-09-23' });
  await vm.runInContext('notifyFiltered()', s.context);
  assert.equal(s.requests[0].url.includes('filter_date'), false);
  assert.deepEqual(s.requests[1].body.orders.map(o => o.id), [1]);
});
test('empty, cancellation and fetch failure never send; errors restore buttons', async () => {
  for (const [orders, options] of [[[], {}], [[order(1)], { confirm: false }], [[order(1)], { fetchError: true }]]) {
    const s = setup(orders, options);
    await vm.runInContext('notifyFiltered()', s.context);
    assert.equal(s.requests.length, 1);
    assert.equal(s.elements.btnNotifyFiltered.disabled, false);
    assert.equal(s.elements.btnBulkNotify.disabled, false);
  }
});
test('send failure stops subsequent batches and repeated clicks do not start another run', async () => {
  const s = setup(Array.from({ length: 25 }, (_, i) => order(i)), { sendError: true });
  await vm.runInContext('Promise.all([notifyFiltered(), notifyFiltered()])', s.context);
  assert.equal(s.requests.length, 2);
  assert.equal(s.confirmations(), 1);
  assert.equal(s.elements.btnNotifyFiltered.disabled, false);
});
const api = fs.readFileSync(path.join(__dirname, '../server/shippingApi.js'), 'utf8').replace(/\r\n/g, '\n');
const allFn = api.slice(api.indexOf('async function fetchAllShippingOrders('), api.indexOf('/**\n * DEBUG'));
test('fetches beyond 100 pages with unchanged filters', async () => {
  let calls = 0;
  const c = vm.createContext({ config: { basso: { useMock: false } }, getShippingOrders: async filters => {
    calls++; assert.equal(filters.branch, 'ha-noi');
    return { orders: [{ id: filters.page }], total: 101, pageSize: 1 };
  } });
  vm.runInContext(allFn, c);
  const result = await vm.runInContext("fetchAllShippingOrders({branch: 'ha-noi'})", c);
  assert.equal(result.orders.length, 101);
  assert.equal(calls, 101);
});
test('repeated full page fails instead of returning a partial selection', async () => {
  const c = vm.createContext({ config: { basso: { useMock: false } }, getShippingOrders: async () => ({ orders: [{ id: 1 }], total: 101, pageSize: 1 }) });
  vm.runInContext(allFn, c);
  await assert.rejects(vm.runInContext('fetchAllShippingOrders()', c), /trùng lặp/);
});
