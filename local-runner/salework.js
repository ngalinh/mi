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
 * Đóng mọi dropdown/popper Element-UI đang mở (vd dropdown chọn tài khoản) và CHỜ tới khi
 * nó thực sự biến mất. Poll nhanh và TRẢ VỀ NGAY khi đã đóng — tránh chờ cứng làm chậm
 * khúc chuyển "chọn kênh → tìm khách". Cần đóng vì lớp el-popper che + chặn pointer events,
 * nếu còn mở thì click ô tìm kiếm hội thoại sẽ "intercepts pointer events" -> timeout 30s.
 */
async function closeOpenDropdown(page, { timeout = 2500 } = {}) {
  const popper = page
    .locator('.el-select-dropdown, .el-popper, input[placeholder*="Tìm kiếm tài khoản" i]')
    .first();
  const deadline = Date.now() + timeout;
  // Nếu đã đóng sẵn thì không tốn 1ms nào.
  while (await popper.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(150);
  }
}

/**
 * Chọn tài khoản Zalo trong dropdown của Salework (giao diện zalo.salework.net mới —
 * KHÔNG phải Element-UI). Dropdown có ô "Tìm kiếm tài khoản..." và danh sách tài khoản.
 * Bỏ qua êm nếu không mở được dropdown (giao diện chỉ 1 account).
 */
