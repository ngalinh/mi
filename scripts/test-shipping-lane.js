'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const lane = require('../shared/notificationLane');
const { withLock } = require('../server/lock');
const { createJob, getJob } = require('../local-runner/jobQueue');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('shipping lock bypasses arrival and serializes other shipping work after errors', async () => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const arrival = withLock(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  try {
    const events = [];
    await Promise.all([
      assert.rejects(withLock(async () => { events.push(1); await tick(); events.push(2); throw Error('test'); }, 'ship')),
      withLock(() => { events.push(3); assert.equal(lane.current(), 'ship'); }, 'ship'),
    ]);
    assert.deepEqual(events, [1, 2, 3]);
  } finally { gate.resolve(); await arrival; }
});

test('runner dispatches shipping while arrival job is running, with FIFO per lane', async () => {
  const gate = Promise.withResolvers();
  const first = createJob({}, () => gate.promise);
  const second = createJob({}, async () => 'arrival 2');
  const ship = createJob({ browserLane: 'ship' }, async () => lane.current());
  await tick();
  try {
    assert.equal(getJob(first).status, 'running');
    assert.equal(getJob(second).status, 'queued');
    assert.equal(getJob(ship).status, 'done');
    assert.equal(getJob(ship).result, 'ship');
  } finally { gate.resolve(); await tick(); }
  assert.equal(getJob(second).status, 'done');
});

test('shipping opens a separate browser with login state and closes only its own browser', async () => {
  let arrivalCloses = 0, shipCloses = 0, launches = 0;
  const state = { cookies: [{ name: 'session' }], origins: [] };
  const context = () => Object.assign(new EventEmitter(), {
    pages: () => [{}], grantPermissions: async () => {}, storageState: async () => state,
  });
  const arrival = context();
  arrival.close = async () => { arrivalCloses++; arrival.emit('close'); };
  const ship = context();
  const process = Object.assign(new EventEmitter(), {
    newContext: async opts => { assert.equal(opts.storageState, state); return ship; },
    close: async () => { shipCloses++; process.emit('disconnected'); },
  });
  const mocks = {
    fs: { existsSync: () => true }, './config': { dataDir: '/tmp/profiles' },
    './accountsStore': { get: () => ({ proxy: 'localhost:1234' }) },
    playwright: { chromium: {
      launchPersistentContext: async () => arrival,
      launch: async opts => { launches++; assert.equal(opts.proxy.server, 'http://localhost:1234'); return process; },
    } },
  };
  const box = { module: { exports: {} }, console, require: name => mocks[name] || require(name) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../local-runner/browser'), 'utf8'), box);
  const browser = box.module.exports;
  await browser.getContext('X');
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const held = browser.withProfileLock('X', async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  try {
    await lane.run('ship', () => browser.withProfileLock('X', async () => {
      assert.equal(await browser.getContext('X'), ship);
      assert.equal(await browser.getContext('X'), ship);
      assert.equal(launches, 1);
      await browser.closeContext('X');
    }));
    assert.equal(shipCloses, 1);
    assert.equal(arrivalCloses, 0);
    assert.equal(await browser.getContext('X'), arrival);
  } finally { gate.resolve(); await held; await browser.closeAll(); }
  assert.equal(arrivalCloses, 1);
});
