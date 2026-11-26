'use strict';
// Offline: fake credentials only; no config, browser or account store is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = {};
let account;
const sandbox = { __dirname: path.join(__dirname, '../local-runner'), module: { exports: {} }, require(name) {
  if (name === './config') return config;
  if (name === './accountsStore') return { get: () => account };
  if (name === 'path' || name === 'crypto' || name === 'fs') return require(name);
  return {};
} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../local-runner/salework.js'), 'utf8'), sandbox);
const { loginCredsFor } = sandbox.module.exports;
config.saleworkLoginUser = ' shared@example.test ';
config.saleworkLoginPass = ' shared-password ';
account = { platform: 'zalo', email: 'old@example.test', password: 'old-password' };
for (const profile of ['basso', 'linhduong_basso', 'default', 'another']) {
  const creds = loginCredsFor(profile);
  assert.equal(creds.username, 'shared@example.test');
  assert.equal(creds.password, ' shared-password ');
}
account = undefined;
assert.equal(loginCredsFor('missing').username, 'shared@example.test');
account = { platform: 'zalo', email: 'old@example.test', password: 'old-password' };
config.saleworkLoginPass = '';
assert.throws(() => loginCredsFor('basso'), /cấu hình đủ/);
config.saleworkLoginPass = 'shared-password';
config.saleworkLoginUser = '';
assert.throws(() => loginCredsFor('basso'), /cấu hình đủ/);
config.saleworkLoginPass = '';
assert.equal(loginCredsFor('basso').username, account.email);
assert.equal(loginCredsFor('basso').password, account.password);
account.password = '';
assert.equal(loginCredsFor('basso'), null);
account = { platform: 'facebook', email: 'fb@example.test', password: 'fb-password' };
assert.equal(loginCredsFor('fb'), null);
account = undefined;
assert.equal(loginCredsFor('missing'), null);
console.log('PASS: shared login priority, complete pairs, fallback and missing credentials');
