'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const testModeStore = require('./testModeStore');
const { getPage, closeContext, withProfileLock } = require('./browser');

/**
 * Tự động gửi tin nhắn báo hàng về qua giao diện quản lý Zalo.
 *
 * Trước đây dùng Salework (zalo.salework.net, giao diện Element-UI). Nay PORT Y HỆT flow
 * Zalo của Xeko: chuyển sang Zalo Basso (https://zalo.basso.vn) — self-hosted, giao diện
 * Vuetify. Vì giao diện đổi nên logic CHỌN TÀI KHOẢN và GỬI TIN được viết lại theo selector
 * Vuetify của basso.vn (.v-list / .acc-tick / textarea.msg-textarea / .send-btn ...).
 *
 * KHÁC Xeko ở mục tiêu gửi: Xeko đăng vào NHÓM, còn mi báo hàng cho TỪNG KHÁCH nên GIỮ NGUYÊN
 * phần tìm hội thoại theo SĐT/tên (searchAndClickConversation) + chế độ strictMatch của mi.
 *
 * Khi UI thay đổi, sửa tập trung trong file này.
 */

const norm = (s) => (s == null ? '' : String(s).normalize('NFC').trim());

// Chuẩn hoá tên tài khoản để so khớp: NFC, gộp khoảng trắng (tên "Basso  Order Hàng Mỹ" có
// 2 dấu cách trong DOM), bỏ đầu/cuối, lowercase. (Giống ACC_NORM của Xeko.)
const ACC_NORM = (s) => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

// Chuẩn hóa SĐT để so khớp whitelist (bỏ ký tự không phải số, bỏ 84/0 đầu)
const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^84/, '').replace(/^0/, '');
function phoneAllowed(phone) {
  const { testMode, testPhones } = testModeStore.get();
  if (!testMode) return true;
  const t = normPhone(phone);
  return testPhones.some((tp) => normPhone(tp) === t && t !== '');
}

const sleep = (page, ms) => page.waitForTimeout(ms);
const randomDelay = (page, min, max) => page.waitForTimeout(min + Math.floor(Math.random() * (max - min)));

