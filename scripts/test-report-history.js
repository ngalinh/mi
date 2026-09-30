'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

test('history filters before limit and pages older failures without duplicates', () => {
  let database;
  const box = { module: { exports: {} }, console, require: name => {
    if (name === './config') return { dbPath: ':memory:' };
    if (name === 'node:sqlite') return { DatabaseSync: class extends DatabaseSync {
      constructor(p) { super(p); database = this; }
    } };
    return require(name);
  } };
  try {
    vm.runInNewContext(fs.readFileSync(require.resolve('../server/db'), 'utf8'), box);
    const db = box.module.exports;
    const first = db.addReport({ status: 'failed', kind: 'ship', staff: 'Tâm', phone: 'buyer', phoneOriginal: 'recipient', error: 'KHONG_THAY_HOI_THOAI' });
    const second = db.addReport({ status: 'failed', kind: 'ship', staff: 'Tâm' });
    for (let i = 0; i < 210; i++) db.addReport({ status: 'failed', kind: 'hang', staff: 'Other' });
    const filter = { status: 'failed', kind: 'ship', staff: 'Tâm', limit: 1 };
    const page = db.listReportPage(filter);
    assert.equal(page.total, 2);
    assert.equal(page.items[0].id, second.id);
    assert.equal(page.nextCursor, second.id);
    db.addReport({ status: 'failed', kind: 'ship', staff: 'Tâm' });
    const older = db.listReportPage({ ...filter, beforeId: page.nextCursor });
    assert.equal(older.items.length, 1);
    assert.equal(older.items[0].id, first.id);
    assert.equal(older.nextCursor, null);
    assert.equal(db.listReportPage({ q: 'recipient' }).items[0].id, first.id);
    assert.equal(db.listReportPage({ q: 'KHONG_THAY_HOI_THOAI' }).total, 1);
    assert.equal(db.stats(filter).failed, 3);
    db.addReport({ status: 'failed', staff: 'Legacy' });
    assert.equal(db.listReportPage({ kind: 'hang', staff: 'Legacy' }).total, 1);
  } finally { database?.close(); }
});
