'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const lane = require('../shared/notificationLane');
const path = require('node:path');

test('every Facebook profile keeps its own session and proxy through login, arrival and shipping', async () => {
  const profiles = ['fb-personal', 'fb-shared', 'fb-new'];
  const launches = [];
  const mocks = {
    fs: { existsSync: () => true }, './config': { dataDir: '/profiles', headless: false },
    './accountsStore': { get: key => ({ platform: 'facebook', proxy: `${key}.example:8080` }) },
    playwright: { chromium: { launchPersistentContext: async (dir, opts) => {
      const navigations = [];
      const page = { goto: async url => { navigations.push(url); } };
      const context = Object.assign(new EventEmitter(), {
        pages: () => [page], grantPermissions: async () => {},
        close: async () => context.emit('close'),
      });
      launches.push({ dir, opts, navigations });
      return context;
    } } },
  };
  const sandbox = { module: { exports: {} }, console,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../local-runner/browser'), 'utf8'), sandbox);
  const browser = sandbox.module.exports;
  for (const key of [...profiles, profiles[0]]) {
    const before = launches.length;
    await browser.openForLogin(key, 'https://www.facebook.com/');
    const page = await browser.getPage(key);
    await lane.run('ship', () => browser.withProfileLock(key, async () => {
      assert.equal(await browser.getPage(key), page);
    }));
    assert.equal(launches.length, before + 1);
    const launch = launches.at(-1);
    assert.equal(path.basename(launch.dir), `fb-${key}`);
    assert.equal(launch.opts.proxy.server, `http://${key}.example:8080`);
    assert.equal(launch.opts.viewport, null);
    assert.equal(launch.opts.args.includes('--start-maximized'), true);
    assert.deepEqual(launch.navigations, ['https://www.facebook.com/']);
  }
  await browser.closeAll();
});

for (const platform of ['facebook', 'zalo', undefined]) {
  test(`CLI login opens the correct page for ${platform || 'legacy'} profiles`, async () => {
    const visited = Promise.withResolvers();
    const loginUrl = platform === 'facebook' ? 'https://www.facebook.com/' : 'https://zalo.basso.vn';
    const mocks = {
      './config': { facebookLoginUrl: 'https://www.facebook.com/', saleworkLoginUrl: 'https://zalo.basso.vn' },
      './accountsStore': { get: () => platform ? { platform } : null },
      './browser': { getContext: async key => {
        assert.equal(key, 'selected-profile');
        return { pages: () => [{ goto: async url => visited.resolve(url) }], on: () => {} };
      } },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../local-runner/login'), 'utf8'), {
      console: { log: () => {}, error: err => visited.reject(err) },
      process: { argv: ['node', 'login.js', 'selected-profile'], exit: () => {} },
      require: name => mocks[name],
    });
    assert.equal(await visited.promise, loginUrl);
  });
}

for (const headless of [false, true]) {
  test(`browser viewport follows ${headless ? 'headless dimensions' : 'the visible window'} across login and shipping`, async () => {
    const launches = [], contexts = [];
    const state = { cookies: [], origins: [] };
    const context = () => Object.assign(new EventEmitter(), {
      pages: () => [{}], grantPermissions: async () => {},
      storageState: async () => state, close: async () => {},
    });
    const mocks = {
      fs: { existsSync: () => true }, './config': { dataDir: '/profiles', headless },
      './accountsStore': { get: key => ({ platform: key === 'fb' ? 'facebook' : 'zalo' }) },
      playwright: { chromium: {
        launchPersistentContext: async (_dir, opts) => {
          launches.push(opts); contexts.push(opts); return context();
        },
        launch: async opts => {
          launches.push(opts);
          return Object.assign(new EventEmitter(), {
            close: async () => {},
            newContext: async options => {
              assert.equal(options.storageState, state);
              contexts.push(options); return context();
            },
          });
        },
      } },
    };
    const sandbox = { module: { exports: {} }, console,
      require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../local-runner/browser'), 'utf8'), sandbox);
    const browser = sandbox.module.exports;
    await browser.getContext('fb');
    await lane.run('ship', () => browser.getContext('fb'));
    assert.equal(launches.length, 1, 'Facebook shipping keeps the same responsive login window');
    await browser.getContext('zalo');
    await lane.run('ship', () => browser.getContext('zalo'));
    assert.equal(launches.length, 3, 'Zalo shipping still opens its separate browser');
    for (const opts of launches) {
      assert.equal(opts.headless, headless);
      assert.equal(opts.args.includes('--start-maximized'), !headless);
    }
    for (const opts of contexts) {
      if (headless) {
        assert.equal(opts.viewport.width, 1366);
        assert.equal(opts.viewport.height, 850);
      } else {
        assert.equal(opts.viewport, null, 'visible pages resize with their real browser window');
      }
    }
    await browser.closeAll();
  });
}
