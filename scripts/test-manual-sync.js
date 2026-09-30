'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const scope = { from: '2026-09-01', to: '2026-09-30' };

function api(rowsFor) {
  const calls = [];
  const box = { module: { exports: {} }, __dirname, URL, URLSearchParams, console,
    require: name => {
      if (name === './config') return { basso: { baseUrl: 'https://basso.test', listCacheTtlMs: 60000 } };
      if (name === 'node-fetch') return async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/login')) return { ok: true, json: async () => ({ data: { access_token: 'test' } }) };
        calls.push(u);
        const data = await rowsFor(u);
        return { ok: true, json: async () => ({ data }) };
      };
      return require(name);
    } };
  vm.runInNewContext(read('server/bassoApi.js'), box);
  return { ...box.module.exports, calls };
}

for (const method of ['getOrders', 'getAllOrders']) {
  test(`${method}: manual sync replaces warm content, including cleared content`, async () => {
    let content = '14 items';
    const h = api(() => ({ rows: [{ customer_id: 1, date_inventory: 1780000000, content }], total: 1 }));
    assert.equal((await h[method](scope)).orders[0].noiDungBaoHang, '14 items');
    content = '18 items';
    assert.equal((await h[method](scope)).orders[0].noiDungBaoHang, '14 items');
    assert.equal(h.calls.length, 1, 'ordinary reload keeps warm cache');
    const fresh = await h[method]({ ...scope, fresh: true });
    assert.equal(fresh.source, 'api-fresh');
    assert.equal(fresh.orders[0].noiDungBaoHang, '18 items');
    assert.equal(h.calls.length, 2);
    assert.equal((await h[method](scope)).orders[0].noiDungBaoHang, '18 items');
    content = '';
    assert.equal((await h[method]({ ...scope, fresh: true })).orders[0].noiDungBaoHang, '');
  });
  test(`${method}: failed fresh read does not silently succeed with cached content`, async () => {
    let fail = false;
    const h = api(() => {
      if (fail) throw Error('Basso unavailable');
      return { rows: [{ customer_id: 1, date_inventory: 1780000000, content: 'old' }], total: 1 };
    });
    await h[method](scope);
    fail = true;
    await assert.rejects(h[method]({ ...scope, fresh: true }), /Basso unavailable/);
  });
}

test('fresh full list refreshes every page for channel filtering', async () => {
  let content = 'old';
  const h = api(u => ({ rows: [{ customer_id: u.searchParams.get('page'), date_inventory: 1780000000, content,
    sale_channel_label: 'Basso' }], total: 101 }));
  await h.getAllOrders(scope);
  content = 'new';
  const result = await h.getAllOrders({ ...scope, fresh: true });
  assert.equal(result.orders.length, 2);
  assert.ok(result.orders.every(o => o.noiDungBaoHang === 'new' && o.saleChannelLabel === 'Basso'));
  assert.deepEqual(h.calls.map(u => u.searchParams.get('page')), ['1', '2', '1', '2']);
});

test('both dashboard routes explicitly parse fresh=1 without losing filters', async () => {
  const handlers = new Map(), calls = [];
  const source = read('server/index.js');
  vm.runInNewContext(source.slice(source.indexOf("app.get('/api/orders',"), source.indexOf('// ---- Danh sách nhân viên')), {
    app: { get: (url, fn) => handlers.set(url, fn) },
    getOrders: async f => { calls.push(f); return { orders: [] }; },
    getAllOrders: async f => { calls.push(f); return { orders: [] }; }, enrichOrders: x => x,
  });
  for (const route of ['/api/orders', '/api/orders/all']) {
    for (const fresh of ['1', '0', undefined]) {
      await handlers.get(route)({ query: { ...scope, fresh, staff: '12', q: 'An', page: '2' } }, { json() {} });
      const f = calls.at(-1);
      assert.equal(f.fresh, fresh === '1');
      assert.equal(f.from, scope.from);
      assert.equal(f.to, scope.to);
      if (route === '/api/orders') { assert.equal(f.page, 2); assert.equal(f.staff, '12'); assert.equal(f.q, 'An'); }
    }
  }
});

function dashboard(respond) {
  const urls = [], warnings = [], syncs = [];
  const elements = { fQ: { value: 'An' }, syncBtn: { innerHTML: 'Sync', disabled: false } };
  const box = {
    URLSearchParams, Set, console,
    allOrders: [{ id: '1', noiDungBaoHang: 'old' }], orders: [{ id: '1', noiDungBaoHang: 'old' }],
    clientMode: false, currentGroupBy: '', currentGroup: '', currentPage: 2, currentStaff: '12',
    serverTotal: 1, pageCount: 2, PAGE_SIZE: 20, COLSPAN: 14, STATUS_FOR_GROUP: {}, counts: {},
    rowsEl: { innerHTML: 'old rows' }, $: id => elements[id], groupOf: () => 'todo',
    applyScope: p => { p.set('from', scope.from); p.set('to', scope.to); },
    App: { api: async url => { urls.push(url); return respond(url); }, toast: s => warnings.push(s), esc: s => s },
    mergeChannels() {}, mergeTabUsers() {}, syncLocalFlags() {}, applyView() {},
    setSyncInfo: () => syncs.push('updated'), renderTabs() {}, renderChannelOptions() {}, render() {},
    renderStatusTabs() {}, updateCount() {}, visibleOrders: () => [],
  };
  vm.createContext(box);
  const source = read('server/public/js/dashboard.js');
  vm.runInContext(source.slice(source.indexOf('  let listLoadVersion'), source.indexOf('  // Warm server-side SWR')), box);
  return { box, urls, warnings, syncs, elements, run: s => vm.runInContext(s, box) };
}
const response = text => ({ orders: [{ id: '1', noiDungBaoHang: text }], total: 100 });

