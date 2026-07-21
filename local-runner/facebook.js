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

// Ô SOẠN TIN của Messenger (Lexical contenteditable). LƯU Ý: aria-label là "Write to <Tên>"
// (đổi theo khách + ngôn ngữ) nên KHÔNG dùng làm selector. Thứ bền: aria-placeholder="Aa" +
// data-lexical-editor="true" + role="textbox".
const COMPOSE_BOX_SELECTORS = [
  'div[contenteditable="true"][role="textbox"][aria-placeholder="Aa"]',
  'div[data-lexical-editor="true"][contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"][role="textbox"]',
];
// Nút "Nhắn tin"/"Message" trên trang hồ sơ khách (fallback khi mở thẳng link chat không ra khung soạn).
const MESSAGE_BUTTON_SELECTORS = [
  'div[aria-label="Message"][role="button"]',
  'div[aria-label="Nhắn tin"][role="button"]',
  'a[aria-label="Message"]',
  'a[aria-label="Nhắn tin"]',
];

/**
 * Phân loại link FB của khách thành 2 loại để mở đúng cách:
 *  - 'message': link trỏ THẲNG vào 1 hội thoại Messenger có sẵn
 *      .../messages/t/<id>  |  m.me/<slug>  |  messenger.com/t/<id>
 *      -> mở thẳng vào hội thoại.
 *  - 'profile': link HỒ SƠ khách
 *      facebook.com/<username>  |  facebook.com/profile.php?id=123
 *      -> mở trang hồ sơ rồi bấm nút "Nhắn tin"/"Message" (KHÔNG đoán messages/t nữa).
 *  - 'unknown': không parse được / không phải link FB.
 * @returns {{type:'message'|'profile'|'unknown', messengerUrl?:string, profileUrl?:string}}
 */
