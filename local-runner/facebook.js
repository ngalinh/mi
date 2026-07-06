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

/**
 * TODO (chờ hướng dẫn element): tìm đúng hội thoại của khách trong Messenger theo SĐT.
 * Dự kiến: mở ô tìm kiếm Messenger -> gõ SĐT -> chọn kết quả khớp -> mở khung chat.
 * @returns {Promise<boolean>} true nếu mở được đúng hội thoại.
 */
// eslint-disable-next-line no-unused-vars
async function searchAndOpenConversation(page, { phone, name, strictMatch = false }) {
  throw new Error('FB_SEND_CHUA_CAU_HINH: chưa cấu hình bước tìm hội thoại Messenger theo SĐT — đang chờ hướng dẫn element.');
}

/**
 * TODO (chờ hướng dẫn element): gõ nội dung + gửi trong khung chat Messenger đang mở.
 */
// eslint-disable-next-line no-unused-vars
async function typeAndSend(page, message, imagePaths = []) {
  throw new Error('FB_SEND_CHUA_CAU_HINH: chưa cấu hình bước soạn & gửi tin trên Messenger — đang chờ hướng dẫn element.');
}

/**
 * Gửi 1 tin nhắn báo hàng qua Facebook Messenger.
 * Cùng chữ ký với salework.sendBaoHang để notifyService gọi thống nhất theo `channel`.
 * @param {{profile?:string, keyword:string, name?:string, message:string, strictMatch?:boolean, imagePaths?:string[]}} p
 */
async function sendBaoHangFb({ profile = 'default', keyword, name, message, strictMatch = false, imagePaths = [] }) {
  if (!keyword && !name) throw new Error('Thiếu keyword (SĐT) hoặc name (tên khách).');
  if (!message && !(imagePaths && imagePaths.length)) throw new Error('Thiếu nội dung tin nhắn.');

  // CHẶN AN TOÀN: ở chế độ TEST chỉ gửi tới số nằm trong TEST_PHONES.
  if (!phoneAllowed(keyword)) {
    throw new Error(`TEST_MODE: bỏ qua "${keyword}" — không nằm trong TEST_PHONES (an toàn, không gửi).`);
  }

  // Tuần tự hoá theo profile: không mở trùng userDataDir với lệnh đăng nhập/kiểm tra cùng profile.
  return withProfileLock(profile, async () => {
    const page = await getPage(profile);
    try {
      await gotoFacebook(page);
      await ensureLoggedIn(page);
      await searchAndOpenConversation(page, { phone: keyword, name, strictMatch });
      await typeAndSend(page, message, imagePaths);
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

module.exports = { sendBaoHangFb, checkLoggedInFb, gotoFacebook, ensureLoggedIn };
