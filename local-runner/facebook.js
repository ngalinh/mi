'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const testModeStore = require('./testModeStore');
const { getPage, closeContext, withProfileLock } = require('./browser');

/**
 * Báo hàng qua FACEBOOK MESSENGER cho những khách KHÔNG dùng Zalo.
 *
 * Login giống Xeko: mở facebook.com bằng persistent profile riêng (fb-<key>), nhân viên đăng
 * nhập tay 1 lần, session được lưu -> lần sau không phải login lại. Việc mở cửa sổ đăng nhập
 * dùng chung browser.openForLogin (đã có), file này lo phần KIỂM TRA đăng nhập và GỬI TIN.
 *
 * ⚠️ Phần GỬI TIN (tìm hội thoại theo SĐT trong Messenger + soạn/gửi) hiện là KHUNG STUB —
 * chờ chủ sản phẩm hướng dẫn từng bước + chụp element thật của Messenger rồi mới ráp selector.
 * Đến lúc đó chỉ cần điền vào các bước đánh dấu TODO bên dưới, KHÔNG phải đổi kiến trúc.
 */

// Chuẩn hóa SĐT để so khớp whitelist test-mode (bỏ ký tự không phải số, bỏ 84/0 đầu).
const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^84/, '').replace(/^0/, '');
function phoneAllowed(phone) {
  const { testMode, testPhones } = testModeStore.get();
  if (!testMode) return true;
  const t = normPhone(phone);
  return testPhones.some((tp) => normPhone(tp) === t && t !== '');
}

