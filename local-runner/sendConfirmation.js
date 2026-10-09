'use strict';
const crypto = require('node:crypto');
const trace = require('../shared/sendTrace');
const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const validId = value => value != null && String(value) !== '' && String(value) !== '0';
const validZaloId = value => /^[1-9]\d*$/.test(String(value || ''));

// Public Basso MessageThread props contain the active conversation and server messages.
// Never read the sidebar or composer as evidence of delivery.
async function bassoThread(composer) {
  return composer.evaluate(el => {
    const snapshot = props => ({ conversationId: String(props.conversation.id), ids: props.messages.map(m => String(m.id)) });
    for (let node = el; node; node = node.parentElement) {
      for (let component = node.__vueParentComponent; component; component = component.parent) {
        const props = component.props;
        if (props?.conversation?.id != null && Array.isArray(props.messages)) {
          return snapshot(props);
        }
      }
      // Production Vue omits __vueParentComponent; the renderer keeps _vnode
      // on the app container. Walk only the rendered component tree.
      if (node._vnode) {
        const queue = [node._vnode], visited = new Set();
        while (queue.length) {
          const vnode = queue.shift();
          if (!vnode || typeof vnode !== 'object' || visited.has(vnode)) continue;
          visited.add(vnode);
          const component = vnode.component, props = component?.props;
          const rendered = component?.subTree?.el || vnode.el;
          if (props?.conversation?.id != null && Array.isArray(props.messages) && rendered?.contains?.(el)) return snapshot(props);
          if (component?.subTree) queue.push(component.subTree);
          if (Array.isArray(vnode.children)) queue.push(...vnode.children);
          if (vnode.suspense?.activeBranch) queue.push(vnode.suspense.activeBranch);
        }
      }
    }
    return null;
  });
}

function bassoReceipt({ url, method, requestBody, rawBody, status, body }, expected) {
  let endpoint;
  try { endpoint = new URL(url); } catch { return null; }
  const match = endpoint.pathname.match(/\/conversations\/([^/]+)\/(messages|attachments)\/?$/);
  if (!match || endpoint.origin !== expected.origin || method !== 'POST'
    || decodeURIComponent(match[1]) !== expected.conversationId) return null;
  if (expected.fileNames?.length) {
    if (match[2] !== 'attachments' || !expected.fileNames.every(name => String(rawBody || '').includes(`filename="${name}"`))) return null;
  } else if (match[2] !== 'messages' || normalize(requestBody?.content) !== normalize(expected.message)) return null;
  // HTTP success or a CRM database ID alone does not prove that Zalo accepted the send.
  if (status < 200 || status >= 300 || body?.error || body?.success === false || body?.ok === false) return null;
  const messages = expected.fileNames?.length ? (Array.isArray(body) ? body : body?.messages) : [body];
  if (!Array.isArray(messages) || messages.length !== (expected.fileNames?.length || 1)) return null;
  if (new Set(messages.map(message => String(message?.id))).size !== messages.length) return null;
  if (messages.some(message => !validId(message?.id) || !validZaloId(message?.zaloMsgId) || message.senderType !== 'self'
    || message.error || /^(pending|queued|sending|failed|error)$/i.test(String(message.status || message.deliveryStatus || ''))
    || (!expected.fileNames?.length && normalize(message.content) !== normalize(expected.message))
    || expected.ids.includes(String(message.id))
    || (message.conversationId != null && String(message.conversationId) !== expected.conversationId))) return null;
  return { confirmed: true, method: 'basso-api-zalo-id', conversationId: expected.conversationId,
    messageId: String(messages[0].id), platformMessageId: String(messages[0].zaloMsgId), attachmentCount: expected.fileNames?.length || 0 };
}

