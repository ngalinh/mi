'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const accountsStore = require('./accountsStore');

/**
 * Quản lý 1 persistent context cho mỗi profile (account Salework/Zalo).
 * Giữ context sống giữa các lần gửi để không phải mở/đóng browser liên tục
 * và để giữ trạng thái đăng nhập.
 */

const contexts = new Map(); // profileName -> { context, lastUsed }

// Khoá TUẦN TỰ HOÁ theo profile: 2 thao tác trên CÙNG userDataDir (gửi tin / đăng nhập /
// kiểm tra) KHÔNG được chạy song song — Chromium giữ SingletonLock trên userDataDir, mở
// đồng thời sẽ crash hoặc đóng context của nhau giữa chừng. Mỗi profile 1 chuỗi promise;
// profile khác nhau chạy độc lập. (jobQueue chỉ tuần tự hoá GỬI, không bao các endpoint account.)
const _locks = new Map(); // profileName -> Promise (tail)
function withProfileLock(profileName, fn) {
  const key = profileName || 'default';
  const prev = _locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  _locks.set(key, run.catch(() => {})); // tail nuốt lỗi để 1 lần fail không kẹt cả chuỗi
  return run;
}

function profilePath(profileName) {
  const safe = String(profileName || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(config.dataDir, `salework-${safe}`);
}

/**
 * Phân tích chuỗi proxy đã gán cho tài khoản thành option proxy của Playwright.
 * Hỗ trợ: "host:port", "user:pass@host:port", có/không tiền tố scheme (http://, socks5://...).
 * @param {string} raw
 * @returns {{server:string, username?:string, password?:string}|null} null nếu rỗng/không có host:port.
 */
function parseProxy(raw) {
  let rest = String(raw || '').trim();
  if (!rest) return null;
  let scheme = 'http://';
  const m = rest.match(/^([a-z0-9]+:\/\/)/i);
  if (m) { scheme = m[1]; rest = rest.slice(m[1].length); }
  let username; let password;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const cred = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const ci = cred.indexOf(':');
    if (ci !== -1) { username = cred.slice(0, ci); password = cred.slice(ci + 1); }
    else { username = cred; }
  }
  if (!rest) return null; // thiếu host:port
  const opt = { server: scheme + rest };
  if (username != null) opt.username = username;
  if (password != null) opt.password = password;
  return opt;
}

// Lấy proxy đã gán cho profile (account key) từ store. Lỗi đọc store -> không dùng proxy.
function proxyForProfile(profileName) {
  try {
    const a = accountsStore.get(profileName);
    return a ? parseProxy(a.proxy) : null;
  } catch { return null; }
}

async function safeLaunchPersistentContext(userDataDir, proxy) {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const opts = {
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: { width: 1366, height: 850 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  if (proxy) opts.proxy = proxy;
  return chromium.launchPersistentContext(userDataDir, opts);
}

/**
 * Lấy (hoặc tạo) context cho profile và trả về 1 page sẵn sàng.
 */
async function getContext(profileName) {
  let entry = contexts.get(profileName);
  if (entry && entry.context) {
    // kiểm tra context còn sống
    try {
      entry.context.pages();
      entry.lastUsed = Date.now();
      return entry.context;
    } catch {
      contexts.delete(profileName);
    }
  }
  const proxy = proxyForProfile(profileName);
  if (proxy) console.log(`[browser] profile "${profileName}" dùng proxy ${proxy.server}${proxy.username ? ' (có auth)' : ''}`);
  const context = await safeLaunchPersistentContext(profilePath(profileName), proxy);
  context.on('close', () => contexts.delete(profileName));
  entry = { context, lastUsed: Date.now() };
  contexts.set(profileName, entry);
  return context;
}

async function getPage(profileName) {
  const context = await getContext(profileName);
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  return page;
}

/** Kiểm tra profile đã từng đăng nhập (có thư mục data) chưa */
function profileExists(profileName) {
  return fs.existsSync(profilePath(profileName));
}

/**
 * Mở Chromium (headed) cho 1 profile để ĐĂNG NHẬP THỦ CÔNG + chọn tài khoản, rồi TRẢ VỀ NGAY
 * (không chờ user đóng). Dùng cho endpoint thêm/re-login tài khoản Zalo: nhân viên đăng nhập
 * trên cửa sổ vừa mở, đóng lại là session được lưu vào userDataDir.
 * @param {string} profileName
 * @param {string} url  trang để mở (vd config.saleworkLoginUrl)
 * @param {(ev:'opened'|'closed')=>void} [onEvent] callback để ghi log lịch sử
 * @returns {Promise<void>} resolve khi cửa sổ đã mở & điều hướng xong
 */
async function openForLogin(profileName, url, onEvent) {
  // GIỮ khoá profile tới khi cửa sổ đóng -> trong lúc nhân viên đăng nhập thủ công, mọi
  // lệnh gửi/kiểm tra cùng profile sẽ XẾP HÀNG chờ (an toàn) thay vì mở trùng userDataDir.
  return withProfileLock(profileName, () => new Promise((resolve) => {
    (async () => {
      const context = await getContext(profileName);
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      if (typeof onEvent === 'function') onEvent('opened');
      let done = false;
      const finish = () => { if (done) return; done = true; if (typeof onEvent === 'function') onEvent('closed'); resolve(); };
      context.on('close', finish);
    })().catch((e) => { console.error(`[browser] openForLogin lỗi: ${e.message}`); resolve(); });
  }));
}

/** Đóng trình duyệt của 1 profile (session đăng nhập vẫn lưu trong userDataDir nên lần sau mở lại vẫn đăng nhập). */
async function closeContext(profileName) {
  const entry = contexts.get(profileName);
  if (!entry) return;
  try { await entry.context.close(); } catch { /* ignore */ }
  contexts.delete(profileName);
}

async function closeAll() {
  for (const [name, entry] of contexts) {
    try { await entry.context.close(); } catch { /* ignore */ }
    contexts.delete(name);
  }
}

module.exports = { getContext, getPage, profileExists, profilePath, closeContext, closeAll, openForLogin, withProfileLock };
