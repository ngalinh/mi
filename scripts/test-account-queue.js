'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withLock } = require('../server/lock');

function load(file, mocks, extra = {}) {
  const filename = path.join(__dirname, '..', file);
  const box = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} }, URLSearchParams, setTimeout: fn => fn(),
    __dirname: path.dirname(filename), ...extra,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box);
  return box.module.exports;
}

function harness(outcome = () => null, delay = async () => {}, options = {}) {
  const requests = [], reports = [], settings = new Map();
  let proxy;
  const queue = load('server/accountQueue.js', {
    './lock': { withLock }, './notifyService': { delayBetweenCustomers: delay },
    './playwrightProxy': { closeBrowserProfile: profile => proxy.closeBrowserProfile(profile) },
  });
  proxy = load('server/playwrightProxy.js', {
    './accountQueue': queue, './config': { playwrightLocalUrl: 'http://runner', apiKey: 'test' },
    './localRegistry': { getFreshUrl: () => null },
    'node-fetch': async (url, opts = {}) => {
      if (opts.method === 'POST') {
        const request = { path: new URL(url).pathname, ...JSON.parse(opts.body) };
        requests.push(request);
        request.error = outcome(request);
        return { ok: true, json: async () => ({ jobId: requests.length }) };
      }
      const r = requests[Number(url.split('/').pop()) - 1];
      return { ok: true, json: async () => ({ job: { status: r.error ? 'error' : 'done', error: r.error } }) };
    },
  });
  const db = {
    addReport: row => { const r = { ...row, id: reports.length + 1 }; reports.push(r); return r; },
    updateReport: (id, fields) => Object.assign(reports[id - 1], fields),
    getReportById: id => reports[Number(id) - 1],
    getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value),
    getZaloName: () => '', getContactReportTarget: () => null, getFbLink: () => 'https://facebook.com/messages/t/test',
    getAutoRecord: () => null, recordAutoNotified: () => {}, autoKey: o => `arrival:${o.id}`, autoKeyShip: o => `arrival:${o.id}:ship`,
    getShippingNotified: () => null, markShippingNotified: () => {}, getShippingTemplates: () => ({}),
  };
  const hold = load('server/notificationHold.js', { './db': db });
  const resolveForOrder = options.resolveForOrder || (async order => ({ profile: 'X', account: 'X', channel: 'zalo',
    fallbackAccounts: [{ profile: 'Y', account: 'Y' }], ...(order.route || {}) }));
  const common = {
    './accountFallback': require('../server/accountFallback'),
    './accountQueue': queue, './notificationHold': hold, './playwrightProxy': proxy,
    './lock': { withLock }, './db': db, './config': { basso: {}, notify: {} },
    './accountResolver': { resolveForOrder, isRetryableAccountError: e => /^KHONG_THAY_HOI_THOAI:/.test(e || '') },
    './bassoApi': { getArrivedItems: async () => ({ items: [] }), getTabUsers: async () => ({ tabUsers: [] }),
      findCustomerByOrderCode: async () => null, syncShipStatusByCode: async () => ({}) },
    '../shared/messageTemplate': { buildBaoHangMessage: o => 'arrival ' + o.id, buildBaoShipMessage: o => 'ship ' + o.id },
  };
  Object.assign(db, options.db || {});
  Object.assign(common['./bassoApi'], options.basso || {});
  const notify = load('server/notifyService.js', common);
  const shipping = load('server/shippingSendService.js', { ...common,
    './notifyService': notify, './shippingNotify': { buildDeliveryMessage: o => ({ sendable: true, message: 'shipping ' + o.id }), REASON_LABEL: {} },
  });
  return { queue, proxy, requests, reports, settings, hold, notify, shipping };
}

