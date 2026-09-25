'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const lane = require('../shared/notificationLane');

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
