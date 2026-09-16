'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'server/public/js/dashboard.js'), 'utf8');
const payloadCode = dashboard.slice(dashboard.indexOf('  const orderPayload ='), dashboard.indexOf('  // ---------------- Tabs nhân viên'));
const bulkCode = dashboard.slice(dashboard.indexOf('  function bulkTodoPayloads()'), dashboard.indexOf('  // Nhãn/nút mặc định'));
const resolverCode = fs.readFileSync(path.join(root, 'server/accountResolver.js'), 'utf8');
const order = { id: 'arrival-1', userId: 42, staff: 'Trân', saleChannelLabel: 'Basso', customerName: 'Khách', phone: '0900000000' };
const accounts = [
  { key: 'general', name: 'Chung', saleworkName: 'Zalo khác' },
  { key: 'basso', name: 'Bình', staffId: 7, sharedStaffIds: ['42'], saleworkName: 'Zalo Basso', kenhSale: 'Basso' },
];
function payloads() {
  const context = { allOrders: [order], currentStaff: '', currentChannel: 'Basso', $: () => ({ value: '' }),
    orderCodeOf: () => undefined, saleChannelOf: o => o.saleChannelLabel, groupOf: () => 'todo', withRowAccountOverride: p => p };
  vm.createContext(context);
  vm.runInContext(payloadCode + bulkCode + '; single = orderPayload(allOrders[0]); bulk = bulkTodoPayloads();', context);
  return context;
}
function resolver() {
  const context = { module: { exports: {} }, require: name => {
    if (name === './config') return { zaloAccountForOrder: () => null };
    if (name === './playwrightProxy') return { getAccountsCached: async () => accounts };
    if (name === './bassoApi') return { getArrivedItems: async () => ({ items: [] }) };
    if (name === './db') return { isFacebookOrder: () => false, getContactKenhSale: () => '' };
    throw Error(name);
  } };
  vm.runInNewContext(resolverCode, context);
  return context.module.exports.resolveForOrder;
}
test('single notification retains staff ID and resolves shared Basso account', async () => {
  const { single } = payloads();
  assert.equal(single.userId, 42);
  assert.equal((await resolver()(single)).profile, 'basso');
});
test('bulk notification retains staff ID and resolves shared Basso account', async () => {
  const { bulk } = payloads();
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].userId, 42);
  assert.equal((await resolver()(bulk[0])).account, 'Zalo Basso');
});
test('explicitly chosen account still takes precedence', async () => {
  const { single } = payloads();
  assert.equal((await resolver()(single, { profile: 'general', account: 'Zalo khác' })).profile, 'general');
});
