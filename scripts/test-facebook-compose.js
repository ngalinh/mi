'use strict';
// Offline DOM fixtures only. No Facebook session, network access or customer messages.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const filename = path.join(__dirname, '../local-runner/facebook.js');
const mocks = {
  './config': {}, './sendRecovery': {}, './testModeStore': {}, './browser': {},
};
const sandbox = { module: { exports: {} }, URL, console,
  require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) };
vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
  shot = async () => {};
  module.exports.test = { findComposeBox, waitComposeBox, typeAndSend, openConversationByLink };
`, sandbox, { filename });
const fb = sandbox.module.exports.test;
let browser;
before(async () => {
  browser = await chromium.launch(process.env.FB_TEST_BROWSER_CHANNEL
    ? { channel: process.env.FB_TEST_BROWSER_CHANNEL } : {});
});
after(async () => { if (browser) await browser.close(); });

const comment = '<div id="comment" contenteditable="true" role="textbox" data-lexical-editor="true" aria-label="Write a comment..."></div>';
const chat = '<div id="chat" contenteditable="true" role="textbox" data-lexical-editor="true" aria-placeholder="Aa" aria-label="Write to Customer"></div>';
async function fixture(t, html) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/*', route => route.abort());
  await page.setContent(html);
  await page.evaluate(() => {
    window.sent = [];
    document.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        window.sent.push({ id: event.target.id, text: event.target.innerText });
        event.target.innerText = '';
      }
    });
  });
  return page;
}

test('first post comment, including Lexical editor, is never a composer', async t => {
  const page = await fixture(t, comment);
  assert.equal(await fb.findComposeBox(page, 100), null);
  await assert.rejects(fb.typeAndSend(page, await page.$('#comment'), 'Arrival'), /không còn hợp lệ/);
  assert.deepEqual(await page.evaluate(() => window.sent), []);
  assert.equal(await page.locator('#comment').innerText(), '');
});

test('hidden duplicate is skipped and only Messenger receives the message', async t => {
  const page = await fixture(t, comment + chat.replace('id="chat"', 'id="hidden" style="display:none"') + chat);
  const locator = await fb.findComposeBox(page);
  assert.equal(await locator.getAttribute('id'), 'chat');
  const handle = await fb.waitComposeBox(page, 'fixture');
  await fb.typeAndSend(page, handle, 'Arrival\nSecond line');
  assert.deepEqual(await page.evaluate(() => window.sent), [{ id: 'chat', text: 'Arrival\nSecond line' }]);
  assert.equal(await page.locator('#comment').innerText(), '');
});

test('multiple visible chats fail closed', async t => {
  const page = await fixture(t, comment + chat + chat.replace('id="chat"', 'id="other"'));
  await assert.rejects(fb.findComposeBox(page), /nhiều ô Messenger/);
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('Aa-only and Vietnamese Messenger signatures are supported', async t => {
  const page = await fixture(t, comment + chat.replace(' aria-label="Write to Customer"', ''));
  assert.equal(await (await fb.findComposeBox(page)).getAttribute('id'), 'chat');
  await page.locator('#chat').evaluate(el => {
    el.removeAttribute('aria-placeholder');
    el.setAttribute('aria-label', 'Nhắn tin cho Khách');
  });
  assert.equal(await (await fb.findComposeBox(page)).getAttribute('id'), 'chat');
});

test('a detached pinned composer cannot rebind to the comment or a replacement', async t => {
  const page = await fixture(t, comment + chat);
  const handle = await page.$('#chat');
  await page.locator('#chat').evaluate(el => el.outerHTML = el.outerHTML);
  await assert.rejects(fb.typeAndSend(page, handle, 'Arrival'), /không còn hợp lệ/);
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('focus stolen by a comment before submission never presses Enter', async t => {
  const page = await fixture(t, comment + chat);
  const handle = await page.$('#chat');
  await page.evaluate(() => {
    document.querySelector('#chat').addEventListener('input', () => {
      document.querySelector('#comment').focus();
    });
  });
  await assert.rejects(fb.typeAndSend(page, handle, 'Arrival'), /mất focus/);
  assert.deepEqual(await page.evaluate(() => window.sent), []);
});

test('a failed Message button click is propagated before composer lookup', async () => {
  let lookups = 0;
  const page = { goto: async () => {}, waitForTimeout: async () => {},
    url: () => 'https://www.facebook.com/customer',
    locator: () => {
      lookups++;
      return { first: () => ({ isVisible: async () => true,
        click: async () => { throw new Error('Message click failed'); } }) };
    } };
  await assert.rejects(fb.openConversationByLink(page, page.url()), /Message click failed/);
  assert.equal(lookups, 1);
});