for (const kind of ['hang', 'ship', 'shipping-management']) {
  test(`${kind}: shared employees reuse X; fallback waits until X completes; one report per order`, async () => {
    const h = harness(r => r.path.endsWith('/send') && r.profile === 'X' && r.keyword === '1' ? 'KHONG_THAY_HOI_THOAI: no chat' : null);
    const orders = [1, 2, 3].map(id => ({ id, userId: id, phone: String(id), customerName: 'Customer', orderCode: 'BS1' }));
    const result = kind === 'shipping-management' ? await h.shipping.sendShippingBulk(orders) : await h.notify.notifyOrders(orders, { kind });
    assert.equal(result.sent, 3);
    assert.equal(h.reports.length, 3);
    assert.ok(h.reports.every(r => r.status === 'success'));
    assert.deepEqual(h.requests.map(r => [r.path, r.profile, r.keyword]), [
      ['/api/zalo/send', 'X', '1'], ['/api/zalo/send', 'X', '2'], ['/api/zalo/send', 'X', '3'],
      ['/api/browser/close', 'X', undefined], ['/api/zalo/send', 'Y', '1'], ['/api/browser/close', 'Y', undefined],
    ]);
  });
}

test('uncertain send is a failure and can retry next batch without account fallback', async () => {
  const h = harness(r => r.path.endsWith('/send') ? 'NEEDS_CHECK: lost confirmation' : null);
  const order = { id: 1, phone: '1', orderCode: 'BS1' };
  await h.notify.notifyOrders([order]);
  assert.equal(h.reports[0].status, 'failed');
  await h.notify.notifyOrders([order]);
  assert.equal(h.requests.filter(r => r.path.endsWith('/send')).length, 2);
  assert.equal(h.hold.getHold('arrival:1'), undefined);
});

test('unavailable profile is attempted once; other profile still completes', async () => {
  const h = harness(r => r.path.endsWith('/send') && r.profile === 'X' ? 'CHUA_DANG_NHAP: login failed' : null);
  const result = await h.notify.notifyOrders([
    { id: 1, phone: '1', orderCode: 'BS1' }, { id: 2, phone: '2', orderCode: 'BS2' },
    { id: 3, phone: '3', orderCode: 'BS3', route: { profile: 'Z', account: 'Z', fallbackAccounts: [] } },
  ]);
  assert.equal(result.sent, 3);
  assert.deepEqual(h.requests.filter(r => r.path.endsWith('/send')).map(r => r.profile), ['X', 'Z', 'Y', 'Y']);
});

test('missing conversation never tries accounts outside resolver candidates', async () => {
  const h = harness(r => r.path.endsWith('/send') ? 'KHONG_THAY_HOI_THOAI: no chat' : null);
  const result = await h.notify.notifyOrders([{ id: 1, phone: '1', orderCode: 'BS1' }]);
  assert.equal(result.failed, 1);
  assert.deepEqual(h.requests.filter(r => r.path.endsWith('/send')).map(r => r.profile), ['X', 'Y']);
  assert.equal(h.reports.length, 1);
});

for (const kind of ['ship', 'shipping-management']) {
  test(kind + ' sends while arrival is still waiting for its delay', async () => {
    const gate = Promise.withResolvers();
    const waiting = Promise.withResolvers();
    const h = harness(undefined, () => { waiting.resolve(); return gate.promise; });
    const arrival = h.notify.notifyOrders([1, 2].map(id => ({ id, phone: String(id) })));
    await waiting.promise;
    try {
      const orders = [{ id: 3, phone: '3' }];
      const result = await (kind === 'ship' ? h.notify.notifyOrders(orders, { kind }) : h.shipping.sendShippingBulk(orders));
      assert.equal(result.sent, 1);
      assert.equal(h.notify.isBulkRunning(), true, 'arrival remains active after ship completes');
      assert.equal(h.requests.filter(r => r.browserLane === 'hang' && r.path.endsWith('/send')).length, 1);
      assert.deepEqual(h.requests.filter(r => r.browserLane === 'ship').map(r => r.path), ['/api/zalo/send', '/api/browser/close']);
    } finally { gate.resolve(); await arrival; }
  });
}

