'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const requests = [];
  let proxy;
  const load = (file, mocks, extras = {}) => {
    const box = { module: { exports: {} }, console, URLSearchParams,
      setTimeout: fn => fn(), ...extras,
      require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), box);
    return box.module.exports;
  };
  const batch = load('server/browserBatch.js', { './playwrightProxy': {
    closeBrowserProfile: profile => proxy.closeBrowserProfile(profile),
  } });
  let failClose = false;
  proxy = load('server/playwrightProxy.js', {
    './browserBatch': batch,
    './config': { playwrightLocalUrl: 'http://runner', apiKey: 'test' },
    './localRegistry': { getFreshUrl: () => null },
    'node-fetch': async (url, opts = {}) => {
      if (opts.method === 'POST') {
        requests.push({ path: new URL(url).pathname, ...JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ jobId: requests.length }) };
      }
      const request = requests[Number(url.split('/').pop()) - 1];
      const failed = failClose && request.path === '/api/browser/close';
      return { ok: true, json: async () => ({ job: { status: failed ? 'error' : 'done', error: failed ? 'close failed' : null } }) };
    },
  });
  return { batch, proxy, requests, failClose: () => { failClose = true; } };
}

test('group employees stably, including shipping approvers and shared profiles', () => {
  const { batch } = harness();
  const list = [{ id: 1, userId: 1, profile: 'shared' }, { id: 2, userId: 2, profile: 'shared' }, { id: 3, userId: 1 }];
  assert.deepEqual(Array.from(batch.groupByEmployee(list), o => o.id), [1, 3, 2]);
  assert.equal(batch.employeeKey({ items: [{ approveUser: ' Lan ' }] }), 'name:Lan');
});

test('reuse through arrival and shipping, close all actual profiles before next employee', async () => {
  const { batch, proxy, requests } = harness();
  await batch.withBrowserBatch(async b => {
    await b.select('employee-a');
    await proxy.sendBaoHang({ profile: 'a', message: 'arrival' });
    await proxy.sendBaoHang({ profile: 'a', message: 'shipping' });
    await proxy.sendBaoHang({ profile: 'fallback' });
    await proxy.sendBaoHangFb({ profile: 'facebook' });
    assert.equal(requests.length, 4);
    await b.select('employee-b');
    await proxy.sendBaoHang({ profile: 'shared' });
  });
  assert.deepEqual(requests.map(r => [r.path, r.profile]), [
    ['/api/zalo/send', 'a'], ['/api/zalo/send', 'a'], ['/api/zalo/send', 'fallback'], ['/api/facebook/send', 'facebook'],
    ['/api/browser/close', 'a'], ['/api/browser/close', 'fallback'], ['/api/browser/close', 'facebook'],
    ['/api/zalo/send', 'shared'], ['/api/browser/close', 'shared'],
  ]);
  assert.ok(requests.filter(r => r.path.endsWith('/send')).every(r => r.keepContext && r.closeAfterSend));
});

for (const ending of ['stop', 'skip-last', 'throw']) {
  test(`cleanup when batch ends with ${ending}`, async () => {
    const { batch, proxy, requests } = harness();
    const run = batch.withBrowserBatch(async b => {
      await b.select('employee');
      await proxy.sendBaoHang({ profile: 'used' });
      if (ending === 'throw') throw new Error('send failed');
      // Early return or no send for the last order must still close previous browser.
      return;
    });
    if (ending === 'throw') await assert.rejects(run, /send failed/); else await run;
    assert.equal(requests.at(-1).path, '/api/browser/close');
  });
}

test('single sends override legacy keep-open config; batch state does not leak', async () => {
  const { batch, proxy, requests } = harness();
  await batch.withBrowserBatch(async () => {});
  await proxy.sendBaoHang({ keepContext: true });
  await proxy.sendBaoHangFb({});
  assert.ok(requests.every(r => r.closeAfterSend === true && r.keepContext === false));
});

test('close failure stops before sending for next employee', async () => {
  const { batch, proxy, requests, failClose } = harness();
  failClose();
  await assert.rejects(batch.withBrowserBatch(async b => {
    await b.select('a');
    await proxy.sendBaoHang({ profile: 'a' });
    await b.select('b');
    await proxy.sendBaoHang({ profile: 'b' });
  }), /close failed/);
  assert.equal(requests.filter(r => r.path.endsWith('/send')).length, 1);
});

for (const kind of ['hang', 'ship', 'shipping-management']) {
  test(`actual ${kind} bulk loop groups staff and closes after skipped final order`, async () => {
    const { batch, proxy, requests } = harness();
    const shipping = kind === 'shipping-management';
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', shipping ? 'shippingSendService.js' : 'notifyService.js'), 'utf8').replace(/\r\n/g, '\n');
    const name = shipping ? 'sendShippingBulk' : 'notifyOrders';
    const start = source.indexOf(`async function ${name}(`);
    const end = shipping ? source.indexOf('\nmodule.exports', start) : source.indexOf('\n/**\n * (Legacy)', start);
    assert.ok(start >= 0 && end > start);
    const orders = [
      { id: 1, userId: 1, profile: 'a' }, { id: 2, userId: 2, profile: 'b' },
      { id: 3, userId: 1, profile: 'a' }, { id: 4, userId: 1, profile: 'a', skip: true },
    ];
    const send = async order => order.skip ? { ok: false } : proxy.sendBaoHang({ profile: order.profile, message: String(order.id) });
    const box = { ...batch, bulkRunning: false, stopRequested: false,
      withLock: fn => fn(), groupOrdersByProfile: async list => list.map(order => ({ order, profileKey: order.profile })),
      notifyOne: send, sendShippingOne: send, delayBetweenCustomers: async () => {},
      autoKey: o => o.id, autoKeyShip: o => `${o.id}:ship`, getAutoRecord: () => null, recordAutoNotified: () => {},
    };
    vm.createContext(box);
    vm.runInContext(source.slice(start, end) + `\nrun = ${name};`, box);
    const result = await box.run(orders, { kind });
    assert.equal(result.sent, 3);
    assert.deepEqual(requests.map(r => [r.path, r.profile, r.message]), [
      ['/api/zalo/send', 'a', '1'], ['/api/zalo/send', 'a', '3'], ['/api/browser/close', 'a', undefined],
      ['/api/zalo/send', 'b', '2'], ['/api/browser/close', 'b', undefined],
    ]);
  });
}