function shot(page, name) {
  try {
    if (!fs.existsSync(config.screenshotDir)) fs.mkdirSync(config.screenshotDir, { recursive: true });
    return page.screenshot({ path: path.join(config.screenshotDir, `${Date.now()}-${name}.png`) }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

async function gotoSalework(page) {
  // Mở thẳng trang chat (nơi có dropdown chọn tài khoản + danh sách hội thoại).
  await page.goto(config.saleworkChatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await shot(page, '01-loaded');
}

/**
 * Kiểm tra đã đăng nhập chưa: nếu còn thấy ô đăng nhập / form login => chưa.
 */
async function ensureLoggedIn(page) {
  const url = page.url();
  const hasLogin = await page
    .locator('input[type="password"], input[placeholder*="mật khẩu" i], button:has-text("Đăng nhập")')
    .first()
    .isVisible()
    .catch(() => false);
  if (hasLogin || /login|signin/i.test(url)) {
    throw new Error('CHUA_DANG_NHAP: Zalo Basso chưa đăng nhập. Hãy chạy `npm run login`, đăng nhập thủ công 1 lần để lưu session.');
  }
}

// ============================================================================
// CHỌN TÀI KHOẢN ZALO trên zalo.basso.vn (giao diện Vuetify) — PORT Y HỆT Xeko.
// ----------------------------------------------------------------------------
// Nút "Tất cả Zalo" (span.acc-btn-text) mở ra dropdown .v-list; mỗi tài khoản là 1
// .v-list-item:
//     .v-list-item
//        .v-list-item-title                     → tên tài khoản
//        .v-list-item__append > span.acc-tick   → ô tick; THÊM class "on" khi ĐANG chọn
// Dòng đầu "Tất cả Zalo" KHÔNG có .acc-tick.
//
// Đây là multi-select (lọc hội thoại theo tài khoản). Để gửi đúng 1 tài khoản:
//   1. Mở dropdown.
//   2. Bỏ tick mọi tài khoản đang "on" KHÁC tài khoản cần gửi.
//   3. Tick đúng tài khoản cần gửi.
//   4. READ-BACK: CHỈ tài khoản đó "on" → sai thì HUỶ để KHÔNG gửi nhầm tài khoản.
// ============================================================================

// Dropdown danh sách tài khoản đang hiển thị chưa? (chỉ v-list của dropdown này mới có
// .acc-tick — danh sách hội thoại không có → không bị nhầm).
async function accountListVisible(page) {
  return page.locator('.v-list:has(.acc-tick)').first().isVisible().catch(() => false);
}

// Mở dropdown chọn tài khoản. Nút mở hiển thị nhãn span.acc-btn-text ("Tất cả Zalo" hoặc
// tên tài khoản đã chọn lần trước). Thử vài selector phòng khi DOM đổi.
async function openAccountDropdown(page) {
  if (await accountListVisible(page)) return true;
  const tries = ['.acc-btn-text', '.acc-btn', '[class*="acc-btn"]', '[aria-haspopup="menu"]', '[aria-haspopup]'];
  for (const sel of tries) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    try { await loc.click({ timeout: 3000, force: true }); } catch { continue; }
    await sleep(page, 800);
    if (await accountListVisible(page)) return true;
  }
  return accountListVisible(page);
}

// Đọc trạng thái các dòng tài khoản trong dropdown, đồng thời ĐÁNH SỐ mỗi dòng (data-mi-idx)
// để click lại bằng locator. Bỏ qua dòng "Tất cả Zalo" (không có .acc-tick). PHẢI đọc lại
// trước mỗi lần click vì Vue re-render xoá data-mi-idx.
async function readAccountRows(page) {
  return page.evaluate(() => {
    const normJs = (s) => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const rows = [];
    Array.from(document.querySelectorAll('.v-list .v-list-item')).forEach((el, i) => {
      el.setAttribute('data-mi-idx', String(i));
      const tick = el.querySelector('.acc-tick');
      if (!tick) return;                       // dòng "Tất cả Zalo" — bỏ qua
      const titleEl = el.querySelector('.v-list-item-title');
      rows.push({
        idx: i,
        title: titleEl ? normJs(titleEl.textContent) : '',
        on: tick.classList.contains('on'),
      });
    });
    return rows;
  });
}

async function clickAccountRowByIdx(page, idx) {
  const loc = page.locator(`.v-list-item[data-mi-idx="${idx}"]`).first();
  try { await loc.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch {}
  await loc.click({ timeout: 4000 });
  await sleep(page, 500);
}

/**
 * Chọn đúng 1 tài khoản Zalo trong dropdown Vuetify của basso.vn. Trả về true nếu xác minh
 * (read-back) đúng 1 tài khoản cần gửi đang "on", ngược lại false (caller nên HUỶ gửi).
 */
async function selectZaloAccount(page, accountLabel) {
  if (!accountLabel) return false;
  const want = ACC_NORM(accountLabel);

  if (!(await openAccountDropdown(page))) {
    await shot(page, '02b-account-dropdown-fail');
    return false;
  }
  await sleep(page, 500);

  // Hội tụ về trạng thái mong muốn: mỗi vòng sửa ĐÚNG 1 việc rồi đọc lại (vì click làm Vue
  // re-render → phải re-mark data-mi-idx). Tối đa 8 vòng cho an toàn.
  for (let pass = 0; pass < 8; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await readAccountRows(page);
    const target = rows.find((r) => ACC_NORM(r.title) === want);
    if (!target) {
      // List có thể chưa render xong ở vòng đầu — chờ rồi thử lại vài lần.
      if (pass < 2) { await sleep(page, 700); continue; }
      await shot(page, '02b-account-notfound');
      throw new Error(`KHONG_THAY_TAI_KHOAN_ZALO: không thấy tài khoản "${accountLabel}". Có: ${JSON.stringify(rows.map((r) => r.title))}`);
    }
    const wrongOn = rows.find((r) => r.on && r.idx !== target.idx);
    if (wrongOn) {                               // còn tài khoản KHÁC đang chọn → bỏ tick
      await clickAccountRowByIdx(page, wrongOn.idx);
      continue;
    }
    if (!target.on) {                            // tài khoản cần gửi chưa tick → tick
      await clickAccountRowByIdx(page, target.idx);
      continue;
    }
    break;                                       // target "on" + không thừa → xong
  }

  // READ-BACK xác minh: CHỈ đúng 1 tài khoản "on" và đó là tài khoản cần gửi.
  const onRows = (await readAccountRows(page)).filter((r) => r.on).map((r) => r.title);
  const ok = onRows.length === 1 && ACC_NORM(onRows[0]) === want;

  // Đóng dropdown để bước tìm hội thoại đọc đúng danh sách đã lọc + không bị overlay che click.
  await page.keyboard.press('Escape').catch(() => {});
  await page.click('body', { position: { x: 700, y: 400 }, force: true }).catch(() => {});
  await sleep(page, 800);

  await shot(page, '02-account-selected');
  if (!ok) {
    await shot(page, '02c-account-verify-fail');
  }
  return ok;
}

/**
 * Liệt kê TẤT CẢ tài khoản Zalo mà profile đang thấy trong dropdown chọn account.
 * Dùng cho `npm run accounts` để kiểm tra profile đăng nhập những Zalo nào + lấy đúng tên
 * điền ZALO_ACCOUNT_MAP. Trả về string[] (đã loại "Tất cả Zalo"), [] nếu không đọc được.
 */
async function listZaloAccounts(page) {
  if (!(await openAccountDropdown(page))) {
    await shot(page, '02b-account-dropdown-fail');
    return [];
  }
  await sleep(page, 600);
  await shot(page, '02a-account-search');
  const rows = await readAccountRows(page);
  // Đóng dropdown lại cho gọn.
  await page.keyboard.press('Escape').catch(() => {});
  const seen = new Set();
  return rows
    .map((r) => norm(r.title))
    .filter((t) => t && !seen.has(t) && (seen.add(t), true));
}

/**
 * Bấm 1 tab trên thanh lọc .filter-bar của zalo.basso.vn theo VỊ TRÍ (đáng tin nhất). DOM thật:
 * các nút .filter-btn KHÔNG có class/id cố định — aria-describedby là id tooltip ĐỘNG, icon là
 * <svg> chung không có class. Thứ tự ổn định: [0] Thư, [1] Chưa đọc, [2] Cá nhân, [3] Nhóm...
 * Nút đang chọn có class .filter-active -> dùng để XÁC MINH và BỎ QUA nếu đã đúng tab (bấm lại nút
 * đang active có thể làm BỎ chọn). Dự phòng: hover đọc tooltip theo nhãn, rồi selector đoán.
 * @param {number} index vị trí nút (0-based) cần bấm (Cá nhân=2, Nhóm=3)
 */
async function clickFilterTab(page, wantLabel, index, guessSelectors = []) {
  const want = String(wantLabel).toLowerCase();
  const shotName = `02d-tab-${want.replace(/\s+/g, '-')}`;
  const isActive = (btn) => btn.evaluate((el) => el.classList.contains('filter-active')).catch(() => false);
  const btns = page.locator('.filter-bar .filter-btn');
  const n = await btns.count().catch(() => 0);

  // (1) CHÍNH — theo VỊ TRÍ + xác minh .filter-active. Đã active sẵn -> THÔI (không bấm lại kẻo bỏ chọn).
  if (index != null && n > index) {
    const btn = btns.nth(index);
    try {
      if (await isActive(btn)) { await shot(page, shotName); return true; }
      await btn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await btn.click({ timeout: 3000 });
      await sleep(page, 700);
      if (await isActive(btn)) { await shot(page, shotName); return true; }
    } catch { /* rơi xuống dự phòng */ }
  }

  // (2) DỰ PHÒNG — hover từng nút đọc tooltip qua aria-describedby, bấm nút khớp nhãn + xác minh.
  for (let i = 0; i < n; i += 1) {
    const btn = btns.nth(i);
    try {
      // eslint-disable-next-line no-await-in-loop
      await btn.hover({ timeout: 1500 });
      // eslint-disable-next-line no-await-in-loop
      await sleep(page, 250);
      // eslint-disable-next-line no-await-in-loop
      const label = await btn.evaluate((el) => {
        const id = el.getAttribute('aria-describedby');
        const tip = id ? document.getElementById(id) : null;
        return (tip ? tip.textContent : '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
      }).catch(() => '');
      if (label && label.includes(want)) {
        // eslint-disable-next-line no-await-in-loop
        if (await isActive(btn)) { await shot(page, shotName); return true; }
        // eslint-disable-next-line no-await-in-loop
        await btn.click({ timeout: 3000 });
        // eslint-disable-next-line no-await-in-loop
        await sleep(page, 700);
        // eslint-disable-next-line no-await-in-loop
        if (await isActive(btn)) { await shot(page, shotName); return true; }
      }
    } catch { /* thử nút kế */ }
  }

  // (3) Fallback selector đoán — phòng khi DOM đổi hoàn toàn.
  for (const sel of guessSelectors) {
    const loc = page.locator(sel).first();
    try {
      if (!(await loc.count().catch(() => 0))) continue;
      await loc.click({ timeout: 3000 });
      await sleep(page, 700);
      await shot(page, shotName);
      return true;
    } catch { /* thử selector kế */ }
  }
  return false;
}

// Bấm tab "Nhóm" (icon 2 người) — .filter-btn thứ 4 (index 3) trên .filter-bar của zalo.basso.vn.
const clickGroupTab = (page) => clickFilterTab(page, 'nhóm', 3,
  ['[aria-label*="nhóm" i]', '[title*="nhóm" i]', 'button:has(.mdi-account-group)', 'button:has(.mdi-account-multiple)']);
// Bấm tab "Cá nhân" (icon 1 người) — .filter-btn thứ 3 (index 2); dùng cho kiểu báo cá nhân.
const clickPersonalTab = (page) => clickFilterTab(page, 'cá nhân', 2,
  ['[aria-label*="cá nhân" i]', '[title*="cá nhân" i]']);

/**
 * Tìm và mở hội thoại khách theo KIỂU BÁO của NV (notifyTarget):
 * Khi gõ SĐT, panel có 3 mục: "Người dùng Zalo" (user cá nhân), "Trò chuyện" (hội thoại/nhóm đặt
 * tên sẵn), "Tin nhắn" (chat 1-1 thật). Chọn mục theo kiểu báo:
 *  - 'group' (mặc định): BẤM TAB "NHÓM" trước, rồi CHỈ chọn hàng trong mục "Trò chuyện".
 *  - 'personal': BẤM TAB "CÁ NHÂN"; chọn chat 1-1 trong mục "TIN NHẮN"; không ra thì FALLBACK mở
 *    từ "Người dùng Zalo" (khớp CHỈ theo SĐT — duy nhất nên đúng người, kể cả strict).
 *
 * Gõ THẲNG SĐT vào ô tìm (SĐT duy nhất, khớp chính xác hơn tên); không ra mới tìm theo TÊN.
 * Click bằng element thật (Playwright cuộn tới + chờ actionable), dự phòng toạ độ chuột.
 * @param {object} p { name, phone, strictMatch, notifyTarget }
 */
async function searchAndClickConversation(page, { name, phone, strictMatch = false, notifyTarget = 'group' }) {
  const isPersonal = notifyTarget === 'personal';
  // LOG CHẨN ĐOÁN: nếu dòng này KHÔNG hiện -> runner đang chạy code CŨ (chưa pull/restart).
  // Nếu hiện notifyTarget=group cho NV báo cá nhân -> server chưa restart hoặc đơn không khớp account.
  console.log(`[mi] tìm hội thoại: notifyTarget=${notifyTarget} -> bấm tab ${isPersonal ? 'CÁ NHÂN' : 'NHÓM'} | phone=${phone || '-'} name=${name || '-'}`);
  // TEST_MODE: whitelist chỉ chặn theo SĐT (phoneAllowed). Nếu cho khớp theo TÊN, có thể mở
  // nhầm hội thoại của 1 khách KHÁC trùng tên (không nằm trong whitelist). -> Khi TEST_MODE,
  // CHỈ khớp theo SĐT đã whitelist, bỏ qua tìm theo tên cho an toàn.
  if (testModeStore.get().testMode && phone) name = undefined;
  // Chọn tab lọc theo kiểu báo (best-effort): 'group' -> tab "Nhóm"; 'personal' -> tab "Cá nhân"
  // (để không dính bộ lọc Nhóm còn sót). Không thấy tab thì bỏ qua, còn lớp lọc "Trò chuyện" đỡ.
  if (isPersonal) await clickPersonalTab(page); else await clickGroupTab(page);
  const searchBox = page
    .locator(
      'input[placeholder*="Tìm kiếm"], input[placeholder*="tìm kiếm"], '
      + 'input[placeholder*="Search"], input[type="search"]'
    )
    .first();
  if (!(await searchBox.isVisible().catch(() => false))) {
    throw new Error('KHONG_THAY_O_TIM_KIEM: Không tìm thấy ô tìm kiếm hội thoại.');
  }

  // typeTerm: từ khoá GÕ vào ô tìm (ưu tiên SĐT). matchTerms: danh sách chuỗi để khớp hàng
  // hội thoại (SĐT và/hoặc tên) — null/[] -> lấy hàng trên cùng.
  // section: nhãn mục kết quả được phép chọn ('Trò chuyện' | 'Tin nhắn' | 'Người dùng Zalo'),
  // null = không giới hạn. Khi search SĐT panel có 3 mục: "Người dùng Zalo" (user cá nhân),
  // "Trò chuyện" (hội thoại/nhóm đặt tên), "Tin nhắn" (chat 1-1). Báo nhóm -> "Trò chuyện";
  // báo cá nhân -> "Tin nhắn" (chat 1-1 thật), fallback "Người dùng Zalo".
  async function attempt(typeTerm, matchTerms, section = 'Trò chuyện') {
    if (!typeTerm) return null;
    await searchBox.click().catch(() => {});
    await searchBox.fill('').catch(() => {});
    await searchBox.type(String(typeTerm), { delay: 30 });

    const scan = () => page.evaluate(({ matchTerms, section }) => {
      const deacc = (s) => (s || '').normalize('NFC').normalize('NFD')
        .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      // Lõi SĐT: bỏ ký tự không phải số + tiền tố 84/0 để khớp dù định dạng khác.
      const phoneCore = (s) => (s || '').replace(/\D/g, '').replace(/^84/, '').replace(/^0/, '');

      // Thu thập MỌI heading mục kết quả + toạ độ (1 nhãn có thể xuất hiện nhiều nơi, vd "Tin nhắn"
      // vừa là tiêu đề trang vừa là tên mục -> lấy TẤT CẢ). Khớp CHÍNH XÁC text (nhãn lá).
      const headingTops = (label) => {
        const want = label.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
        const out = [];
        for (const el of document.querySelectorAll('div,span,p,h1,h2,h3,h4,h5,h6,label,small')) {
          const txt = (el.textContent || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
          if (txt !== want) continue;
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.width > 0) out.push(r.top);
        }
        return out;
      };
      const heads = [];
      for (const label of ['Người dùng Zalo', 'Trò chuyện', 'Tin nhắn']) {
        for (const top of headingTops(label)) heads.push({ label: label.toLowerCase(), top });
      }
      heads.sort((a, b) => a.top - b.top);
      // Mục của 1 hàng = heading GẦN NHẤT nằm TRÊN nó (bền khi "Tin nhắn" trùng tiêu đề trang:
      // heading gần hơn ghi đè). '' nếu không có heading nào ở trên.
      const sectionOf = (r) => {
        const cy = r.top + r.height / 2;
        let cur = '';
        for (const h of heads) { if (h.top <= cy) cur = h.label; else break; }
        return cur;
      };
      const want = section ? section.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase() : '';
      const inSection = (r) => {
        if (!want) return true;          // null -> không giới hạn
        if (!heads.length) return true;  // không thấy heading -> best-effort, không lọc
        return sectionOf(r) === want;
      };

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
      // Xoá cờ target cũ trước mỗi lần quét để chỉ còn 1 phần tử được đánh dấu.
      document.querySelectorAll('[data-mi-target]').forEach((e) => e.removeAttribute('data-mi-target'));
      let best = null;    // hàng KHỚP nhỏ nhất (hàng hội thoại thật)
      let topmost = null; // hàng trên cùng khi không có từ khoá khớp
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!(r.width > 150 && r.height > 30 && r.height < 220 && r.top >= 0)) continue;
        if (!inSection(r)) continue;     // chỉ nhận hàng thuộc đúng mục (section) cần tìm
        const raw = el.textContent || '';
        const t = deacc(raw);
        const tPhone = phoneCore(raw);
        if (terms.length) {
          const hit = terms.some((m) =>
            (m.text && t.includes(m.text)) || (m.phone && tPhone.includes(m.phone)));
          // Chọn phần tử khớp NHỎ NHẤT: tránh trúng WRAPPER của mục "Trò chuyện"
          // (tâm rơi vào tiêu đề mục -> click không mở hội thoại). Hàng thật nhỏ hơn.
          if (hit && (!best || r.width * r.height < best.area)) {
            best = { el, area: r.width * r.height, rect: r };
          }
        } else if (!topmost || r.top < topmost.top) {
          topmost = { el, top: r.top, rect: r };
        }
      }
      const pick = terms.length ? best : topmost;
      if (!pick) return null;
      // Đánh dấu để click bằng element thật (auto-scroll + actionable) thay vì chỉ toạ độ.
      pick.el.setAttribute('data-mi-target', '1');
      const rr = pick.rect;
      return { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 };
    }, { matchTerms, section });

    // Kết quả tìm kiếm có debounce -> poll, TRẢ VỀ NGAY khi có kết quả.
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
  // Mục chính theo kiểu báo: cá nhân -> "Tin nhắn" (chat 1-1); nhóm -> "Trò chuyện".
  const primary = isPersonal ? 'Tin nhắn' : 'Trò chuyện';
  // Bước 1: tìm trong mục chính — gõ SĐT trước, khớp theo SĐT/tên; không ra thì tìm theo TÊN.
  if (phone) rect = await attempt(phone, [phone, name].filter(Boolean), primary);
  if (!rect && name) rect = await attempt(name, [name], primary);
  // Bước 2 (CHỈ kiểu cá nhân): chưa có chat 1-1 -> mở từ "Người dùng Zalo", khớp CHỈ theo SĐT
  // (duy nhất) nên đúng người — an toàn cho cả strict. KHÔNG khớp theo tên để tránh trùng tên.
  if (!rect && isPersonal && phone) rect = await attempt(phone, [phone], 'Người dùng Zalo');

  if (strictMatch) {
    // Luồng bot tự động: KHÔNG "lấy đại đơn trên cùng" -> tránh gửi nhầm khách.
    if (!rect) {
      await shot(page, '03b-conversation-notfound');
      throw new Error(`KHONG_THAY_HOI_THOAI (strict): không khớp chắc chắn hội thoại cho "${phone || name}" (mục "${primary}"). Bỏ qua để gửi tay, tránh gửi nhầm.`);
    }
  } else {
    // Luồng gửi tay (có người soát): fallback lấy kết quả trên cùng TRONG mục chính.
    if (!rect && phone) rect = await attempt(phone, null, primary);
    if (!rect && name) rect = await attempt(name, null, primary);
    if (!rect) {
      await shot(page, '03b-conversation-notfound');
      const hint = isPersonal
        ? 'Kiểm tra khách đã có chat 1-1 trong "Tin nhắn" hoặc hiện ở "Người dùng Zalo" trên tài khoản này chưa.'
        : 'Kiểm tra khách đã có hội thoại (đặt tên sẵn) trong "Trò chuyện" trên tài khoản này chưa.';
      throw new Error(`KHONG_THAY_HOI_THOAI: không tìm thấy hội thoại cho "${phone || name}". ${hint}`);
    }
  }
  // Ưu tiên click bằng element đã đánh dấu (Playwright tự cuộn tới + chờ actionable),
  // dự phòng click theo toạ độ chuột nếu Vue đã render lại làm mất cờ.
  let opened = false;
  try {
    const target = page.locator('[data-mi-target]').first();
    await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await target.click({ timeout: 5000 });
    opened = true;
  } catch { /* dự phòng toạ độ chuột */ }
  if (!opened) await page.mouse.click(rect.x, rect.y);
  await page.waitForTimeout(1500);
  await shot(page, '04-conversation-opened');
}

// Bấm nút Gửi (.send-btn) — Playwright tự chờ tới khi hết disabled (nút bật khi ô soạn có
// nội dung/ảnh). Fallback nút theo chữ "Gửi"/"Send". Trả false nếu không bấm được.
async function clickSend(page) {
  await randomDelay(page, 500, 1000);
  try {
    await page.locator('button.send-btn').first().click({ timeout: 8000 });
    await randomDelay(page, 1500, 2400);
    return true;
  } catch { /* thử fallback */ }
  for (const sel of ['button:has-text("Gửi")', 'button:has-text("Send")']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() && await btn.isEnabled().catch(() => false)) {
        await btn.click({ timeout: 5000 });
        await randomDelay(page, 1500, 2400);
        return true;
      }
    } catch {}
  }
  return false;
}

// Đính ảnh vào ô soạn tin. CÁCH CHÍNH: DÁN (paste) ảnh từ clipboard — dựng File rồi dispatch
// 'paste' kèm DataTransfer (gán clipboardData qua defineProperty vì constructor ClipboardEvent
// bỏ qua nó). DỰ PHÒNG: input[type=file] sẵn có / nút .ic-violet → menu "Hình ảnh" → filechooser.
// Trả true nếu đính được. (PORT Y HỆT Xeko.)
async function attachImages(page, imagePaths) {
  let uploaded = false;

  // (a) DÁN ảnh vào textarea.
  try {
    const files = imagePaths.map((p) => {
      const ext = path.extname(p).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { name: path.basename(p), type, b64: fs.readFileSync(p).toString('base64') };
    });
    await page.locator('textarea.msg-textarea, textarea:visible').first().click({ timeout: 5000 }).catch(() => {});
    uploaded = await page.evaluate((files) => {
      const ta = document.querySelector('textarea.msg-textarea') || document.querySelector('textarea') || document.activeElement;
      if (!ta) return false;
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
        dt.items.add(new File([arr], f.name, { type: f.type }));
      }
      const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(evt, 'clipboardData', { value: dt });
      ta.focus();
      ta.dispatchEvent(evt);
      return true;
    }, files);
    await sleep(page, 2000);
  } catch {
    uploaded = false;
  }

  // (b) DỰ PHÒNG: input[type=file] sẵn có; rồi .ic-violet → menu "Hình ảnh" → filechooser.
  if (!uploaded) {
    const setOnAnyInput = async () => {
      for (const input of await page.$$('input[type="file"]')) {
        try { await input.setInputFiles(imagePaths); return true; } catch {}
      }
      return false;
    };
    uploaded = await setOnAnyInput();
    if (!uploaded) {
      try {
        const attach = page.locator('button.ic-violet').first();
        const menuId = await attach.getAttribute('aria-controls').catch(() => null);
        let [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
          attach.click({ timeout: 5000 }).catch(() => {}),
        ]);
        if (!chooser) {
          await sleep(page, 600);
          const scope = menuId ? page.locator(`#${menuId}`) : page.locator('.v-overlay__content').last();
          const imgItem = scope.locator('.v-list-item, [role="menuitem"]')
            .filter({ hasText: /hình ảnh|ảnh|hình|image|photo/i }).first();
          if (await imgItem.count().catch(() => 0)) {
            [chooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null),
              imgItem.click({ timeout: 4000 }).catch(() => {}),
            ]);
          }
        }
        if (chooser) { await chooser.setFiles(imagePaths); uploaded = true; }
        else { await sleep(page, 800); uploaded = await setOnAnyInput(); }
      } catch {}
    }
  }

  await sleep(page, 1500);
  await shot(page, '05-after-upload');
  return uploaded;
}

