'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { canTryNextAccount, sendFacebookWithFallback } = require('../server/accountFallback');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const accounts = [
  { key: 'z', platform: 'zalo', name: 'Same', staffId: '1', saleworkName: 'Same' },
  { key: 'f1', platform: 'facebook', name: 'Same', staffId: '1', fbName: 'Same' },
  { key: 'f2', platform: 'facebook', name: 'Other', staffId: '2', sharedStaffIds: ['1'], fbName: 'Shared', kenhSale: 'Basso' },
  { key: 'foreign', platform: 'facebook', name: 'Foreign', staffId: '3', fbName: 'Foreign' },
];
function resolver(lists = [accounts]) {
  let refreshes = 0;
  const box = { module: { exports: {} }, require: name => ({
    './config': { zaloAccountForOrder: () => null },
    './playwrightProxy': { getAccountsCached: async () => lists[Math.min(refreshes, lists.length - 1)], invalidateAccountsCache: () => { refreshes++; } },
    './bassoApi': {}, './db': { isFacebookOrder: () => true, getContactKenhSale: () => '' },
  })[name] };
  vm.runInNewContext(read('server/accountResolver.js'), box);
  return { resolve: box.module.exports.resolveForOrder, refreshes: () => refreshes };
}
test('explicit FB key beats same-name Zalo and never gets fallback accounts', async () => {
  const r = await resolver().resolve({}, { profile: 'f1', account: 'Same' });
  assert.equal(r.channel, 'facebook');
  assert.equal(r.profile, 'f1');
  assert.equal(r.fallbackAccounts, undefined);
});
test('missing explicit account refreshes once and resolves newly available FB', async () => {
  const h = resolver([[], accounts]);
  assert.equal((await h.resolve({}, { profile: 'f1', account: 'Same' })).channel, 'facebook');
  assert.equal(h.refreshes(), 1);
});
test('missing explicit key never falls back to another account with the same name', async () => {
  const h = resolver();
  await assert.rejects(h.resolve({}, { profile: 'deleted', account: 'Same' }), /ACCOUNT_NOT_FOUND/);
  assert.equal(h.refreshes(), 1);
});
test('ambiguous name or empty account store fails closed', async () => {
  await assert.rejects(resolver().resolve({}, { account: 'Same' }), /ACCOUNT_NOT_FOUND/);
  await assert.rejects(resolver([[]]).resolve({}, { profile: 'f1', account: 'Same' }), /ACCOUNT_NOT_FOUND/);
});
test('FB candidates preserve sale-channel priority and staff/shared ownership', async () => {
  const r = await resolver().resolve({ userId: '1', phone: '1', saleChannel: 'Basso' });
  assert.equal(r.profile, 'f2');
  assert.deepEqual(Array.from(r.fallbackAccounts, a => a.profile), ['f1']);
});
test('manual FB choice does not use fallback even if a caller supplies one', async () => {
  const calls = [];
  const r = { channel: 'facebook', profile: 'X', source: 'explicit', fallbackAccounts: [{ channel: 'facebook', profile: 'Y' }] };
  await sendFacebookWithFallback(async p => { calls.push(p.profile); return { ok: false, error: 'CHUA_DANG_NHAP: FB' }; }, r, {});
  assert.deepEqual(calls, ['X']);
});
test('uncertain second FB attempt records the actual account without a third send', async () => {
  const calls = [];
  const r = { channel: 'facebook', profile: 'X', account: 'X', fallbackAccounts: ['Y','Z'].map(profile => ({ channel: 'facebook', profile, account: profile })) };
  const result = await sendFacebookWithFallback(async p => { calls.push(p.profile); return { ok: false, error: p.profile === 'X' ? 'FB: missing composer' : 'NEEDS_CHECK: unknown' }; }, r, {});
  assert.deepEqual(calls, ['X','Y']);
  assert.equal(r.account, 'Y');
  assert.match(result.error, /^NEEDS_CHECK/);
});
test('only known pre-send failures can advance to another account', () => {
  for (const channel of ['facebook','zalo']) {
    for (const e of ['NEEDS_CHECK: CHUA_DANG_NHAP: unknown', 'KHONG_XAC_NHAN_DA_GUI: unknown', 'timeout', 'TEST_MODE: blocked', 'Local-runner từ chối (403)']) assert.equal(canTryNextAccount(e, channel), false);
    assert.equal(canTryNextAccount('ACCOUNT_UNAVAILABLE: browser closed', channel), true);
  }
  assert.equal(canTryNextAccount('FB: no composer', 'zalo'), false);
  assert.equal(canTryNextAccount('KHONG_THAY_HOI_THOAI: missing', 'facebook'), false);
});
test('error display preserves Facebook login and uncertain delivery meaning', () => {
  const s = read('server/public/js/app.js');
  const app = vm.runInNewContext('({' + s.slice(s.indexOf('  friendlyError(msg) {'), s.indexOf('  esc(s)')) + '})');
  assert.match(app.friendlyError('CHUA_DANG_NHAP: Session Facebook đã hết hạn'), /Phiên Facebook/);
  assert.doesNotMatch(app.friendlyError('Local-runner từ chối (404): /api/facebook/send'), /Zalo/);
  assert.match(app.friendlyError('NEEDS_CHECK: hết thời gian chờ local-runner'), /Chưa xác định/);
});

test('SQLite persists fallback account/channel and keeps them on later status updates', () => {
  const { DatabaseSync } = require('node:sqlite');
  let database;
  const box = { module: { exports: {} }, console, require: name => {
    if (name === './config') return { dbPath: ':memory:' };
    if (name === 'node:sqlite') return { DatabaseSync: class extends DatabaseSync {
      constructor(p) { super(p); database = this; }
    } };
    return require(name);
  } };
  try {
    vm.runInNewContext(read('server/db.js'), box);
    const db = box.module.exports;
    const row = db.addReport({ phone: '1', channel: 'zalo', zaloAccount: 'X', status: 'pending' });
    db.updateReport(row.id, { channel: 'facebook', zaloAccount: 'FB Y', status: 'needs_check' });
    const result = db.updateReport(row.id, { error: 'check conversation' });
    assert.equal(result.channel, 'facebook');
    assert.equal(result.zalo_account, 'FB Y');
    assert.equal(result.status, 'needs_check');
  } finally { database?.close(); }
});
