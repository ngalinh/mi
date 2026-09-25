'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const lane = require('../shared/notificationLane');

function load(file, mocks, extra = '') {
  const sandbox = { module: { exports: {} }, console, URL,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
  vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8') + extra, sandbox);
  return sandbox.module.exports;
}

test('Facebook shipping reuses persistent login and waits for its shared browser lock', { timeout: 3000 }, async () => {
  let launches = 0, closes = 0;
  const page = {};
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page], grantPermissions: async () => {},
    close: async () => { closes++; context.emit('close'); },
  });
  const browser = load('../local-runner/browser', {
    fs: { existsSync: () => true }, './config': { dataDir: '/profiles' },
    './accountsStore': { get: () => ({ platform: 'facebook' }) },
    playwright: { chromium: {
      launchPersistentContext: async dir => {
        assert.match(dir, /fb-employee$/); launches++; return context;
      },
      launch: async () => { throw Error('Facebook must not use a storage-state copy'); },
    } },
  });
  await browser.getPage('employee');
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const login = browser.withProfileLock('employee', async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  let sending = false;
  const shipping = lane.run('ship', () => browser.withProfileLock('employee', async () => {
    sending = true;
    assert.equal(lane.current(), 'hang');
    assert.equal(await browser.getPage('employee'), page);
  }));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sending, false, 'shipping cannot navigate during login/arrival');
  } finally { gate.resolve(); }
  await Promise.all([login, shipping]);
  assert.equal(launches, 1);
  assert.equal(await lane.run('ship', () => browser.getPage('employee')), page);
  await lane.run('ship', () => browser.closeContext('employee'));
  assert.equal(closes, 1, 'ship cleanup closes the correct persistent context');
  await lane.run('ship', () => browser.getPage('employee'));
  assert.equal(launches, 2, 'reopening uses the saved Facebook profile');
});

function facebook() {
  return load('../local-runner/facebook', {
    './config': {}, './sendRecovery': {}, './testModeStore': {}, './browser': {},
  }, `
    shot = async () => {};
    waitDomSettled = waitSpinnerGone = waitChatLoaded = async () => {};
    module.exports.findVisible = findVisible;
    module.exports.waitComposeBox = waitComposeBox;
    module.exports.setFinder = fn => { findVisible = fn; };
  `);
}

test('visible Facebook composer is found after a hidden matching editor', async () => {
  const hidden = { isVisible: async () => false };
  const visible = { isVisible: async () => true };
  const page = { locator: () => ({ count: async () => 2, nth: i => [hidden, visible][i] }) };
  assert.equal(await facebook().findVisible(page, ['editor']), visible);
});

test('composer must remain present and editable before entering content', async () => {
  const fb = facebook();
  const page = { waitForTimeout: async () => {} };
  const editor = { getAttribute: async () => 'Write to Customer', isEditable: async () => true };
  fb.setFinder(async () => editor);
  assert.equal(await fb.waitComposeBox(page, 'test'), editor);
  editor.isEditable = async () => false;
  await assert.rejects(fb.waitComposeBox(page, 'test'), /chưa sẵn sàng/);
  let calls = 0;
  fb.setFinder(async () => ++calls === 1 ? editor : null);
  await assert.rejects(fb.waitComposeBox(page, 'test'), /chưa sẵn sàng/);
});
