'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('preview uses sender resolver, forwards manual selection and respects contact target', async () => {
  const calls = [];
  const box = { module: { exports: {} }, require: n => ({
    './accountResolver': { resolveForOrder: async (o, opts) => {
      calls.push(opts);
      if (o.id === 3) throw Error('Unavailable');
      return { channel: o.id === 2 ? 'facebook' : 'zalo', account: 'Linh Dương', profile: 'ld', notifyTarget: 'group' };
    } },
    './db': { getContactReportTarget: phone => phone === '123' ? 'personal' : null },
  }[n]) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/notificationPreview.js'), 'utf8'), box);
  const r = await box.module.exports.previewOrders([
    { id: 1, phone: '123', profile: 'ld', account: 'Linh Dương' }, { id: 2 }, { id: 3 },
  ]);
  assert.equal(calls[0].profile, 'ld');
  assert.equal(calls[0].account, 'Linh Dương');
  assert.equal(r[0].target, 'personal');
  assert.equal(r[1].channel, 'facebook');
  assert.equal(r[2].error, 'Unavailable');
});
