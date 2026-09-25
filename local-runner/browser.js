'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const accountsStore = require('./accountsStore');
const laneScope = require('../shared/notificationLane');
const shippingContexts = new Map();

/**
 * Quản lý 1 persistent context cho mỗi profile (account Salework/Zalo).
 * Giữ context sống giữa các lần gửi để không phải mở/đóng browser liên tục
 * và để giữ trạng thái đăng nhập.
 */

const contexts = new Map(); // profileName -> { context, lastUsed }

// Arrival/account management and shipping each have their own browser lock.
const _locks = new Map();
// Messenger must keep its persistent session (including encrypted chat state).
// Shipping Facebook shares the login/arrival browser and its lock.
function browserLane(profileName) {
  const account = accountsStore.get(profileName);
  return account?.platform === 'facebook' ? 'hang' : laneScope.current();
}

function withProfileLock(profileName, fn) {
  const key = browserLane(profileName);
  const prev = _locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => laneScope.run(key, fn));
  _locks.set(key, run.catch(() => {})); // tail nuốt lỗi để 1 lần fail không kẹt cả chuỗi
  return run;
}

/**
 * Thư mục userDataDir cho 1 profile. Prefix theo KÊNH để Zalo & Facebook của cùng 1 NV
 * không đụng nhau:  Zalo -> "salework-<key>" (giữ nguyên như cũ để không mất session đang có),
 * Facebook -> "fb-<key>". Khi không truyền platform, tự tra từ accountsStore theo key
 * (mặc định 'zalo' nếu không tìm thấy) — nhờ vậy mọi chỗ chỉ có `key` vẫn ra đúng thư mục.
 * @param {string} profileName  key của account
 * @param {('zalo'|'facebook')} [platform]
 */