function shot(page, name) {
  try {
    if (!fs.existsSync(config.screenshotDir)) fs.mkdirSync(config.screenshotDir, { recursive: true });
    return page.screenshot({ path: path.join(config.screenshotDir, `${Date.now()}-fb-${name}.png`) }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Mở Facebook (trang chủ/messenger). */
async function gotoFacebook(page, url) {
  await page.goto(url || config.facebookChatUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await shot(page, '01-loaded');
}

/** Trả về locator đầu tiên đang HIỂN THỊ trong danh sách selector (poll tới timeout). null nếu không có. */
async function findVisible(page, selectors, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      // eslint-disable-next-line no-await-in-loop
      try { if (await el.isVisible()) return el; } catch { /* selector chưa gắn -> thử tiếp */ }
    }
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(300);
  }
  return null;
}

/**
 * Còn đăng nhập không: FB đẩy về /login hoặc /checkpoint khi hết session (giống ensureLoggedIn của Xeko).
 * Ném lỗi rõ ràng để luồng gọi báo "cần đăng nhập lại".
 */
async function ensureLoggedIn(page) {
  const url = page.url();
  if (/\/(login|checkpoint)/i.test(url) || /login\.php/i.test(url)) {
    throw new Error(`Session Facebook đã hết hạn (URL: ${url}). Vào "Tài khoản" bấm Đăng nhập để đăng nhập lại.`);
  }
}

// Ô SOẠN TIN của Messenger (Lexical contenteditable). Ưu tiên aria-label, fallback role=textbox.
const COMPOSE_BOX_SELECTORS = [
  'div[aria-label="Message"][contenteditable="true"]',
  'div[aria-label="Aa"][contenteditable="true"]',
  'div[aria-label="Tin nhắn"][contenteditable="true"]',
  'div[aria-label="Nhắn tin"][contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
];

/**
 * Chuẩn hoá link FB khách thành URL mở THẲNG hội thoại Messenger.
 *  - .../messages/t/<x>  -> giữ nguyên
 *  - m.me/<slug>         -> facebook.com/messages/t/<slug>
 *  - facebook.com/profile.php?id=123 -> messages/t/123
 *  - facebook.com/<username>          -> messages/t/<username>
 * Không parse được -> trả nguyên link để vẫn thử mở.
 */
function normalizeMessengerUrl(link) {
  const raw = String(link || '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
  catch { return raw; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  if (/\/messages\/t\//i.test(path)) return `https://www.facebook.com${path}`;
  if (host === 'm.me') {
    const slug = path.replace(/^\//, '');
    if (slug) return `https://www.facebook.com/messages/t/${slug}`;
  }
  if (host.endsWith('messenger.com') && /\/t\//i.test(path)) {
    return `https://www.facebook.com/messages/t/${path.split('/t/')[1]}`;
  }
  // Link hồ sơ facebook.com
  if (path === '/profile.php') {
    const id = u.searchParams.get('id');
    if (id) return `https://www.facebook.com/messages/t/${id}`;
  }
  const slug = path.replace(/^\//, '').split('/')[0];
  if (slug && slug !== 'messages') return `https://www.facebook.com/messages/t/${slug}`;
  return raw;
}

/** Mở THẲNG hội thoại của khách theo link đã lưu, chờ ô soạn tin xuất hiện. */
async function openConversationByLink(page, link) {
  const url = normalizeMessengerUrl(link);
  if (!url) throw new Error('Thiếu/không hợp lệ link Facebook của khách.');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await ensureLoggedIn(page);
  await shot(page, '02-conversation');
  const box = await findVisible(page, COMPOSE_BOX_SELECTORS, 15000);
  if (!box) {
    throw new Error('FB: không mở được khung chat (link sai, khách chặn/không nhắn được, hoặc giao diện Messenger đổi selector ô soạn tin).');
  }
  return box;
}

/**
 * Gõ nội dung vào ô soạn tin rồi GỬI. Messenger gửi bằng phím Enter; xuống dòng dùng Shift+Enter
 * nên phải gõ từng dòng để \n trong nội dung không gửi sớm giữa chừng.
 */
async function typeAndSend(page, box, message) {
  await box.click();
  const lines = String(message == null ? '' : message).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (lines[i]) await page.keyboard.type(lines[i], { delay: 15 });
    // eslint-disable-next-line no-await-in-loop
    if (i < lines.length - 1) await page.keyboard.down('Shift'), await page.keyboard.press('Enter'), await page.keyboard.up('Shift');
  }
  await page.waitForTimeout(300);
  await shot(page, '03-typed');
  await page.keyboard.press('Enter'); // gửi
  await page.waitForTimeout(1500);
  await shot(page, '04-sent');
}

/**
 * Gửi 1 tin nhắn báo hàng qua Facebook Messenger — mở THẲNG hội thoại theo link FB của khách.
 * Cùng chữ ký chung với salework.sendBaoHang để notifyService gọi thống nhất theo `channel`.
 * @param {{profile?:string, fbLink:string, keyword?:string, name?:string, message:string, strictMatch?:boolean}} p
 */
async function sendBaoHangFb({ profile = 'default', fbLink, keyword, name, message }) {
  if (!fbLink) throw new Error('Thiếu link Facebook của khách (fbLink).');
  if (!message) throw new Error('Thiếu nội dung tin nhắn.');

  // CHẶN AN TOÀN: ở chế độ TEST chỉ gửi tới số nằm trong TEST_PHONES (khớp theo SĐT đơn).
  if (!phoneAllowed(keyword)) {
    throw new Error(`TEST_MODE: bỏ qua "${keyword}" — không nằm trong TEST_PHONES (an toàn, không gửi).`);
  }

  // Tuần tự hoá theo profile: không mở trùng userDataDir với lệnh đăng nhập/kiểm tra cùng profile.
  return withProfileLock(profile, async () => {
    const page = await getPage(profile);
    try {
      const box = await openConversationByLink(page, fbLink);
      await typeAndSend(page, box, message);
    } finally {
      if (config.closeAfterSend) await closeContext(profile);
    }
    return { ok: true };
  });
}

/**
 * Kiểm tra 1 profile FB còn đăng nhập không (mở facebook.com rồi thử ensureLoggedIn).
 * @returns {Promise<{loggedIn:boolean, error?:string}>}
 */
async function checkLoggedInFb(profile = 'default') {
  return withProfileLock(profile, async () => {
    const page = await getPage(profile);
    try {
      await gotoFacebook(page, config.facebookLoginUrl);
      await ensureLoggedIn(page);
      return { loggedIn: true };
    } catch (e) {
      return { loggedIn: false, error: e.message };
    } finally {
      if (config.closeAfterSend) await closeContext(profile);
    }
  });
}

module.exports = { sendBaoHangFb, checkLoggedInFb, gotoFacebook, ensureLoggedIn, normalizeMessengerUrl };