test('stop drains no more sends and finalizes pending reports', async () => {
  let h;
  h = harness(r => { if (r.path.endsWith('/send')) h.notify.requestStopBulk(); return null; });
  const r = await h.notify.notifyOrders([1,2,3].map(id => ({ id, phone: String(id), orderCode: 'BS1' })));
  assert.equal(r.stopped, true);
  assert.equal(h.requests.filter(r => r.path.endsWith('/send')).length, 1);
  assert.ok(h.reports.every(r => r.status !== 'pending'));
  assert.equal(h.requests.at(-1).path, '/api/browser/close');
});

test('pre-send timeout retries once; missing conversation never retried locally', async () => {
  let reloads = 0, attempts = 0;
  const page = { reload: async () => { reloads++; } };
  const recovery = load('local-runner/sendRecovery.js', { './browser': { getPage: async () => page, closeContext: async () => {} } });
  await recovery.prepareWithRetry('X', async () => { if (++attempts === 1) throw Error('Timeout'); });
  assert.equal(attempts, 2); assert.equal(reloads, 1);
  attempts = 0;
  await assert.rejects(recovery.prepareWithRetry('X', async () => { attempts++; throw Error('KHONG_THAY_HOI_THOAI: no chat'); }), /KHONG_THAY/);
  assert.equal(attempts, 1);
});

test('transport timeout after accepting send requires checking, not resend', async () => {
  const proxy = load('server/playwrightProxy.js', {
    './accountQueue': { dispatchSend: (_path, payload, send) => send(payload) },
    './config': { playwrightLocalUrl: 'http://runner' }, './localRegistry': { getFreshUrl: () => null },
    'node-fetch': async () => { throw Error('network timeout'); },
  });
  assert.match((await proxy.sendBaoHang({})).error, /^NEEDS_CHECK:/);
});

test('legacy holds no longer block a new send', async () => {
  const h = harness();
  h.hold.hold('arrival:1', 'NEEDS_CHECK: old timeout', 99);
  h.hold.hold('shipping:2', 'NEEDS_CHECK: old timeout', 98);
  await h.notify.notifyOrders([{ id: 1, phone: '1', orderCode: 'BS1' }]);
  await h.shipping.sendShippingBulk([{ id: 2, phone: '2', items: [{ orderCode: 'BS2' }] }]);
  assert.equal(h.requests.filter(r => r.path.endsWith('/send')).length, 2);
  assert.ok(h.reports.every(r => r.status === 'success'));
});

test('managed browser closes previous profile before launch and serializes profiles', async () => {
  const { EventEmitter } = require('node:events');
  let live = 0, peak = 0;
  const browser = load('local-runner/browser.js', {
    fs: { existsSync: () => true }, './config': { dataDir: '/tmp/profiles' }, './accountsStore': { get: () => null },
    playwright: { chromium: { launchPersistentContext: async () => {
      const context = new EventEmitter();
      live++; peak = Math.max(peak, live);
      context.pages = () => [{}]; context.grantPermissions = async () => {};
      context.close = async () => { live--; context.emit('close'); };
      return context;
    } } },
  });
  await Promise.all(['X','Y','Z'].map(profile => browser.withProfileLock(profile, async () => {
    await browser.getPage(profile); await new Promise(resolve => setImmediate(resolve));
    assert.equal(live, 1);
  })));
  assert.equal(peak, 1);
  await browser.closeAll();
  assert.equal(live, 0);
});

test('Zalo send click timeout is uncertain and never clicks fallback buttons', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'local-runner/salework.js'), 'utf8');
  const body = source.slice(source.indexOf('async function clickSend(page)'), source.indexOf('// Đính ảnh'));
  const context = { randomDelay: async () => {}, notBusy: async () => true,
    waitUntil: async (_page, _step, condition) => { assert.equal(await condition(), true); } };
  vm.createContext(context); vm.runInContext(body, context);
  let clicks = 0;
  const page = { locator: () => ({ first: () => ({ count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
    click: async () => { clicks++; throw Error('Timeout'); } }) }) };
  await assert.rejects(context.clickSend(page), /^Error: NEEDS_CHECK:/);
  assert.equal(clicks, 1);
});