/**
 * Nhập và gửi tin nhắn (+ ảnh tuỳ chọn). PORT Y HỆT Xeko: GỬI ẢNH TRƯỚC thành 1 tin riêng,
 * RỒI GỬI TEXT thành tin riêng. textarea bind Vue v-model → fill() + bắn 'input' để BẬT nút Gửi;
 * KHÔNG gõ Enter (Enter chỉ xuống dòng).
 */
async function typeAndSend(page, message, imagePaths = []) {
  let sentAny = false;

  // ----- 1. ẢNH: đính rồi gửi (1 tin riêng) -----
  if (imagePaths && imagePaths.length > 0) {
    const uploaded = await attachImages(page, imagePaths);
    if (uploaded) {
      if (await clickSend(page)) sentAny = true;
      await sleep(page, 1500); // chờ tin ảnh gửi xong + ô soạn reset trước khi nhập text
    }
  }

  // ----- 2. TEXT: nhập vào textarea.msg-textarea rồi gửi -----
  if (message) {
    const ta = page.locator('textarea.msg-textarea, textarea[placeholder*="Nhập tin nhắn"], textarea:visible').first();
    if (!(await ta.isVisible().catch(() => false))) {
      throw new Error('KHONG_THAY_O_NHAP: Không tìm thấy ô nhập tin nhắn.');
    }
    await ta.click({ timeout: 5000 });
    await ta.fill(message);
    await ta.evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, message);
    await shot(page, '05-message-typed');
    if (await clickSend(page)) sentAny = true;
  }

  await page.waitForTimeout(1500);
  await shot(page, '06-sent');
  if (!sentAny) {
    throw new Error('KHONG_GUI_DUOC: không gửi được tin nào (ảnh & text đều thất bại).');
  }
}