async function armBasso(page, composer, message, { fileNames } = {}) {
  const thread = await bassoThread(composer);
  if (!thread?.conversationId) throw Error('UI_NOT_READY: không xác định được hội thoại để xác nhận tin Zalo; chưa bấm Gửi.');
  const expected = { ...thread, origin: new URL(page.url()).origin, message, fileNames };
  let receipt = null, rejected = false, armed = false;
  const newRequests = new WeakSet();
  const onRequest = request => { if (armed) newRequests.add(request); };
  const listener = async response => {
    if (!armed) return;
    try {
      const request = response.request();
      if (!newRequests.has(request)) return;
      const endpoint = new URL(response.url());
      if (endpoint.origin !== expected.origin || request.method() !== 'POST'
        || !endpoint.pathname.replace(/\/$/, '').endsWith(`/conversations/${encodeURIComponent(expected.conversationId)}/${fileNames?.length ? 'attachments' : 'messages'}`)) return;
      let requestBody;
      try { requestBody = request.postDataJSON(); } catch {}
      const data = { url: response.url(), method: request.method(), requestBody, rawBody: fileNames?.length ? request.postData() : undefined, status: response.status(), body: await response.json() };
      const result = bassoReceipt(data, expected);
      if (result) receipt = result;
      else if (data.method === 'POST' && new URL(data.url).origin === expected.origin
        && new URL(data.url).pathname.replace(/\/$/, '').endsWith(`/conversations/${encodeURIComponent(expected.conversationId)}/messages`)
        && normalize(data.requestBody?.content) === normalize(message)) {
        rejected = true;
        trace.log('zalo.confirm.api-unverified', { httpStatus: data.status, hasMessageId: validId(data.body?.id), hasZaloId: validZaloId(data.body?.zaloMsgId), apiError: String(data.body?.error || '').slice(0, 200) });
      }
    } catch { /* Unknown protocol or malformed reply is never success. */ }
  };
  page.on('request', onRequest);
  page.on('response', listener);
  return {
    start() { armed = true; },
    async wait(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = await bassoThread(composer).catch(() => null);
        if (current?.conversationId !== expected.conversationId) break;
        if (receipt) { trace.log('zalo.confirm.result', receipt); return receipt; }
        if (rejected) break;
        await page.waitForTimeout(300);
      }
      throw Error('NEEDS_CHECK: chưa có xác nhận API và mã tin Zalo cho đúng hội thoại; kiểm tra tin trước khi gửi lại.');
    },
    dispose() { page.off('response', listener); page.off('request', onRequest); },
  };
}

// Messenger exposes delivery status through accessibility labels. Scope to the
// conversation containing the composer; require a new full message AND sent status.
async function armFacebook(page, box, message) {
  const token = crypto.randomUUID();
  const url = page.url();
  const ready = await box.evaluate((el, token) => {
    let root = el.parentElement;
    while (root && !root.querySelector('[role="grid"]')) root = root.parentElement;
    if (!root || root === document.body || root === document.documentElement) return false;
    const grid = root.querySelector('[role="grid"]');
    grid.setAttribute('data-mi-confirm-root', token);
    grid.setAttribute('data-mi-confirm-baseline', JSON.stringify([...grid.querySelectorAll('[role="row"]')].map(row => row.innerText)));
    grid.setAttribute('data-mi-confirm-texts', JSON.stringify([...grid.querySelectorAll('[role="row"]')].flatMap(row =>
      [...row.querySelectorAll('[dir="auto"]')].map(el => el.innerText))));
    for (const row of grid.querySelectorAll('[role="row"]')) row.setAttribute('data-mi-confirm-old', token);
    return true;
  }, token);
  if (!ready) throw Error('UI_NOT_READY: không xác định được khung hội thoại Messenger để xác nhận; chưa bấm Gửi.');
  return {
    async wait(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && page.url() === url) {
        const confirmed = await page.evaluate(({ token, message }) => {
          const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
          const grid = document.querySelector(`[data-mi-confirm-root="${token}"]`);
          if (!grid?.isConnected) return false;
          const baseline = new Set(JSON.parse(grid.getAttribute('data-mi-confirm-baseline') || '[]'));
          const oldTexts = new Set(JSON.parse(grid.getAttribute('data-mi-confirm-texts') || '[]').map(norm));
          for (const row of grid.querySelectorAll('[role="row"]')) {
            if (row.getAttribute('data-mi-confirm-old') === token || baseline.has(row.innerText) || !row.getClientRects().length) continue;
            // With no stable Messenger message ID, repeated identical text cannot
            // distinguish a new send from remounted history. Require human review.
            if (oldTexts.has(norm(message))) continue;
            const exactText = [...row.querySelectorAll('[dir="auto"]')].some(el => norm(el.innerText) === norm(message));
            const sentStatus = [...row.querySelectorAll('[aria-label], [title]')].some(el =>
              /^(sent|delivered|seen|đã gửi|đã nhận|đã xem)(?:[.:]|$)/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || ''));
            const failed = [...row.querySelectorAll('[aria-label], [title]')].some(el =>
              /sending|not sent|failed|couldn't send|đang gửi|chưa gửi|không gửi được/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || ''));
            if (exactText && sentStatus && !failed) return true;
          }
          return false;
        }, { token, message }).catch(() => false);
        if (confirmed) return { confirmed: true, method: 'messenger-new-row-sent-status' };
        await page.waitForTimeout(300);
      }
      throw Error('NEEDS_CHECK: chưa thấy tin mới có trạng thái Đã gửi trong đúng hội thoại Messenger; kiểm tra trước khi gửi lại.');
    },
    dispose() {},
  };
}
module.exports = { armBasso, armFacebook, bassoReceipt, bassoThread };