test('Facebook uncertain confirmation never presses Enter a second time', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'local-runner/facebook.js'), 'utf8');
  const start = source.indexOf('async function typeAndSend(');
  const body = source.slice(start, source.indexOf('\n/**', start));
  const context = { shot: async () => {} };
  vm.createContext(context); vm.runInContext(body, context);
  const keys = [];
  const page = { evaluate: async () => {}, waitForTimeout: async () => {}, keyboard: { press: async key => keys.push(key) } };
  const box = { click: async () => {}, innerText: async () => 'message', waitFor: async () => {} };
  await assert.rejects(context.typeAndSend(page, box, 'message'), /NEEDS_CHECK/);
  assert.equal(keys.filter(key => key === 'Enter').length, 1);
});

for (const kind of ['hang', 'ship']) {
  test(`automatic ${kind} loop counts a deferred fallback only once`, async () => {
    const h = harness(r => r.path.endsWith('/send') && r.profile === 'X' && r.keyword === '1' ? 'KHONG_THAY_HOI_THOAI: no chat' : null);
    const source = fs.readFileSync(path.join(__dirname, '..', 'server/autoNotify.js'), 'utf8');
    const body = source.slice(source.indexOf('async function executeNotifyPass('), source.indexOf('async function runAutoNotify('));
    const records = [];
    const context = { ...h.queue, withLock, notifyOne: h.notify.notifyOne, cfg: { maxRetries: 3 },
      checkLocalHealth: async () => true, fetchAllByStatus: async () => [1,2].map(id => ({ id, phone: String(id), orderCode: 'BS1' })),
      autoKey: o => o.id, getDelayedMap: () => new Map(), getAutoRecord: () => null,
      recordAutoNotified: (...args) => records.push(args), isTransientError: () => false, console: { log() {} },
    };
    vm.createContext(context); vm.runInContext(body, context);
    const summary = { results: [], sent: 0, failed: 0 };
    await context.executeNotifyPass({ kind, trigger: 'manual', statusFilter: 'not_sent', summary,
      classify: async () => ({ decision: 'send', acct: { profile: 'X' } }), keyOf: o => o.id });
    assert.equal(summary.sent, 2); assert.equal(summary.results.length, 2); assert.equal(records.length, 2);
    assert.deepEqual(h.requests.filter(r => r.path.endsWith('/send')).map(r => r.profile), ['X','X','Y']);
  });
}

for (const method of ['runShippingAuto', 'runSafetyNet']) {
  test(`${method} uses the same account queue`, async () => {
    const h = harness(r => r.path.endsWith('/send') && r.profile === 'X' && r.keyword === '1' ? 'KHONG_THAY_HOI_THOAI: no chat' : null);
    const source = fs.readFileSync(path.join(__dirname, '..', 'server/shippingAutoNotify.js'), 'utf8');
    const start = source.indexOf(`async function ${method}(`);
    const end = method === 'runShippingAuto' ? source.indexOf('async function runSafetyNet(') : source.indexOf('function maybeRun(');
    const context = { ...h.queue, withLock, shippingSendService: h.shipping, cfg: { maxRetries: 3 },
      config: { autoNotify: { timezone: 'Asia/Ho_Chi_Minh' } }, isShippingTime: () => true,
      state: { enabled: true }, checkLocalHealth: async () => true, getShippingNotified: () => null,
      isShippingAutoSeen: () => false, isShippingExcluded: () => false, classify: () => ({ decision: 'send' }),
      CARRIERS: { 1: { type: 'tracking' } }, localDayKey: () => '2026-09-18',
      fetchRecentOrders: async () => [1,2].map(id => ({ id, phone: String(id), isPrepared: true, shippingId: 1, trackingCode: 'TEST', preparedAtRaw: '2026-09-18' })),
    };
    vm.createContext(context); vm.runInContext(source.slice(start, end), context);
    const result = method === 'runSafetyNet' ? await context[method]('2026-09-18') : await context[method]();
    assert.equal(result.error, undefined); assert.equal(result.sent, 2); assert.equal(result.results.length, 2);
    assert.deepEqual(h.requests.filter(r => r.path.endsWith('/send')).map(r => r.profile), ['X','X','Y']);
  });
}

