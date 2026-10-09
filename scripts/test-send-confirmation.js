'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { bassoReceipt, bassoThread, armBasso, armFacebook } = require('../local-runner/sendConfirmation');
const expected = { origin: 'https://zalo.basso.vn', conversationId: '42', message: 'Đơn hàng\n123', ids: ['old'] };
const valid = () => ({ url: 'https://zalo.basso.vn/api/conversations/42/messages', method: 'POST',
  requestBody: { content: expected.message }, status: 201,
  body: { id: 'new', zaloMsgId: '123456789', conversationId: '42', senderType: 'self', content: expected.message } });

test('Basso requires exact content, conversation and fresh CRM/Zalo message IDs', () => {
  assert.equal(bassoReceipt(valid(), expected).confirmed, true);
  for (const mutate of [
    r => { r.status = 500; }, r => { delete r.body.zaloMsgId; }, r => { r.body.zaloMsgId = '0'; },
    r => { r.body.id = 'old'; }, r => { r.body.conversationId = 'other'; },
    r => { r.body.content = expected.message.slice(0, 5); }, r => { r.body.senderType = 'contact'; },
    r => { r.body.error = 'failed'; }, r => { r.requestBody.content = 'unrelated'; },
    r => { r.body.status = 'pending'; }, r => { r.body.deliveryStatus = 'failed'; },
    r => { r.url = r.url.replace('/42/', '/other/'); }, r => { r.url = r.url.replace('zalo.basso.vn', 'other.example'); },
  ]) { const receipt = valid(); mutate(receipt); assert.equal(bassoReceipt(receipt, expected), null); }
});

test('all attachments must have platform acknowledgment; HTTP OK or partial success is insufficient', () => {
  const e = { ...expected, fileNames: ['a.png', 'b.png'] };
  const r = { ...valid(), url: valid().url.replace('messages','attachments'), rawBody: 'filename="a.png" filename="b.png"',
    body: { messages: [{ ...valid().body }, { ...valid().body, id: 'second' }] } };
  assert.equal(bassoReceipt(r,e).attachmentCount, 2);
  r.body.messages.pop(); assert.equal(bassoReceipt(r,e), null);
});

function bassoHarness() {
  const page = new EventEmitter();
  let thread = { conversationId: '42', ids: ['old'] };
  page.url = () => expected.origin + '/chat';
  page.waitForTimeout = () => new Promise(resolve => setTimeout(resolve, 1));
  const composer = { evaluate: async () => thread };
  const emit = (data = valid(), fresh = true) => {
    const req = { method: () => data.method, postDataJSON: () => data.requestBody };
    if (fresh) page.emit('request', req);
    page.emit('response', { request: () => req, url: () => data.url, status: () => data.status, json: async () => data.body });
  };
  return { page, composer, emit, setThread: value => { thread = value; } };
}
test('response listener only accepts requests started after send was armed and always detaches', async () => {
  const h = bassoHarness();
  const verifier = await armBasso(h.page, h.composer, expected.message);
  verifier.start(); h.emit(valid(), false);
  await assert.rejects(verifier.wait(10), /NEEDS_CHECK/);
  h.emit(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await verifier.wait(50)).platformMessageId, '123456789');
  verifier.dispose(); assert.equal(h.page.listenerCount('response'),0); assert.equal(h.page.listenerCount('request'),0);
});
test('switching conversation cannot confirm a receipt for another customer', async () => {
  const h = bassoHarness(), verifier = await armBasso(h.page,h.composer,expected.message);
  verifier.start(); h.emit(); await new Promise(resolve => setImmediate(resolve));
  h.setThread({ conversationId: 'other', ids: [] });
  await assert.rejects(verifier.wait(20), /NEEDS_CHECK/); verifier.dispose();
});

