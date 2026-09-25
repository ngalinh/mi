'use strict';
// Offline browser fixtures only. No Facebook session or customer messages.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

const comment = '<div id="comment" contenteditable="true" role="textbox" data-lexical-editor="true" aria-label="Write a comment"></div>';
const button = '<button aria-label="Message" onclick="window.clicked = true">Message</button>';
const composer = (label = 'Write to Customer') => `<div id="composer" contenteditable="true" role="textbox" data-lexical-editor="true" aria-placeholder="Aa" aria-label="${label}"></div>`;
const popup = () => `<div role="dialog">${composer()}</div>`;

async function harness(t, html, onWait = async () => {}) {
  const realPage = await browser.newPage();
  t.after(() => realPage.close());
  let now = 0;
  let currentUrl;
  const page = {
    goto: async url => { currentUrl = url; await realPage.setContent(html); },
    url: () => currentUrl,
    locator: selector => realPage.locator(selector),
    evaluate: (...args) => realPage.evaluate(...args),
    keyboard: realPage.keyboard,
    waitForTimeout: async ms => { now += ms; await onWait(realPage, now); },
  };
  const mocks = {
    './config': {}, './browser': {}, './sendRecovery': {}, './testModeStore': {},
  };
  const context = {
    module: { exports: {} }, Date: { now: () => now }, URL,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../local-runner/facebook.js'), 'utf8') + `
    shot = async () => {};
    waitDomSettled = async () => {};
    module.exports = { openConversationByLink, typeAndSend };
  `, context);
  return { page, realPage, flow: context.module.exports, context, now: () => now };
}

test('clicks Message, waits for delayed popup, sends only inside chat with comments present', async t => {
  let opened = false;
  const h = await harness(t, comment + button, async (page, now) => {
    if (!opened && now >= 6000 && await page.evaluate(() => window.clicked)) {
      opened = true;
      await page.locator('body').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html), popup());
      await page.evaluate(() => {
        window.sent = [];
        document.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            window.sent.push({ target: event.target.id, text: event.target.textContent });
            event.target.textContent = '';
          }
        });
      });
    }
  });
  const box = await h.flow.openConversationByLink(h.page, 'https://facebook.com/customer');
  assert.equal(await h.realPage.evaluate(() => window.clicked), true);
  assert.ok(h.now() >= 6000);
  assert.equal(await box.getAttribute('id'), 'composer');
  await h.flow.typeAndSend(h.page, box, 'Hàng đã về');
  assert.deepEqual(await h.realPage.evaluate(() => window.sent), [{ target: 'composer', text: 'Hàng đã về' }]);
  assert.equal(await h.realPage.locator('#comment').innerText(), '');
});

test('comments and a generic Lexical textbox in a dialog cannot substitute for a popup', async t => {
  const h = await harness(t, comment + button + `<div role="dialog">${comment.replace('id="comment"', 'id="dialog-comment"')}</div>`);
  await assert.rejects(h.flow.openConversationByLink(h.page, 'https://facebook.com/customer'), /không mở được khung soạn tin/);
  assert.equal(await h.realPage.locator('#comment').innerText(), '');
});

test('click failure stops immediately instead of accepting a comment or old popup', async t => {
  const h = await harness(t, comment + button + popup());
  h.context.findVisible = async () => ({ click: async () => { throw Error('click failed'); } });
  await assert.rejects(h.flow.openConversationByLink(h.page, 'https://facebook.com/customer'), /click failed/);
  assert.equal(h.now(), 2500);
});

test('an existing chat cannot satisfy a failed popup opening', async t => {
  const h = await harness(t, comment + button + popup());
  await assert.rejects(h.flow.openConversationByLink(h.page, 'https://facebook.com/customer'), /không mở được khung soạn tin/);
});

test('hidden Message duplicate does not prevent clicking the visible Vietnamese button', async t => {
  const h = await harness(t, comment + '<button style="display:none" aria-label="Message">Message</button>' +
    '<div role="button" onclick="window.clicked=true">Nhắn tin</div>', async page => {
    if (await page.evaluate(() => window.clicked && !document.querySelector('#composer'))) {
      await page.locator('body').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html), popup());
    }
  });
  assert.equal(await (await h.flow.openConversationByLink(h.page, 'facebook.com/customer')).getAttribute('id'), 'composer');
});

test('direct Messenger links accept the conversation composer without a popup', async t => {
  const h = await harness(t, comment + composer());
  const box = await h.flow.openConversationByLink(h.page, 'https://facebook.com/messages/e2ee/t/123');
  assert.equal(await box.getAttribute('id'), 'composer');
});

test('composer disappearing during readiness fails instead of returning a stale locator', async t => {
  const h = await harness(t, comment + composer(), async (page, now) => {
    if (now >= 3100) await page.locator('#composer').evaluateAll(els => els.forEach(el => el.remove()));
  });
  await assert.rejects(h.flow.openConversationByLink(h.page, 'facebook.com/messages/t/123'), /chưa ổn định hoặc đã biến mất/);
});

test('changing recipient labels never pass the stability check', async t => {
  const h = await harness(t, composer(), async (page, now) => {
    await page.locator('#composer').evaluate((el, now) => el.setAttribute('aria-label', `Write to ${now}`), now);
  });
  await assert.rejects(h.flow.openConversationByLink(h.page, 'facebook.com/messages/t/123'), /chưa ổn định/);
});

test('multiple visible chat composers are rejected', async t => {
  const h = await harness(t, popup() + popup());
  await assert.rejects(h.flow.openConversationByLink(h.page, 'facebook.com/messages/t/123'), /nhiều khung chat/);
});

test('loading timeout prevents sending even with a visible composer', async t => {
  const h = await harness(t, composer() + '<div role="progressbar">Loading</div>');
  await assert.rejects(h.flow.openConversationByLink(h.page, 'facebook.com/messages/t/123'), /hội thoại chưa tải xong/);
});