for (const kind of ['hang', 'ship', 'shipping-management']) {
  for (const override of ['personal', 'group', null]) {
    test(`${kind}: contact target ${override} survives account fallback`, async () => {
      const h = harness(r => r.path.endsWith('/send') && r.profile === 'X' ? 'KHONG_THAY_HOI_THOAI: missing' : null,
        async () => {}, { db: { getContactReportTarget: () => override },
          resolveForOrder: async () => ({ channel: 'zalo', profile: 'X', account: 'X', notifyTarget: 'group',
            fallbackAccounts: [{ channel: 'zalo', profile: 'Y', account: 'Y', notifyTarget: 'personal' }] }) });
      const order = { id: 1, phone: '1', orderCode: 'BS1' };
      const result = kind === 'shipping-management' ? await h.shipping.sendShippingBulk([order]) : await h.notify.notifyOrders([order], { kind });
      assert.equal(result.sent, 1);
      assert.deepEqual(h.requests.filter(r => r.path.endsWith('/send')).map(r => r.notifyTarget), override ? [override, override] : ['group', 'personal']);
    });
  }
  for (const error of ['FB: no composer', 'CHUA_DANG_NHAP: Session Facebook', 'ACCOUNT_UNAVAILABLE: browser', 'NEEDS_CHECK: FB: unknown result']) {
    test(`${kind}: Facebook fallback handles ${error}`, async () => {
      const h = harness(r => r.path.endsWith('/send') && r.profile === 'X' ? error : null, async () => {}, {
        resolveForOrder: async () => ({ channel: 'facebook', profile: 'X', account: 'FB X',
          fallbackAccounts: [{ channel: 'facebook', profile: 'Y', account: 'FB Y' }] }) });
      const order = { id: 1, phone: '1', orderCode: 'BS1' };
      const result = kind === 'shipping-management' ? await h.shipping.sendShippingBulk([order]) : await h.notify.notifyOrders([order], { kind });
      const uncertain = error.startsWith('NEEDS_CHECK');
      assert.equal(result.sent, uncertain ? 0 : 1);
      assert.deepEqual(h.requests.filter(r => r.path.endsWith('/send')).map(r => [r.path, r.profile]),
        uncertain ? [['/api/facebook/send','X']] : [['/api/facebook/send','X'],['/api/facebook/send','Y']]);
      assert.equal(h.reports.length, 1);
      assert.equal(h.reports[0].status, uncertain ? 'failed' : 'success');
      assert.equal(h.reports[0].zaloAccount, uncertain ? 'FB X' : 'FB Y');
    });
  }
}

test('shipping fallback re-reads purchaser target and preserves shipping message', async () => {
  const h = harness(r => r.path.endsWith('/send') && r.keyword === 'recipient' ? 'KHONG_THAY_HOI_THOAI: missing' : null,
    async () => {}, { db: { getFbLink: () => '', getContactReportTarget: phone => phone === 'recipient' ? 'group' : 'personal' },
      basso: { findCustomerByOrderCode: async () => ({ phone: 'purchaser', customerName: 'Buyer' }) } });
  const result = await h.shipping.sendShippingBulk([{ id: 1, phone: 'recipient', items: [{ orderCode: 'BS1' }] }]);
  assert.equal(result.sent, 1);
  const sends = h.requests.filter(r => r.path.endsWith('/send'));
  assert.deepEqual(sends.map(r => [r.keyword, r.notifyTarget]), [['recipient','group'], ['recipient','group'], ['purchaser','personal']]);
  assert.ok(sends.every(r => r.message === 'shipping 1'));
});

