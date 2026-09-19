'use strict';
// Offline regression tests: no login and no real customer messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function load(file, mocks, extra = '') {
  const filename = path.join(__dirname, '..', file);
  const sandbox = { module: { exports: {} }, console, URL, process, __dirname: path.dirname(filename),
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + extra, sandbox, { filename });
  return sandbox.module.exports;
}

(async () => {
  const deadline = setTimeout(() => { console.error('FAIL: profile lock did not release'); process.exit(1); }, 5000);
  const config = { saleworkChatUrl: 'https://zalo.basso.vn/chat', closeAfterSend: false };
  let navigations = 0;
  let closes = 0;
  let selected = 'Thuỷ Trang';
  let sends = 0;
  const searches = [];
  const page = {
    url: () => config.saleworkChatUrl,
    locator: () => ({ first: () => ({ isVisible: async () => true }) }),
    goto: async () => { navigations++; }, waitForTimeout: async () => {},
  };
  const salework = load('local-runner/salework.js', {
    './sendRecovery': { prepareWithRetry: async (_profile, prepare) => { await prepare(page); return { page }; } },
    './config': config, './testModeStore': { get: () => ({ testMode: false }) }, './accountsStore': {},
    './browser': { getPage: async () => page, closeContext: async () => { closes++; },
      withProfileLock: async (_profile, fn) => fn() },
  }, `
    shot = async () => {};
    module.exports.selectAccount = selectZaloAccount;
    module.exports.inject = (hooks) => {
      ensureLoggedIn = hooks.login;
      selectZaloAccount = hooks.account;
      searchAndClickConversation = hooks.search;
      typeAndSend = hooks.send;
    };
  `);
  let dropdownClicks = 0;
  const accountPage = { locator: () => ({ first: () => ({ count: async () => 1,
    textContent: async () => 'Thuỷ Trang', click: async () => { dropdownClicks++; } }) }) };
  assert.equal(await salework.selectAccount(accountPage, 'Thuỷ Trang'), true);
  assert.equal(dropdownClicks, 0, 'matching selected account skips dropdown interaction');
  salework.inject({ login: async () => ({}), account: async (_page, account) => { selected = account; return true; },
    search: async (_page, customer) => { searches.push([selected, customer.name]); },
    send: async () => { sends++; } });
  for (const name of ['Khách A', 'Khách B']) {
    await salework.sendBaoHang({ account: 'Thuỷ Trang', name, message: 'Test', strictMatch: true });
  }
  assert.equal(navigations, 0, 'two customers reuse the ready chat without reload');
  assert.equal(closes, 0, 'browser stays open after the last customer');
  await salework.sendBaoHang({ account: 'Khác', name: 'Khách C', message: 'Test', strictMatch: true });
  assert.deepEqual(searches, [['Thuỷ Trang', 'Khách A'], ['Thuỷ Trang', 'Khách B'], ['Khác', 'Khách C']]);
  await assert.rejects(salework.sendBaoHang({ name: 'Khách D', message: 'Test', strictMatch: true }), /KHONG_RO_TAI_KHOAN/);
  assert.equal(sends, 3, 'unknown account must not send');
  page.url = () => 'about:blank';
  await salework.gotoSalework(page);
  assert.equal(navigations, 1, 'a new page navigates to chat');
  page.url = () => config.saleworkChatUrl;
  page.locator = () => ({ first: () => ({ isVisible: async () => false }) });
  await salework.gotoSalework(page);
  assert.equal(navigations, 2, 'unready chat is recovered by navigation');
  config.closeAfterSend = true;
  await salework.sendBaoHang({ account: 'Khác', name: 'Khách C', message: 'Test' });
  assert.equal(closes, 1, 'explicit close setting remains supported');
  config.closeAfterSend = false;
  await salework.sendBaoHang({ account: 'Khác', name: 'Khách C', message: 'Test', closeAfterSend: true });
  assert.equal(closes, 2, 'single notification closes even with legacy keep-open config');
  await salework.sendBaoHang({ account: 'Khác', name: 'Khách C', message: 'Test', closeAfterSend: true, keepContext: true });
  assert.equal(closes, 2, 'employee batch keeps the browser between customers');

  const context = new EventEmitter();
  context.pages = () => [page];
  context.grantPermissions = async () => {};
  let launches = 0;
  const browser = load('local-runner/browser.js', {
    fs: { existsSync: () => true }, './config': { dataDir: '/tmp/profiles' },
    './accountsStore': { get: () => null },
    playwright: { chromium: { launchPersistentContext: async () => { launches++; return context; } } },
  });
  const events = [];
  await browser.openForLogin('test', 'https://zalo.basso.vn', (event) => events.push(event));
  await browser.withProfileLock('test', async () => {
    assert.equal(await browser.getPage('test'), page, 'login page reused while window remains open');
  });
  assert.equal(launches, 1);
  assert.deepEqual(events, ['opened']);
  context.emit('close');
  assert.deepEqual(events, ['opened', 'closed']);
  await browser.getPage('test');
  assert.equal(launches, 2, 'manual close permits a fresh context');
  clearTimeout(deadline);
  console.log('PASS: customer reuse, account routing, recovery, close option, and login lock release');
})().catch((err) => { console.error(err); process.exitCode = 1; });