function facebookHarness(oldText = 'previous message') {
  const row = (text, status) => ({ innerText: text + ' ' + status, attributes: {}, getClientRects: () => [1],
    getAttribute(name) { return this.attributes[name]; }, setAttribute(name,value) { this.attributes[name]=value; },
    querySelectorAll(selector) { return selector.includes('dir=') ? [{ innerText: text }] : [{ getAttribute: name => name === 'aria-label' ? status : null }]; },
  });
  const rows = [row(oldText, 'Sent')];
  const grid = { isConnected: true, attributes: {}, querySelectorAll: () => rows,
    getAttribute(name) { return this.attributes[name]; }, setAttribute(name,value) { this.attributes[name]=value; } };
  const document = { body: {}, documentElement: {}, querySelector: () => grid };
  const box = { evaluate: async (fn,arg) => vm.runInNewContext(`(${fn}) (el,arg)`, {
    document, el: { parentElement: { querySelector: () => grid } }, arg }) };
  const page = { url: () => 'https://www.facebook.com/messages/t/42', waitForTimeout: () => new Promise(resolve => setTimeout(resolve,1)),
    evaluate: async (fn,arg) => vm.runInNewContext(`(${fn}) (arg)`, { document, arg }) };
  return { page, box, rows, row };
}
test('Messenger ignores old rows, empty composer, previews, partial content and pending/failed status', async () => {
  const h = facebookHarness(), verifier = await armFacebook(h.page,h.box,expected.message);
  for (const [text,status] of [[expected.message,'Sending'],[expected.message,'Not sent'],[expected.message.slice(0,5),'Sent'],['sidebar preview','Sent']]) {
    h.rows.push(h.row(text,status)); await assert.rejects(verifier.wait(5), /NEEDS_CHECK/);
  }
  // Same text remounted from old history must not look like a fresh send.
  h.rows.push(h.row('previous message','Sent')); await assert.rejects(verifier.wait(5), /NEEDS_CHECK/);
  verifier.dispose();
});

test('Messenger accepts a new exact message with a delivery status, but identical historical text needs review', async () => {
  const h = facebookHarness(), verifier = await armFacebook(h.page,h.box,expected.message);
  h.rows.push(h.row(expected.message,'Delivered'));
  assert.equal((await verifier.wait(20)).confirmed,true);
  const duplicate = facebookHarness(expected.message), repeated = await armFacebook(duplicate.page,duplicate.box,expected.message);
  duplicate.rows.push(duplicate.row(expected.message,'Delivered'));
  await assert.rejects(repeated.wait(5), /NEEDS_CHECK/);
});

test('production Vue rendered tree resolves only the thread that contains the composer', async () => {
  const el = { parentElement: null };
  const make = (id, contains) => ({ component: { props: { conversation:{ id }, messages:[{ id:'old' }] }, subTree:{ el:{ contains: () => contains } } } });
  el.parentElement = { _vnode:{ children:[make('wrong',false),make('42',true)] } };
  const composer = { evaluate: async fn => vm.runInNewContext(`(${fn})(el)`, { el }) };
  const result = await bassoThread(composer);
  assert.equal(result.conversationId,'42'); assert.equal(result.ids[0],'old');
});

function proxyFor(result, pathName = '/api/zalo/send') {
  const file = path.join(__dirname,'../server/playwrightProxy.js');
  const mocks = {
    './config': { playwrightLocalUrl: 'http://runner' }, './localRegistry': { getFreshUrl: () => null },
    './accountQueue': { dispatchSend: (_path, payload,send) => send(payload) },
    'node-fetch': async (url,opts) => ({ ok: true, json: async () => opts?.method === 'POST' ? { jobId:'job' } : { job: { status:'done', result } } }),
  };
  const ctx = { module: { exports:{} }, console, Date, setTimeout: fn => fn(), require: name => mocks[name] || createRequire(file)(name) };
  vm.runInNewContext(fs.readFileSync(file,'utf8'),ctx);
  return pathName.includes('facebook') ? ctx.module.exports.sendBaoHangFb({}) : ctx.module.exports.sendBaoHang({});
}
test('job done never marks a send successful without runner success and channel confirmation', async () => {
  for (const result of [null, { ok:false }, { ok:true }, { ok:true, confirmation:{ confirmed:true } },
    { ok:true, confirmation:{ confirmed:true, method:'basso-api-zalo-id', messageId:'new' } }]) {
    const outcome = await proxyFor(result); assert.equal(outcome.ok,false); assert.match(outcome.error,/NEEDS_CHECK/);
  }
  assert.equal((await proxyFor({ ok:true, confirmation:bassoReceipt(valid(),expected) })).ok,true);
  assert.equal((await proxyFor({ ok:true, confirmation:{ confirmed:true, method:'messenger-new-row-sent-status' } },'/api/facebook/send')).ok,true);
});
