'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(service, skip = false, ownerError = false) {
  const logs = [], reports = [], sends = [];
  const deps = {
    '../shared/sendTrace': { log: (event, details) => logs.push({ event, ...details }) },
    './notificationHold': { getHold: () => null },
    './accountQueue': { once: (_, fn) => fn() },
    './accountFallback': {},
    './config': {},
    '../shared/notificationLane': { current: () => 'hang' },
    '../shared/messageTemplate': { buildBaoHangMessage: () => 'private-message' },
    './shippingNotify': { buildDeliveryMessage: () => ({ sendable: true, message: 'private-message' }) },
    './bassoApi': { getArrivedItems: async () => ({ items: [] }), findCustomerByOrderCode: async () => { throw Error('OWNER_LOOKUP_FAILED'); } },
    './playwrightProxy': { sendBaoHang: () => sends.push('zalo'), sendBaoHangFb: () => sends.push('facebook') },
    './accountResolver': { resolveForOrder: async () => {
      if (skip) return { skip: true, skipReason: 'fb_no_account', channel: 'facebook' };
      throw Error('ACCOUNT_NOT_FOUND: missing');
    } },
    './db': { getShippingNotified: () => null, getShippingTemplates: () => ({}),
      getFbLink: () => '', getZaloName: () => '', getContactReportTarget: () => '',
      autoKey: () => 'key', autoKeyShip: () => 'ship-key',
      addReport: row => { const report = { id: reports.length + 1, ...row }; reports.push(report); return report; } },
    './lock': { withLock: fn => fn() },
    'node:crypto': require('node:crypto'),
  };
  const box = { module: { exports: {} }, console: { log() {}, warn() {} },
    require: name => { assert.ok(name in deps, name); return deps[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server', service), 'utf8'), box);
  const order = { id: 123, orderCode: 'ORDER123', trackingCode: 'HU26110931', shippingId: ownerError ? 3 : 1, items: [{ orderCode: 'ORDER123' }] };
  return { logs, reports, sends, run: () => (box.module.exports.notifyOne || box.module.exports.sendShippingOne)(order, { actor: 'auto-test' }) };
}
for (const service of ['notifyService.js', 'shippingSendService.js']) {
  for (const skip of [false, true]) test(`${service}: ${skip ? 'missing channel account' : 'resolver exception'} records reason and report correlation`, async () => {
    const h = harness(service, skip);
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].status, 'failed');
    const log = h.logs.find(e => e.event.endsWith('.preflight-failed'));
    assert.equal(log.reportId, result.report.id);
    assert.equal(log.error, result.error);
    assert.equal(log.stage, 'resolve-account');
    assert.equal(log.outcome, 'not-sent');
    assert.equal(log.actor, 'auto-test');
    assert.equal(log.orderId, 123);
    assert.ok(log.traceId);
    assert.equal(h.sends.length, 0);
    assert.ok(!JSON.stringify(h.logs).includes('private-message'));
  });
}
test('AhaMove owner lookup warning continues to account resolution with same trace', async () => {
  const h = harness('shippingSendService.js', false, true);
  await h.run();
  const warning = h.logs.find(e => e.event === 'shipping.owner-lookup-warning');
  const failure = h.logs.find(e => e.event === 'shipping.preflight-failed');
  assert.equal(warning.error, 'OWNER_LOOKUP_FAILED');
  assert.equal(warning.trackingCode, 'HU26110931');
  assert.equal(warning.outcome, 'continue-account-resolution');
  assert.equal(warning.traceId, failure.traceId);
  assert.equal(h.reports.length, 1);
});