/**
 * Hàm chính: gửi 1 tin nhắn báo hàng về.
 * @param {object} p
 * @param {string} p.profile         - tên profile (account zalo) để load session
 * @param {string} [p.account]       - label account để chọn trong dropdown (nếu có)
 * @param {string} p.keyword         - SĐT khách (dùng để tìm + kiểm tra whitelist)
 * @param {string} [p.name]          - tên khách (dùng để tìm/khớp hội thoại)
 * @param {string} p.message         - nội dung tin nhắn
 * @param {string[]} [p.imagePaths]  - ảnh đính kèm (gửi trước, rồi mới gửi text). Mặc định text-only.
 * @param {'group'|'personal'} [p.notifyTarget] - kiểu báo của NV: 'group' bấm tab Nhóm + chỉ chọn
 *        hội thoại nhóm; 'personal' nhắn chat 1-1 (Trò chuyện trước, fallback "Người dùng Zalo"). Mặc định 'group'.
 * @returns {Promise<{ok:boolean}>}
 */
async function sendBaoHang({ profile = 'default', account, keyword, name, message, strictMatch = false, imagePaths = [], notifyTarget = 'group' }) {
  if (!keyword && !name) throw new Error('Thiếu keyword (SĐT) hoặc name (tên khách).');
  if (!message && !(imagePaths && imagePaths.length)) throw new Error('Thiếu nội dung tin nhắn.');

  // CHẶN AN TOÀN: ở chế độ TEST chỉ gửi tới số nằm trong TEST_PHONES
  if (!phoneAllowed(keyword)) {
    throw new Error(`TEST_MODE: bỏ qua "${keyword}" — không nằm trong TEST_PHONES (an toàn, không gửi).`);
  }

  // Tuần tự hoá theo profile: không mở trùng userDataDir với lệnh đăng nhập/kiểm tra cùng profile.
  return withProfileLock(profile, async () => {
    const page = await getPage(profile);
    try {
      await gotoSalework(page);
      await ensureLoggedIn(page);

      // Chọn tài khoản Zalo: ưu tiên account truyền vào, sau đó tới DEFAULT_ZALO_ACCOUNT trong .env.
      // HUỶ gửi nếu không xác minh được đúng tài khoản — thà báo lỗi rõ ràng còn hơn âm thầm gửi
      // bằng tài khoản mặc định ("Tất cả Zalo") → gửi nhầm khách của tài khoản khác.
      const acct = account || config.defaultZaloAccount;
      if (acct) {
        const ok = await selectZaloAccount(page, acct);
        if (!ok) {
          throw new Error(`KHONG_CHON_DUNG_TAI_KHOAN: không chọn/xác minh được tài khoản Zalo "${acct}". Đã huỷ gửi để tránh gửi nhầm tài khoản — mở lại Zalo Basso kiểm tra danh sách tài khoản đã kết nối.`);
        }
      } else if (strictMatch) {
        // Luồng TỰ ĐỘNG (strictMatch) mà KHÔNG biết gửi bằng account nào -> KHÔNG gửi. Nếu để
        // trống, ô lọc đang ở "Tất cả Zalo" sẽ quét hội thoại của MỌI account -> dễ gửi nhầm
        // khách của account khác. Cấu hình account cho NV (UI Tài khoản Zalo) hoặc AUTO_NOTIFY_ACCOUNT.
        throw new Error('KHONG_RO_TAI_KHOAN: luồng tự động không xác định được tài khoản Zalo để gửi (chưa map NV → account, cũng chưa đặt AUTO_NOTIFY_ACCOUNT). Đã huỷ để tránh gửi nhầm tài khoản.');
      }

      await searchAndClickConversation(page, { name, phone: keyword, strictMatch, notifyTarget });
      await typeAndSend(page, message, imagePaths);
    } finally {
      // Gửi xong (kể cả khi lỗi) thì đóng trình duyệt để giải phóng tài nguyên.
      // Tắt bằng CLOSE_AFTER_SEND=false nếu muốn giữ context sống cho lần gửi sau.
      if (config.closeAfterSend) await closeContext(profile);
    }
    return { ok: true };
  });
}

/**
 * Kiểm tra 1 profile còn đăng nhập Zalo Basso không (mở trang chat rồi thử ensureLoggedIn).
 * Dùng cho cột "Kết nối" trên UI — gọi theo yêu cầu (không tự chạy mỗi lần load vì tốn browser).
 * @returns {Promise<{loggedIn:boolean, error?:string}>}
 */
async function checkLoggedIn(profile = 'default') {
  return withProfileLock(profile, async () => {
    const page = await getPage(profile);
    try {
      await gotoSalework(page);
      await ensureLoggedIn(page);
      return { loggedIn: true };
    } catch (e) {
      return { loggedIn: false, error: e.message };
    } finally {
      if (config.closeAfterSend) await closeContext(profile);
    }
  });
}

module.exports = { sendBaoHang, gotoSalework, ensureLoggedIn, listZaloAccounts, checkLoggedIn };