for (const method of ['load', 'loadAll']) {
  test(`${method}: fresh query replaces existing customer content and retains scope`, async () => {
    const h = dashboard(async () => response('new'));
    await h.box[method]({ fresh: true, keepPage: true });
    const url = new URL(h.urls[0], 'https://mi.test');
    assert.equal(url.searchParams.get('fresh'), '1');
    assert.equal(url.searchParams.get('from'), scope.from);
    assert.equal(h.box[method === 'load' ? 'orders' : 'allOrders'][0].noiDungBaoHang, 'new');
    if (method === 'load') { assert.equal(url.searchParams.get('page'), '2'); assert.equal(url.searchParams.get('staff'), '12'); }
  });
  test(`${method}: old response cannot overwrite completed manual sync`, async () => {
    let release;
    const h = dashboard(url => url.includes('fresh=1') ? response('new') : new Promise(resolve => { release = resolve; }));
    const background = h.box[method]({ auto: true });
    await h.box[method]({ fresh: true, keepPage: true });
    release(response('old'));
    await background;
    assert.equal(h.box[method === 'load' ? 'orders' : 'allOrders'][0].noiDungBaoHang, 'new');
    assert.equal(h.syncs.length, 1);
  });
  test(`${method}: manual sync failure preserves current data and reports error`, async () => {
    const h = dashboard(async () => { throw Error('Basso offline'); });
    assert.equal(await h.box[method]({ fresh: true, keepPage: true }), false);
    assert.equal(h.box.orders[0].noiDungBaoHang, 'old');
    assert.equal(h.box.rowsEl.innerHTML, 'old rows');
    assert.equal(h.syncs.length, 0);
    assert.match(h.warnings[0], /Basso offline/);
  });
  test(`${method}: ordinary background sync does not force fresh reads`, async () => {
    const h = dashboard(async () => response('cached'));
    await h.box[method]({ auto: true });
    assert.ok(h.urls.every(url => !url.includes('fresh=')));
  });
}

test('truncated full list preserves fresh on paginated fallback', async () => {
  const h = dashboard(async url => url.includes('/all?') ? { ...response('new'), truncated: true } : response('new'));
  await h.box.loadAll({ fresh: true, keepPage: true });
  assert.equal(h.urls.length, 2);
  assert.ok(h.urls.every(url => url.includes('fresh=1')));
  assert.equal(h.box.orders[0].noiDungBaoHang, 'new');
});

test('manual button waits, prevents double clicks, and restores itself', async () => {
  const h = dashboard(async () => response('new'));
  let finish, calls = 0;
  h.box.reloadScope = opts => {
    calls++;
    assert.equal(opts.fresh, true);
    assert.equal(opts.keepPage, true);
    return new Promise(resolve => { finish = resolve; });
  };
  const source = read('server/public/js/dashboard.js');
  h.run(source.slice(source.indexOf('  async function manualSync()'), source.indexOf("  $('syncBtn').addEventListener")));
  const pending = h.box.manualSync();
  assert.equal(h.elements.syncBtn.disabled, true);
  await h.box.manualSync();
  assert.equal(calls, 1);
  finish(true);
  await pending;
  assert.equal(h.elements.syncBtn.disabled, false);
  assert.equal(h.elements.syncBtn.innerHTML, 'Sync');
});

test('reloadScope forwards fresh to counts and the correct list mode', async () => {
  const source = read('server/public/js/dashboard.js');
  for (const clientMode of [false, true]) {
    const calls = [];
    const ctx = { clientMode, contentAttempts: new Map([['1', 3]]),
      loadCounts: opts => calls.push(['counts', opts.fresh]),
      load: async opts => calls.push(['page', opts.fresh]),
      loadAll: async opts => calls.push(['all', opts.fresh]) };
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('  function reloadScope('), source.indexOf('  function applyFilters(')), ctx);
    await ctx.reloadScope({ fresh: true, keepPage: true });
    assert.deepEqual(calls, clientMode ? [['all', true]] : [['counts', true], ['page', true]]);
    assert.equal(ctx.contentAttempts.size, 0);
  }
});

test('content request for a replaced row cannot repaint the newly synced row', async () => {
  const source = read('server/public/js/dashboard.js');
  const old = { id: '1', customerId: 1, dateInventory: 1780000000, noiDungBaoHang: '' };
  const current = { ...old, noiDungBaoHang: 'new' };
  let paints = 0;
  const ctx = { URLSearchParams, CONTENT_CONCURRENCY: 3, CONTENT_MAX_ATTEMPTS: 3,
    contentAttempts: new Map(), contentInflight: new Set(), byId: () => current,
    App: { api: async () => ({ noiDungBaoHang: 'old' }) }, updateHangCellDom: () => { paints++; } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  async function autoFillContent('), source.indexOf('  // ---- Bảng sản phẩm')), ctx);
  await ctx.autoFillContent([old]);
  assert.equal(current.noiDungBaoHang, 'new');
  assert.equal(paints, 0);
  assert.equal(ctx.contentInflight.size, 0);
});

test('cold full-list load still allows fast first-page paint before full response', async () => {
  let finish;
  const h = dashboard(url => url.includes('/all?') ? new Promise(resolve => { finish = resolve; }) : response('page'));
  h.box.allOrders = [];
  const full = h.box.loadAll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.box.orders[0].noiDungBaoHang, 'page');
  finish(response('full'));
  await full;
  assert.equal(h.box.allOrders[0].noiDungBaoHang, 'full');
});
