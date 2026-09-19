'use strict';
// Offline, virtual-clock tests. Never connect to Basso or send customer messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

function harness() {
  let now = 0;
  const clock = { now: () => now };
  const readyContext = { module: { exports: {} }, Date: clock };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../local-runner/bassoReady.js'), 'utf8'), readyContext);
  const ready = readyContext.module.exports;
  const file = path.join(__dirname, '../local-runner/salework.js');
  const mocks = {
    './bassoReady': ready, './config': {}, './sendRecovery': {}, './browser': {},
    './accountsStore': {}, './testModeStore': { get: () => ({ testMode: false }) },
  };
  const context = { module: { exports: {} }, Date: clock, URL, console, __dirname: path.dirname(file),
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : createRequire(file)(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    shot = async () => {};
    module.exports = { clickSend, typeAndSend, waitEntryReady, ensureLoggedIn, searchAndClickConversation };
    clickFilterTab = async () => true;
  `, context);
  return { ready, flow: context.module.exports, now: () => now,
    page: { waitForTimeout: async ms => { now += ms; } } };
}

test('control waits for slow rendering, editing and loading indicator to finish', async () => {
  const h = harness();
  h.page.locator = selector => selector.includes('aria-busy')
    ? { count: async () => h.now() < 8000 ? 1 : 0 }
    : { first: () => ({ isVisible: async () => h.now() >= 4000, isEditable: async () => h.now() >= 6000 }) };
  await h.ready.waitControl(h.page, 'textarea', 'composer', { editable: true });
  assert.equal(h.now(), 9000);
});

test('temporary readiness resets the stable interval', async () => {
  const h = harness();
  await h.ready.waitUntil(h.page, 'state', async () => h.now() < 500 || h.now() >= 2000);
  assert.equal(h.now(), 3000);
});

test('missing UI times out without executing the next step', async () => {
  const h = harness();
  await assert.rejects(h.ready.waitUntil(h.page, 'missing', async () => false), /UI_NOT_READY.*missing/);
  assert.equal(h.now(), 30000);
});

test('blank page waits for delayed login form instead of assuming logged in', async () => {
  const h = harness();
  h.page.locator = selector => selector.includes('aria-busy') ? { count: async () => 0 }
    : { first: () => ({ isVisible: async () => selector.includes('password') && h.now() >= 7000,
      isEditable: async () => selector.includes('password') && h.now() >= 7000 }) };
  await h.flow.waitEntryReady(h.page);
  assert.equal(h.now(), 8000);
});

test('disabled send button waits 10 seconds, then clicks exactly once', async () => {
  const h = harness(); let clicks = 0; let clickedAt;
  h.page.locator = selector => selector.includes('aria-busy') ? { count: async () => 0 }
    : { first: () => ({ isVisible: async () => true, isEnabled: async () => h.now() >= 10000,
      click: async () => { clicks++; clickedAt = h.now(); } }) };
  await h.flow.clickSend(h.page);
  assert.equal(clicks, 1); assert.equal(clickedAt, 11000);
});

test('send never clicks when the button stays disabled', async () => {
  const h = harness(); let clicks = 0;
  h.page.locator = selector => selector.includes('aria-busy') ? { count: async () => 0 }
    : { first: () => ({ isVisible: async () => true, isEnabled: async () => false,
      click: async () => { clicks++; } }) };
  await assert.rejects(h.flow.clickSend(h.page), /UI_NOT_READY/);
  assert.equal(clicks, 0);
});

test('uncertain click is not repeated or sent via another selector', async () => {
  const h = harness(); let clicks = 0;
  h.page.locator = selector => selector.includes('aria-busy') ? { count: async () => 0 }
    : { first: () => ({ isVisible: async () => true, isEnabled: async () => true,
      click: async () => { clicks++; throw Error('Timeout'); } }) };
  await assert.rejects(h.flow.clickSend(h.page), /NEEDS_CHECK/);
  assert.equal(clicks, 1);
});

function searchPage(h, { stale = false, missing = false } = {}) {
  let value = ''; let openedAt = null;
  h.page.locator = selector => selector.includes('aria-busy') ? { count: async () => 0 }
    : { first: () => ({ isVisible: async () => true,
      isEditable: async () => !selector.includes('textarea') || (openedAt !== null && h.now() >= openedAt + 6000),
      fill: async v => { value = v; }, inputValue: async () => value,
      click: async () => { if (stale) throw Error('Timeout: stale row'); openedAt = h.now(); },
    }) };
  h.page.evaluate = async () => missing || h.now() < 10000 ? null
    : { identity: 'customer', x: 200, y: 100, isGroup: true, ambiguous: false };
  return () => openedAt;
}

test('slow search is not declared missing at 3 seconds; composer must then load', async () => {
  const h = harness(); const openedAt = searchPage(h);
  await h.flow.searchAndClickConversation(h.page, { phone: '0900000000' });
  assert.equal(openedAt(), 11000);
  assert.equal(h.now(), 18000);
});

test('stale conversation row fails instead of clicking obsolete coordinates', async () => {
  const h = harness(); searchPage(h, { stale: true });
  h.page.mouse = { click: async () => assert.fail('must not click coordinates') };
  await assert.rejects(h.flow.searchAndClickConversation(h.page, { phone: '0900000000' }), /stale row/);
});

test('missing conversation waits to deadline and never opens another customer', async () => {
  const h = harness(); const openedAt = searchPage(h, { missing: true });
  await assert.rejects(h.flow.searchAndClickConversation(h.page, { phone: '0900000000' }), /KHONG_THAY_HOI_THOAI/);
  assert.equal(openedAt(), null); assert.ok(h.now() >= 30000);
});

for (const confirmed of [true, false]) {
  test(`message confirmation ${confirmed ? 'delayed 20 seconds' : 'never arrives'} does not repeat send`, async () => {
    const h = harness(); let value = ''; let clicks = 0; let clickedAt = null;
    const control = { isVisible: async () => true, isEditable: async () => true, isEnabled: async () => true,
      fill: async v => { value = v; }, inputValue: async () => value, evaluate: async () => {},
      click: async () => { clicks++; clickedAt = h.now(); } };
    h.page.locator = selector => selector.includes('aria-busy') ? { count: async () => 0 }
      : { first: () => control };
    h.page.evaluate = async () => confirmed && clickedAt !== null && h.now() - clickedAt >= 20000 ? 1 : 0;
    if (confirmed) await h.flow.typeAndSend(h.page, 'test');
    else await assert.rejects(h.flow.typeAndSend(h.page, 'test'), /KHONG_XAC_NHAN_DA_GUI/);
    assert.equal(clicks, 1);
    assert.equal(value, 'test');
  });
}