test('shipping purchaser Facebook fallback retains channel and account on retryable failure', async () => {
  const h = harness(r => r.path === '/api/zalo/send' ? 'KHONG_THAY_HOI_THOAI: missing'
    : r.path === '/api/facebook/send' ? 'NEEDS_CHECK: timeout' : null, async () => {}, {
    db: { getFbLink: phone => phone === 'purchaser' ? 'https://facebook.com/messages/t/buyer' : '' },
    basso: { findCustomerByOrderCode: async () => ({ phone: 'purchaser', customerName: 'Buyer' }) },
    resolveForOrder: async (o, opts) => opts?.channel === 'facebook'
      ? { channel: 'facebook', profile: 'FB', account: 'FB Buyer' }
      : { channel: 'zalo', profile: 'X', account: 'X' },
  });
  const result = await h.shipping.sendShippingBulk([{ id: 1, phone: 'recipient', items: [{ orderCode: 'BS1' }] }]);
  assert.equal(result.failed, 1);
  assert.deepEqual(h.requests.filter(r => r.path.endsWith('/send')).map(r => r.path), ['/api/zalo/send','/api/facebook/send']);
  assert.equal(h.reports[0].channel, 'facebook');
  assert.equal(h.reports[0].status, 'failed');
  assert.equal(h.reports[0].zaloAccount, 'FB Buyer');
  assert.equal(h.hold.getHold('shipping:1'), undefined);
});

for (const kind of ['hang', 'ship']) {
  test(kind + ': uncertain failures reach retry limit and dispatch Zalo alert', async () => {
    const h = harness(r => r.path.endsWith('/send') ? 'NEEDS_CHECK: lost confirmation' : null);
    const source = fs.readFileSync(path.join(__dirname, '..', 'server/autoNotify.js'), 'utf8');
    const body = source.slice(source.indexOf('async function executeNotifyPass('), source.indexOf('async function runAutoNotify('));
    const records = [], alerts = [];
    const context = { ...h.queue, withLock, notifyOne: h.notify.notifyOne, cfg: { maxRetries: 3 },
      checkLocalHealth: async () => true, fetchAllByStatus: async () => [{ id: 1, phone: '1', orderCode: 'BS1' }],
      autoKey: o => o.id, getDelayedMap: () => new Map(), getAutoRecord: () => ({ status: 'failed', attempts: 2 }),
      recordAutoNotified: (...args) => records.push(args), isTransientError: () => false,
      dispatchAlert: async text => alerts.push(text), console: { log() {} },
    };
    vm.createContext(context); vm.runInContext(body, context);
    const summary = { results: [], sent: 0, failed: 0 };
    await context.executeNotifyPass({ kind, trigger: 'manual', statusFilter: 'not_sent', summary,
      classify: async () => ({ decision: 'send', acct: { profile: 'X' } }), keyOf: o => o.id });
    assert.equal(summary.failed, 1);
    assert.deepEqual(records, [[1, 'failed', 3]]);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /NEEDS_CHECK/);
    assert.equal(h.reports[0].status, 'failed');
  });
}