async function selectZaloAccount(page, accountLabel) {
  if (!accountLabel) return false;
  const target = norm(accountLabel);

  // 1) Mở dropdown chọn tài khoản: thử vài opener
  const accSearchSel = 'input[placeholder*="Tìm kiếm tài khoản" i]';
  const isOpen = () => page.locator(accSearchSel).first().isVisible().catch(() => false);
  if (!(await isOpen())) {
    const openers = [
      page.getByText('Tất cả tài khoản', { exact: false }).first(),
      page.locator('.el-select, .el-select .el-input__inner, .el-select__caret').first(),
      page.locator('[aria-haspopup], [aria-expanded]').first(),
      page.getByRole('combobox').first(),
    ];
    for (const op of openers) {
      if (await isOpen()) break;
      await op.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
  }

  // 2) Nếu có ô tìm kiếm tài khoản thì gõ để lọc (không bắt buộc)
  const accSearch = page.locator(accSearchSel).first();
  if (await accSearch.isVisible().catch(() => false)) {
    await accSearch.fill('').catch(() => {});
    await accSearch.type(target, { delay: 30 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await shot(page, '02a-account-search');

  // 3) Quét DOM tìm phần tử khớp tên -> click bằng TOẠ ĐỘ chuột (cách Xeko, ăn event Vue/React)
  const rect = await page.evaluate((name) => {
    const deacc = (s) => (s || '').normalize('NFC').normalize('NFD')
      .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const tgt = deacc(name);
    const els = document.querySelectorAll(
      '[class*="dropdown"] li, [class*="option"], li, [class*="item"], div, span, a'
    );
    let exact = null;
    let partial = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.height < 120)) continue;
      const t = deacc(el.textContent);
      if (!t) continue;
      if (t === tgt) { exact = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; break; }
      if (!partial && t.includes(tgt) && t.length <= tgt.length + 14) {
        partial = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return exact || partial;
  }, target);

  if (rect) {
    await page.mouse.click(rect.x, rect.y);
    // Dropdown Salework là Element-UI multi-select (is-multiple) -> KHÔNG tự đóng khi
    // chọn option. Đóng chủ động và chờ popper biến mất (poll, đóng xong đi tiếp ngay)
    // để không che + chặn pointer events ở bước tìm hội thoại, mà không phí thời gian chờ cứng.
    await closeOpenDropdown(page);
    await shot(page, '02-account-selected');
    return true;
  }
  await shot(page, '02b-account-notfound');
  throw new Error(`KHONG_THAY_TAI_KHOAN_ZALO: không chọn được tài khoản Zalo "${accountLabel}". Xem ảnh screenshots/02a-account-search.png.`);
}

/**
 * Tìm và mở hội thoại khách. GÕ THẲNG SĐT vào ô tìm kiếm trước (SĐT là duy nhất nên
 * khớp chính xác hơn tên — tránh trùng tên / sai dấu), khớp hàng theo SĐT HOẶC tên
 * (hàng hội thoại thường hiển thị tên); nếu gõ SĐT không ra mới tìm theo TÊN.
 * Click bằng toạ độ chuột thật.
 * @param {object} p { name, phone }
 */
async function searchAndClickConversation(page, { name, phone, strictMatch = false }) {
  // An toàn: nếu còn popper/dropdown nào mở (vd dropdown chọn tài khoản) thì đóng lại,
  // tránh việc nó che + chặn pointer events khi click ô tìm kiếm. Poll, đóng xong đi tiếp ngay.
  await closeOpenDropdown(page);

  // Loại trừ ô "Tìm kiếm tài khoản..." (của dropdown account) để không khớp nhầm.
  const searchBox = page
    .locator(
      'input[placeholder*="Tìm kiếm"]:not([placeholder*="tài khoản" i]), '
      + 'input[placeholder*="Search"], input[type="search"]'
    )
    .first();
  if (!(await searchBox.isVisible().catch(() => false))) {
    throw new Error('KHONG_THAY_O_TIM_KIEM: Không tìm thấy ô tìm kiếm hội thoại trên Salework.');
  }

  // typeTerm: từ khoá GÕ vào ô tìm (ưu tiên SĐT). matchTerms: danh sách chuỗi để khớp
  // hàng hội thoại (SĐT và/hoặc tên) — null/[] -> lấy hàng trên cùng.
  async function attempt(typeTerm, matchTerms) {
    if (!typeTerm) return null;
    await searchBox.click().catch(() => {});
    await searchBox.fill('').catch(() => {});
    await searchBox.type(String(typeTerm), { delay: 30 });

    const scan = () => page.evaluate(({ matchTerms }) => {
      const deacc = (s) => (s || '').normalize('NFC').normalize('NFD')
        .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      // Lõi SĐT: bỏ ký tự không phải số + tiền tố 84/0 để khớp dù định dạng khác (có dấu cách, +84...).
      const phoneCore = (s) => (s || '').replace(/\D/g, '').replace(/^84/, '').replace(/^0/, '');
      const terms = (matchTerms || [])
        .map((m) => ({
          text: deacc(m),
          phone: /^[\d\s+().-]+$/.test(String(m || '')) ? phoneCore(m) : '',
        }))
        .filter((m) => m.text || m.phone);
      const els = document.querySelectorAll(
        '[class*="conversation"], [class*="contact"], [class*="chat"], '
        + '[class*="list-item"], [class*="message-item"], li, a[href]'
      );
      let topmost = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!(r.width > 150 && r.height > 30 && r.height < 220 && r.top >= 0)) continue;
        const raw = el.textContent || '';
        const t = deacc(raw);
        const tPhone = phoneCore(raw);
        if (terms.length) {
          const hit = terms.some((m) =>
            (m.text && t.includes(m.text)) || (m.phone && tPhone.includes(m.phone)));
          if (hit) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        } else if (!topmost || r.top < topmost.top) {
          topmost = { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top };
        }
      }
      return terms.length ? null : topmost;
    }, { matchTerms });

    // Salework debounce kết quả tìm kiếm -> poll, TRẢ VỀ NGAY khi có kết quả
    // thay vì chờ cứng (trước đây 2500ms cho mọi lần tìm).
    let rect = null;
    const deadline = Date.now() + 3000;
    do {
      await page.waitForTimeout(300);
      rect = await scan();
    } while (!rect && Date.now() < deadline);
    await shot(page, '03-searched');
    return rect;
  }

  let rect = null;
  // Gõ THẲNG SĐT vào ô tìm kiếm; khớp hàng theo SĐT hoặc tên (hàng thường hiển thị tên).
  if (phone) rect = await attempt(phone, [phone, name].filter(Boolean));
  // Fallback: gõ SĐT không ra (khách lưu khác số) thì tìm theo TÊN.
  if (!rect && name) rect = await attempt(name, [name]);
  if (strictMatch) {
    // Luồng bot tự động: KHÔNG "lấy đại đơn trên cùng" vì không có người soát ->
    // tránh gửi nhầm khách. Không khớp chắc chắn thì báo lỗi để xử lý tay.
    if (!rect) {
      await shot(page, '03b-conversation-notfound');
      throw new Error(`KHONG_THAY_HOI_THOAI (strict): không khớp chắc chắn hội thoại cho "${phone || name}". Bỏ qua để gửi tay, tránh gửi nhầm.`);
    }
  } else {
    // Luồng gửi tay (có người soát): cho phép fallback lấy kết quả trên cùng.
    if (!rect && phone) rect = await attempt(phone, null);
    if (!rect && name) rect = await attempt(name, null);
    if (!rect) {
      await shot(page, '03b-conversation-notfound');
      throw new Error(`KHONG_THAY_HOI_THOAI: không tìm thấy hội thoại cho "${phone || name}". Kiểm tra khách đã từng nhắn Zalo trên tài khoản này chưa.`);
    }
  }
  await page.mouse.click(rect.x, rect.y);
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
 * @param {string} p.keyword        - SĐT khách (dùng để tìm + kiểm tra whitelist)
 * @param {string} [p.name]         - tên khách (dùng để tìm/khớp hội thoại)
 * @param {string} p.message        - nội dung tin nhắn
 * @returns {Promise<{ok:boolean, step?:string}>}
 */
async function sendBaoHang({ profile = 'default', account, keyword, name, message, strictMatch = false }) {
  if (!keyword && !name) throw new Error('Thiếu keyword (SĐT) hoặc name (tên khách).');
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
  await searchAndClickConversation(page, { name, phone: keyword, strictMatch });
  await typeAndSend(page, message);

  return { ok: true };
}

module.exports = { sendBaoHang };
