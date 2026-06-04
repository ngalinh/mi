'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getPage } = require('./browser');

/**
 * Tự động gửi tin nhắn báo hàng về qua giao diện Salework Zalo (https://zalo.salework.net).
 * Port từ pattern salework.js của Xeko, có bổ sung log + screenshot từng bước.
 *
 * Lưu ý selector: Salework dùng Element-UI (Vue). Các selector có nhiều fallback
 * vì giao diện có thể đổi nhẹ. Khi UI thay đổi, sửa tập trung trong file này.
 */

const norm = (s) => (s == null ? '' : String(s).normalize('NFC').trim());

// Chuẩn hóa SĐT để so khớp whitelist (bỏ ký tự không phải số, bỏ 84/0 đầu)
const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^84/, '').replace(/^0/, '');
function phoneAllowed(phone) {
  if (!config.testMode) return true;
  const t = normPhone(phone);
  return config.testPhones.some((tp) => normPhone(tp) === t && t !== '');
}

function shot(page, name) {
  try {
    if (!fs.existsSync(config.screenshotDir)) fs.mkdirSync(config.screenshotDir, { recursive: true });
    return page.screenshot({ path: path.join(config.screenshotDir, `${Date.now()}-${name}.png`) }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

async function gotoSalework(page) {
  await page.goto(config.saleworkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await shot(page, '01-loaded');
}

/**
 * Kiểm tra đã đăng nhập Salework chưa: nếu còn thấy ô đăng nhập / form login => chưa.
 */
async function ensureLoggedIn(page) {
  const url = page.url();
  const hasLogin = await page
    .locator('input[type="password"], input[placeholder*="mật khẩu" i], button:has-text("Đăng nhập")')
    .first()
    .isVisible()
    .catch(() => false);
  if (hasLogin || /login|signin/i.test(url)) {
    throw new Error('CHUA_DANG_NHAP: Salework chưa đăng nhập. Hãy chạy `npm run local:debug`, đăng nhập thủ công 1 lần để lưu session.');
  }
}

const deaccent = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Chọn tài khoản Zalo trong dropdown của Salework (giao diện zalo.salework.net mới —
 * KHÔNG phải Element-UI). Dropdown có ô "Tìm kiếm tài khoản..." và danh sách tài khoản.
 * Bỏ qua êm nếu không mở được dropdown (giao diện chỉ 1 account).
 */
async function selectZaloAccount(page, accountLabel) {
  if (!accountLabel) return false;
  const target = norm(accountLabel);
  const tgt = deaccent(target);

  // Ô tìm kiếm tài khoản (đặc trưng cho dropdown đang mở). Khác ô tìm hội thoại.
  const searchSel = 'input[placeholder*="Tìm kiếm tài khoản" i]';
  const isOpen = () => page.locator(searchSel).first().isVisible().catch(() => false);

  // 1) Mở dropdown: thử vài cách tới khi ô tìm kiếm tài khoản hiện
  if (!(await isOpen())) {
    const openers = [
      page.getByText('Tất cả tài khoản', { exact: false }).first(),
      page.locator('[aria-haspopup], [aria-expanded]').first(),
      page.getByRole('button', { name: /tài khoản/i }).first(),
      page.getByRole('combobox').first(),
    ];
    for (const op of openers) {
      if (await isOpen()) break;
      await op.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
  }
  if (!(await isOpen())) {
    await shot(page, '02b-account-dropdown-notfound');
    return false; // có thể chỉ 1 account -> bỏ qua
  }

  // 2) Gõ tên vào ô tìm kiếm để lọc danh sách
  const search = page.locator(searchSel).first();
  await search.fill('').catch(() => {});
  await search.type(target, { delay: 40 }).catch(() => {});
  await page.waitForTimeout(1200);
  await shot(page, '02a-account-search');

  // 3) Click item khớp: ưu tiên text khớp đầy đủ, rồi tới khớp deaccent
  const exactLoc = page.getByText(target, { exact: true });
  if (await exactLoc.count().catch(() => 0)) {
    await exactLoc.first().click().catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, '02-account-selected');
    return true;
  }
  const candidates = page.locator('li, [role="option"], [class*="item"], [class*="option"], div, span, button');
  const n = Math.min(await candidates.count().catch(() => 0), 500);
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    const txt = deaccent(await el.innerText().catch(() => ''));
    if (txt === tgt && (await el.isVisible().catch(() => false))) {
      await el.click().catch(() => {});
      await page.waitForTimeout(800);
      await shot(page, '02-account-selected');
      return true;
    }
  }
  await shot(page, '02b-account-notfound');
  throw new Error(`KHONG_THAY_TAI_KHOAN_ZALO: không chọn được tài khoản Zalo "${accountLabel}". Kiểm tra tên trong dropdown (xem ảnh screenshots/02a-account-search).`);
}

/**
 * Tìm và mở hội thoại khách theo từ khóa (tên hoặc SĐT).
 */
async function searchAndClickConversation(page, keyword) {
  const kw = norm(keyword);
  const searchBox = page
    .locator('input[placeholder*="Tìm kiếm"], input[placeholder*="Search"], input[type="search"]')
    .first();

  if (!(await searchBox.isVisible().catch(() => false))) {
    throw new Error('KHONG_THAY_O_TIM_KIEM: Không tìm thấy ô tìm kiếm hội thoại trên Salework.');
  }
  await searchBox.click();
  await searchBox.fill('');
  await searchBox.type(kw, { delay: 40 });
  await page.waitForTimeout(2500);
  await shot(page, '03-searched');

  // Click vào kết quả đầu tiên khớp keyword
  const result = page
    .locator('[class*="conversation"], [class*="contact"], [class*="chat-item"], [class*="item"], li, div')
    .filter({ hasText: kw.split(' ')[0] })
    .first();

  const visible = await result.isVisible().catch(() => false);
  if (!visible) {
    throw new Error(`KHONG_THAY_HOI_THOAI: Không tìm thấy hội thoại cho "${kw}". Kiểm tra khách đã từng nhắn Zalo chưa.`);
  }
  await result.click().catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, '04-conversation-opened');
}

/**
 * Nhập và gửi tin nhắn. Dùng paste để giữ xuống dòng, tránh Enter gửi sớm.
 */
async function typeAndSend(page, message) {
  const input = page
    .locator('[placeholder*="Nhập tin nhắn"], [contenteditable="true"], textarea')
    .first();

  if (!(await input.isVisible().catch(() => false))) {
    throw new Error('KHONG_THAY_O_NHAP: Không tìm thấy ô nhập tin nhắn.');
  }
  await input.click();

  // Paste qua clipboard để giữ nguyên xuống dòng (không bị Enter gửi giữa chừng)
  await page.evaluate(async (text) => {
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  }, message);

  const pasted = await page
    .evaluate(async () => {
      try { await navigator.clipboard.readText(); return true; } catch { return false; }
    })
    .catch(() => false);

  if (pasted) {
    await page.keyboard.press('Control+V');
  } else {
    // fallback: gõ từng dòng, dùng Shift+Enter để xuống dòng
    const lines = message.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await input.type(lines[i], { delay: 15 });
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
  }
  await page.waitForTimeout(500);
  await shot(page, '05-message-typed');

  // Bấm nút gửi; fallback Enter
  const sendBtn = page
    .locator('button:has-text("Gửi"), button:has-text("Send"), [class*="send"] button, button[class*="send"]')
    .first();

  if (await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click().catch(() => {});
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(1500);
  await shot(page, '06-sent');
}

/**
 * Hàm chính: gửi 1 tin nhắn báo hàng về.
 * @param {object} p
 * @param {string} p.profile        - tên profile (account zalo) để load session
 * @param {string} [p.account]      - label account để chọn trong dropdown (nếu có)
 * @param {string} p.keyword        - từ khóa tìm khách (tên hoặc SĐT)
 * @param {string} p.message        - nội dung tin nhắn
 * @returns {Promise<{ok:boolean, step?:string}>}
 */
async function sendBaoHang({ profile = 'default', account, keyword, message }) {
  if (!keyword) throw new Error('Thiếu keyword (tên/SĐT khách).');
  if (!message) throw new Error('Thiếu nội dung tin nhắn.');

  // CHẶN AN TOÀN: ở chế độ TEST chỉ gửi tới số nằm trong TEST_PHONES
  if (!phoneAllowed(keyword)) {
    throw new Error(`TEST_MODE: bỏ qua "${keyword}" — không nằm trong TEST_PHONES (an toàn, không gửi).`);
  }

  const page = await getPage(profile);
  await gotoSalework(page);
  await ensureLoggedIn(page);
  // Chọn tài khoản Zalo: ưu tiên account truyền vào, sau đó tới DEFAULT_ZALO_ACCOUNT trong .env
  const acct = account || config.defaultZaloAccount;
  if (acct) await selectZaloAccount(page, acct);
  await searchAndClickConversation(page, keyword);
  await typeAndSend(page, message);

  return { ok: true };
}

module.exports = { sendBaoHang };