for (const recipientHasLink of [false, true]) {
  test('Facebook shipping goes to purchaser, recipient link=' + recipientHasLink, async () => {
    const lookups = [], resolvedPhones = [], marked = [], synced = [];
    const h = harness(r => r.path.endsWith('/send') && r.profile === 'Owner1' ? 'FB: no composer' : null, async () => {}, {
      db: {
        getFbLink: phone => phone === 'buyer' ? 'https://facebook.com/messages/t/buyer' : recipientHasLink ? 'https://facebook.com/messages/t/recipient' : '',
        markShippingNotified: (...args) => marked.push(args),
      },
      basso: {
        findCustomerByOrderCode: async code => { lookups.push(code); return { phone: 'buyer', customerName: 'Buyer' }; },
        syncShipStatusByCode: async data => { synced.push(data); return {}; },
      },
      resolveForOrder: async (order, opts) => {
        resolvedPhones.push([order.phone, opts.channel]);
        return order.phone === 'buyer'
          ? { channel: 'facebook', profile: 'Owner1', account: 'Owner1', fallbackAccounts: [{ channel: 'facebook', profile: 'Owner2', account: 'Owner2' }] }
          : { channel: 'facebook', profile: 'Recipient', account: 'Recipient' };
      },
    });
    const result = await h.shipping.sendShippingBulk([{ id: 1, phone: 'recipient', recipient: 'Recipient', trackingCode: 'TRACK', items: [{ orderCode: 'BS1' }, { orderCode: 'BS1' }] }]);
    assert.equal(result.sent, 1);
    assert.deepEqual(lookups, ['BS1']);
    assert.deepEqual(resolvedPhones, [['recipient', undefined], ['buyer', 'facebook']]);
    const sends = h.requests.filter(r => r.path.endsWith('/send'));
    assert.deepEqual(sends.map(r => r.profile), ['Owner1', 'Owner2']);
    assert.ok(sends.every(r => r.path === '/api/facebook/send' && r.keyword === 'buyer' && r.name === 'Buyer' && r.fbLink.endsWith('/buyer') && r.message === 'shipping 1'));
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].phone, 'buyer');
    assert.equal(h.reports[0].phoneOriginal, 'recipient');
    assert.equal(h.reports[0].customerName, 'Buyer');
    assert.equal(h.reports[0].phoneSource, 'fallback_customer');
    assert.equal(h.reports[0].zaloAccount, 'Owner2');
    assert.deepEqual(marked, [[1, 'buyer']]);
    assert.equal(synced[0].phone, 'buyer');
    assert.equal(synced[0].code, 'TRACK');
  });
}

for (const scenario of ['missing-link', 'lookup-error', 'not-found', 'multiple-owners', 'missing-account']) {
  test('Facebook owner lookup fails without sending recipient: ' + scenario, async () => {
    const h = harness(() => null, async () => {}, {
      db: { getFbLink: phone => phone === 'buyer' && scenario === 'missing-link' ? '' : 'https://facebook.com/messages/t/' + phone },
      basso: { findCustomerByOrderCode: async code => {
        if (scenario === 'lookup-error') throw Error('Basso lookup unavailable');
        if (scenario === 'not-found') return null;
        return { phone: scenario === 'multiple-owners' && code === 'BS2' ? 'other' : 'buyer', customerName: 'Buyer' };
      } },
      resolveForOrder: async order => ({ channel: 'facebook', profile: 'FB', account: 'FB', skip: scenario === 'missing-account' && order.phone === 'buyer' }),
    });
    const result = await h.shipping.sendShippingBulk([{ id: 1, phone: 'recipient', items: [{ orderCode: 'BS1' }, { orderCode: 'BS2' }] }]);
    assert.equal(result.failed, 1);
    assert.equal(h.requests.filter(r => r.path.endsWith('/send')).length, 0);
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].status, 'failed');
    assert.ok(h.reports[0].error);
  });
}

test('Facebook purchaser lookup preserves explicitly selected sender account', async () => {
  const selections = [];
  const h = harness(() => null, async () => {}, {
    basso: { findCustomerByOrderCode: async () => ({ phone: 'buyer', customerName: 'Buyer' }) },
    resolveForOrder: async (order, opts) => {
      selections.push([order.phone, opts.profile, opts.account]);
      return { channel: 'facebook', profile: opts.profile, account: opts.account, source: 'explicit' };
    },
  });
  const result = await h.shipping.sendShippingBulk([{ id: 1, phone: 'recipient', items: [{ orderCode: 'BS1' }] }], { profile: 'Chosen', account: 'Chosen FB' });
  assert.equal(result.sent, 1);
  assert.deepEqual(selections, [['recipient', 'Chosen', 'Chosen FB'], ['buyer', 'Chosen', 'Chosen FB']]);
  const sends = h.requests.filter(r => r.path.endsWith('/send'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].profile, 'Chosen');
  assert.equal(sends[0].keyword, 'buyer');
});