function profilePath(profileName, platform) {
  const safe = String(profileName || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  let plat = platform;
  if (plat == null) {
    try { const a = accountsStore.get(profileName); plat = a && a.platform === 'facebook' ? 'facebook' : 'zalo'; }
    catch { plat = 'zalo'; }
  }
  const prefix = plat === 'facebook' ? 'fb' : 'salework';
  return path.join(config.dataDir, `${prefix}-${safe}`);
}

/**
 * Phân tích chuỗi proxy đã gán cho tài khoản thành option proxy của Playwright.
 * Hỗ trợ:
 *   - "host:port"
 *   - "user:pass@host:port"
 *   - "host:port:user:pass"  (định dạng dấu hai chấm phổ biến của nhà cung cấp proxy VN)
 *   - "user:pass:host:port"
 *   - có/không tiền tố scheme (http://, https://, socks5://...).
 * @param {string} raw
 * @returns {{server:string, username?:string, password?:string}|null} null nếu rỗng/không có host:port.
 */
function parseProxy(raw) {
  let rest = String(raw || '').trim();
  if (!rest) return null;
  let scheme = 'http://';
  const m = rest.match(/^([a-z0-9]+:\/\/)/i);
  if (m) { scheme = m[1]; rest = rest.slice(m[1].length); }
  let username; let password; let hostport;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    // Dạng "user:pass@host:port"
    const cred = rest.slice(0, at);
    hostport = rest.slice(at + 1).trim();
    const ci = cred.indexOf(':');
    if (ci !== -1) { username = cred.slice(0, ci).trim(); password = cred.slice(ci + 1).trim(); }
    else { username = cred.trim(); }
  } else {
    // Không có "@": có thể là "host:port", "host:port:user:pass" hoặc "user:pass:host:port".
    const parts = rest.split(':').map((s) => s.trim());
    const isPort = (s) => /^\d{1,5}$/.test(s);
    if (parts.length === 4) {
      if (isPort(parts[1])) {
        // host:port:user:pass — cổng ở vị trí 2
        hostport = `${parts[0]}:${parts[1]}`; username = parts[2]; password = parts[3];
      } else if (isPort(parts[3])) {
        // user:pass:host:port — cổng ở vị trí cuối
        username = parts[0]; password = parts[1]; hostport = `${parts[2]}:${parts[3]}`;
      } else {
        hostport = rest; // không rõ cấu trúc, giữ nguyên
      }
    } else {
      hostport = parts.join(':'); // "host:port" hoặc chỉ "host"
    }
  }
  if (!hostport) return null; // thiếu host:port
  const opt = { server: scheme + hostport };
  if (username != null && username !== '') opt.username = username;
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
    // KHÔNG để Playwright tự bắt tín hiệu: local-runner/index.js đã có gracefulShutdown lo
    // đóng context có hạn cứng. Nếu bật (mặc định), handler của Playwright cố đóng Chrome khi
    // nhận SIGINT/SIGTERM; Chrome treo là kẹt luôn tiến trình -> pm2 restart treo.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
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
  const lane = browserLane(profileName);
  if (lane !== laneScope.current()) return laneScope.run(lane, () => getContext(profileName));
  if (laneScope.current() === 'ship') return getShippingContext(profileName);
  for (const name of contexts.keys()) if (name !== profileName) await closeContext(name);
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
  // Cấp quyền clipboard để dán nội dung bằng Ctrl+V thật (Facebook Messenger) — dùng cho báo FB.
  // Bỏ qua an toàn nếu trình duyệt không hỗ trợ cấp quyền (không ảnh hưởng luồng Zalo).
  try { await context.grantPermissions(['clipboard-read', 'clipboard-write']); } catch { /* ignore */ }
  context.on('close', () => { if (contexts.get(profileName)?.context === context) contexts.delete(profileName); });
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
 * trên cửa sổ vừa mở, giữ nguyên cửa sổ để dùng cho các lần gửi tiếp theo.
 * @param {string} profileName
 * @param {string} url  trang để mở (vd config.saleworkLoginUrl)
 * @param {(ev:'opened'|'closed')=>void} [onEvent] callback để ghi log lịch sử
 * @param {{email:string,password:string}} [prefill] tự điền tài khoản + mật khẩu vào form login
 *        (Facebook dùng ô name="email"/name="pass"; Zalo Basso dùng ô text đầu + ô mật khẩu). Nhân
 *        viên chỉ cần bấm đăng nhập / xử lý xác minh. Bỏ qua an toàn nếu trang không có ô mật khẩu.
 * @returns {Promise<void>} resolve khi cửa sổ đã mở & điều hướng xong
 */
async function openForLogin(profileName, url, onEvent, prefill) {
  // Chỉ khoá trong lúc mở/điền form. Các lệnh sau tái dùng cùng context và tự kiểm tra
  // đăng nhập; không bắt nhân viên đóng cửa sổ mới giải phóng hàng đợi.
  return withProfileLock(profileName, async () => {
    const context = await getContext(profileName);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // Tự điền tài khoản + mật khẩu nếu có (giống Xeko) — nhân viên chỉ cần bấm đăng nhập.
    if (prefill && prefill.password) {
      try {
        const fbEmail = await page.$('input[name="email"]');
        if (fbEmail) {
          // Form login Facebook: ô name="email" + name="pass".
          if (prefill.email) await fbEmail.fill(prefill.email);
          await page.fill('input[name="pass"]', prefill.password);
        } else {
          // Form login Zalo Basso (Vuetify): ô mật khẩu + ô text đầu tiên = tài khoản.
          const passEl = await page.$('input[type="password"]');
          if (passEl) {
            const userEl = await page.$('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
            if (userEl && prefill.email) await userEl.fill(prefill.email);
            await passEl.fill(prefill.password);
          }
        }
      } catch { /* trang không phải form login -> bỏ qua, để nhân viên tự đăng nhập */ }
    }
    if (typeof onEvent === 'function') onEvent('opened');
    context.once('close', () => { if (typeof onEvent === 'function') onEvent('closed'); });
  });
}

/** Đóng trình duyệt của 1 profile (session đăng nhập vẫn lưu trong userDataDir nên lần sau mở lại vẫn đăng nhập). */
async function closeContext(profileName) {
  const lane = browserLane(profileName);
  if (lane !== laneScope.current()) return laneScope.run(lane, () => closeContext(profileName));
  if (laneScope.current() === 'ship') {
    const entry = shippingContexts.get(profileName);
    if (entry) { await entry.browser.close(); shippingContexts.delete(profileName); }
    return;
  }
  const entry = contexts.get(profileName);
  if (!entry) return;
  await entry.context.close();
  contexts.delete(profileName);
}

async function closeAll() {
  for (const entry of shippingContexts.values()) {
    try { await entry.browser.close(); } catch { /* ignore */ }
  }
  shippingContexts.clear();
  for (const [name, entry] of contexts) {
    try { await entry.context.close(); } catch { /* ignore */ }
    contexts.delete(name);
  }
}

module.exports = { getContext, getPage, profileExists, profilePath, closeContext, closeAll, openForLogin, withProfileLock };

// A separate Chromium process uses a snapshot of the account's login state.
// Never open the same persistent userDataDir twice or navigate the arrival page.
async function getShippingContext(profileName) {
  for (const name of shippingContexts.keys()) if (name !== profileName) await closeContext(name);
  const existing = shippingContexts.get(profileName);
  if (existing) return existing.context;
  let storageState;
  const source = contexts.get(profileName);
  if (source) {
    storageState = await source.context.storageState({ indexedDB: true });
  } else {
    // Read the saved session under the arrival lock, without closing its active profile.
    storageState = await laneScope.run('hang', () => withProfileLock(profileName, async () => {
      const current = contexts.get(profileName);
      if (current) return current.context.storageState({ indexedDB: true });
      const temporary = await safeLaunchPersistentContext(profilePath(profileName), proxyForProfile(profileName));
      try { return await temporary.storageState({ indexedDB: true }); }
      finally { await temporary.close(); }
    }));
  }
  const browser = await chromium.launch({
    headless: config.headless, slowMo: config.slowMo,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
    ...(proxyForProfile(profileName) ? { proxy: proxyForProfile(profileName) } : {}),
  });
  try {
    const context = await browser.newContext({ storageState, viewport: { width: 1366, height: 850 } });
    try { await context.grantPermissions(['clipboard-read', 'clipboard-write']); } catch { /* ignore */ }
    shippingContexts.set(profileName, { browser, context });
    const forget = () => {
      if (shippingContexts.get(profileName)?.context === context) shippingContexts.delete(profileName);
    };
    browser.on('disconnected', forget);
    context.on('close', forget);
    return context;
  } catch (err) {
    await browser.close();
    throw err;
  }
}
