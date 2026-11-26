'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const route = server.slice(server.indexOf("app.post('/api/notify-all',"), server.indexOf('// ---- Dừng báo hàng loạt'));
const dashboard = fs.readFileSync(path.join(root, 'server/public/js/dashboard.js'), 'utf8');
const payloadFn = dashboard.slice(dashboard.indexOf('  function canSelectBulk(o)'), dashboard.indexOf('  // Nhãn/nút mặc định'));
const orders = [
  { id: '1', saleChannelLabel: 'Basso', userId: 1, customerName: 'An', phone: '123' },
  { id: '2', saleChannelLabel: 'Linh Dương', userId: 1, customerName: 'An', phone: '123' },
  { id: '3', saleChannel: 'Basso', userId: 1, customerName: 'An', phone: '123' },
  { id: '4', userId: 1, customerName: 'An', phone: '123' },
];
async function run(body, delayed = new Set(), records = {}) {
  let handler, fetched = 0, sent = [], result;
  vm.runInNewContext(route, {
    app: { post: (url, fn) => { handler = fn; } },
    getActor: () => 'tester',
    fetchAllOrders: async () => { fetched++; return orders; },
    getDelayedMap: () => delayed,
    autoNotify: { autoKey: o => o.id },
    getAutoRecord: id => records[id],
    notifyOrders: async targets => { sent = targets.map(o => o.id); return { total: sent.length }; },
  });
  await handler({ body }, { json: value => { result = value; }, status: () => { throw Error('Unexpected route error'); } });
  return { fetched, sent: Array.from(sent), result };
}
test('selected payload excludes unticked, hidden, delayed and notified orders; keeps account override', () => {
  const context = {
    visibleOrders: () => orders,
    selectedOrders: new Set(['1', '3', '4', 'hidden']), excluded: new Set(['4']),
    groupOf: o => o.id === '3' ? 'done' : 'todo', orderPayload: o => ({ ...o }),
    withRowAccountOverride: o => ({ ...o, profile: 'manual-account' }),
  };
  vm.createContext(context);
  vm.runInContext(payloadFn + '; result = selectedBulkPayloads();', context);
  assert.deepEqual(Array.from(context.result, o => o.id), ['1']);
  assert.equal(context.result[0].profile, 'manual-account');
  context.selectedOrders.clear();
  vm.runInContext('result = selectedBulkPayloads();', context);
  assert.equal(context.result.length, 0);
});
test('select-all reflects partial, full and empty selection', () => {
  const header = {};
  const context = {
    visibleOrders: () => orders, selectedOrders: new Set(['1']), excluded: new Set(['4']),
    groupOf: () => 'todo', $: () => header, updateCount: () => {},
  };
  vm.createContext(context);
  vm.runInContext(payloadFn + '; syncSelection();', context);
  assert.equal(header.indeterminate, true);
  assert.equal(header.checked, false);
  context.selectedOrders.add('2'); context.selectedOrders.add('3');
  vm.runInContext('syncSelection();', context);
  assert.equal(header.checked, true);
  assert.equal(header.indeterminate, false);
  context.visibleOrders = () => [];
  vm.runInContext('syncSelection();', context);
  assert.equal(header.disabled, true);
  assert.equal(header.checked, false);
});
test('server filters fetched full set by actual sale channel', async () => {
  const r = await run({ saleChannel: 'Basso' });
  assert.equal(r.fetched, 1);
  assert.deepEqual(r.sent, ['1', '3']);
});
test('server also filters supplied orders and retains delay/already-notified protection', async () => {
  const r = await run({ orders, saleChannel: 'Basso' }, new Set(['1']), { '3': { status: 'success' } });
  assert.equal(r.fetched, 0);
  assert.deepEqual(r.sent, []);
  assert.equal(r.result.total, 0);
});
test('explicit empty selection never falls back to fetching all customers', async () => {
  const r = await run({ orders: [], saleChannel: 'Basso' });
  assert.equal(r.fetched, 0);
  assert.equal(r.result.total, 0);
});
test('no channel filter preserves all-channel behavior', async () => {
  assert.deepEqual((await run({})).sent, ['1', '2', '3', '4']);
});
test('channel with no matches sends nothing', async () => {
  assert.equal((await run({ saleChannel: 'Unknown' })).result.total, 0);
});