function classifyFbLink(link) {
  const raw = String(link || '').trim();
  if (!raw) return { type: 'unknown' };
  let u;
  try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
  catch { return { type: 'unknown' }; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');

  // --- Link dạng MESSAGE: mở thẳng hội thoại ---
  if (/\/messages\/t\//i.test(path)) {
    return { type: 'message', messengerUrl: `https://www.facebook.com${path}` };
  }
  if (host === 'm.me') {
    const slug = path.replace(/^\//, '');
    if (slug) return { type: 'message', messengerUrl: `https://www.facebook.com/messages/t/${slug}` };
  }
  if (host.endsWith('messenger.com') && /\/t\//i.test(path)) {
    return { type: 'message', messengerUrl: `https://www.facebook.com/messages/t/${path.split('/t/')[1]}` };
  }

  // --- Link dạng HỒ SƠ: mở profile rồi bấm "Nhắn tin" ---
  if (host.endsWith('facebook.com')) {
    if (path === '/profile.php') {
      const id = u.searchParams.get('id');
      if (id) return { type: 'profile', profileUrl: `https://www.facebook.com/profile.php?id=${id}` };
    }
    const slug = path.replace(/^\//, '').split('/')[0];
    if (slug && slug !== 'messages') {
      return { type: 'profile', profileUrl: `https://www.facebook.com${path}` };
    }
  }
  return { type: 'unknown' };
}

/**
 * (Giữ tương thích) Chuẩn hoá link FB thành URL hội thoại Messenger nếu là link message,
 * ngược lại trả nguyên link. Dùng classifyFbLink cho luồng mở thực tế.
 */
function normalizeMessengerUrl(link) {
  const info = classifyFbLink(link);
  return info.messengerUrl || String(link || '').trim();
}

/** Mở hội thoại rồi chờ ô soạn tin xuất hiện, ném lỗi rõ ràng nếu không thấy. */
async function waitComposeBox(page, label) {
  const box = await findVisible(page, COMPOSE_BOX_SELECTORS, 12000);
  if (!box) {
    throw new Error(`FB: không mở được khung soạn tin (${label}). Kiểm tra link, khách có thể đã chặn/không nhắn được, hoặc Messenger đổi giao diện.`);
  }
  await shot(page, '02-conversation');
  return box;
}

/**
 * Mở hội thoại của khách theo link đã lưu, chờ ô soạn tin xuất hiện.
 *  - Link message (messages/t, m.me, messenger.com/t): mở THẲNG vào hội thoại.
 *  - Link hồ sơ (facebook.com/<user>, profile.php?id=): mở trang hồ sơ rồi bấm "Nhắn tin".
 */
async function openConversationByLink(page, link) {
  const info = classifyFbLink(link);
  if (info.type === 'unknown') throw new Error('Thiếu/không hợp lệ link Facebook của khách.');

  if (info.type === 'message') {
    // Link message -> mở thẳng hội thoại đã có.
    await page.goto(info.messengerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    await ensureLoggedIn(page);
    return waitComposeBox(page, 'link message');
  }

  // Link hồ sơ -> mở trang hồ sơ khách rồi bấm "Nhắn tin"/"Message" (đúng như thao tác tay),
  // KHÔNG đoán messages/t/<username> để tránh mở nhầm hội thoại khác.
  await page.goto(info.profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await ensureLoggedIn(page);
  const btn = await findVisible(page, MESSAGE_BUTTON_SELECTORS, 10000);
  if (!btn) {
    throw new Error('FB: không thấy nút "Nhắn tin"/"Message" trên trang hồ sơ khách (có thể bị ẩn sau menu "...", khách chặn, hoặc FB đổi giao diện).');
  }
  await btn.click().catch(() => {});
  await page.waitForTimeout(2500);
  return waitComposeBox(page, 'sau khi bấm nút Nhắn tin trên hồ sơ');
}

/** Gõ nội dung từng dòng (fallback khi Ctrl+V không dùng được). Xuống dòng = Shift+Enter. */
async function typeLines(page, text) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (lines[i]) await page.keyboard.type(lines[i], { delay: 15 });
    if (i < lines.length - 1) {
      // Xuống dòng trong Messenger = Shift+Enter (Enter đơn = GỬI) -> giữ \n không gửi sớm giữa chừng.
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.down('Shift');
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Enter');
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.up('Shift');
    }
  }
}

/**
 * DÁN (copy-paste) nội dung vào ô soạn tin rồi GỬI — thay vì gõ từng ký tự.
 * Làm ĐÚNG như người dùng bấm Ctrl+V: ghi nội dung vào clipboard rồi nhấn Ctrl+V (paste THẬT).
 * Paste thật chỉ chèn ĐÚNG 1 LẦN (không như tự bắn sự kiện paste — dễ bị Messenger xử lý 2 lần ->
 * nội dung vào đôi). Messenger (Lexical) hiểu \n là XUỐNG DÒNG trong CÙNG tin, rồi Enter = GỬI.
 */
async function typeAndSend(page, box, message) {
  await box.click();
  const text = String(message == null ? '' : message);

  // Xoá sạch ô soạn (phòng nội dung nháp còn sót) để không bị nối thêm.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');

  // Ghi nội dung vào clipboard rồi Ctrl+V. Cần quyền clipboard-write (đã cấp ở browser.getContext).
  // Lỗi (trình duyệt chặn / không có quyền) -> pasted=false để rơi xuống fallback gõ tay.
  let pasted = false;
  try {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await box.click();
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(400);
    pasted = !!(await box.innerText().catch(() => '')).trim();
  } catch { pasted = false; }

  // Fallback: Ctrl+V không ăn -> xoá sạch (tránh nhập đôi nếu paste vào được một phần) rồi gõ tay.
  if (!pasted) {
    await box.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await typeLines(page, text);
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

module.exports = { sendBaoHangFb, checkLoggedInFb, gotoFacebook, ensureLoggedIn, normalizeMessengerUrl, classifyFbLink };
