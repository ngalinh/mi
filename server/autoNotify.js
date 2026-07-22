'use strict';
const config = require('./config');
const { getOrders } = require('./bassoApi');
const { notifyOne, delayBetweenCustomers } = require('./notifyService');
const { getAutoRecord, recordAutoNotified, autoKey, autoKeyShip, getSetting, setSetting, getDelayedMap } = require('./db');
const { checkLocalHealth, sendBaoHang, getAccountsCached } = require('./playwrightProxy');
const { withLock } = require('./lock');
const { resolveForOrder } = require('./accountResolver');

/**
 * TỰ ĐỘNG BÁO HÀNG.
 *
 * Cứ có đơn ở trạng thái "Chưa báo" (not_sent = hàng đã về kho nhưng chưa nhắn khách)
 * thì tự build tin nhắn + gửi qua Zalo, không cần bấm tay trên dashboard.
 *
 * 2 cách kích hoạt, dùng chung 1 hàm runAutoNotify():
 *   1) Poller định kỳ (startAutoNotify) — server tự quét mỗi `intervalMs`.
 *   2) Webhook /api/webhook/arrived — website Basso gọi sang để gửi NGAY khi có hàng về.
 *
 * Chống gửi trùng: bảng `auto_notified` (SQLite), khóa theo customerId+dateInventory
 * (khóa ổn định của 1 dòng hàng về). Gửi thành công 1 lần là khóa lại; lỗi CẤP-ĐƠN thì
 * tăng attempts, quá `maxRetries` thì bỏ qua. Lỗi TẠM THỜI (runner offline/timeout) KHÔNG
 * trừ attempts và dừng lượt — để thử lại nguyên vẹn khi runner online lại.
 */

const cfg = config.autoNotify;

// Khoá lưu giờ gửi cố định trong app_settings (admin đổi trên trang Cài đặt -> ghi đè env).
const SCHEDULE_SETTING_KEY = 'autoNotify.scheduleTime';
// Khoá lưu "nhắc soạn ND trước bao nhiêu phút" (số nguyên phút; 0 = tắt nhắc).
const PRECHECK_SETTING_KEY = 'autoNotify.precheckMinutes';
// Khoá lưu công tắc RIÊNG cho tự động báo ship ('true'/'false').
const SHIP_ENABLED_KEY = 'autoNotify.shipEnabled';
// Khoá lưu MỐC ĐÃ SEED lúc bật báo ship (ISO time). Có mốc = đã chốt "ảnh chụp tồn cũ" -> chỉ ND
// ship phát sinh SAU đó mới gửi. Trống = chưa seed (đang chuẩn bị / seed lỗi) -> chưa gửi để an toàn.
const SHIP_SEEDED_KEY = 'autoNotify.shipSeededAt';
// Khoá lưu THỐNG KÊ seed gần nhất (JSON {at,scanned,seeded}) để dòng "Đã seed N đơn tồn cũ" trên
// trang Cài đặt KHÔNG mất khi server restart/recycle (trước đây chỉ giữ trong RAM -> reload sau
// khi cloud recycle là trống).
const SHIP_SEED_INFO_KEY = 'autoNotify.shipSeedInfo';
// Khoá lưu cấu hình "nhắc ra Zalo (nội bộ)".
const ALERT_ENABLED_KEY = 'autoNotify.alertEnabled';
const ALERT_ACCOUNT_KEY = 'autoNotify.alertAccount';
const ALERT_PHONE_KEY = 'autoNotify.alertPhone';
const ALERT_NAME_KEY = 'autoNotify.alertName';

/** Đọc 1 thiết lập, nuốt lỗi -> null. */
function safeGet(key) {
  try { return getSetting(key); } catch (_) { return null; }
}

/** Chuẩn hoá số phút nhắc-trước: số nguyên 0..1439, ngoài range/không parse -> null. Trống -> null. */
function normalizeMinutes(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 1439) return null;
  return n;
}

/** Số phút trong ngày -> 'HH:MM'. */
function minutesToHHMM(mins) {
  const mm = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

/**
 * Chuẩn hoá chuỗi giờ "HH:MM" (24h). Trả:
 *   - ''      : trống -> TẮT hẹn giờ (quay lại gửi ngay theo interval)
 *   - 'HH:MM' : hợp lệ, đã đệm 0
 *   - null    : SAI định dạng (để nơi gọi báo lỗi)
 */
function normalizeTime(value) {
  if (value == null) return '';
  const t = String(value).trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * Lấy "ngày" (YYYY-MM-DD) và "số phút trong ngày" theo múi giờ cfg.timezone cho 1 mốc thời gian.
 * Dùng Intl (built-in) để quy đổi — không phụ thuộc giờ máy chủ (thường UTC). Lỗi tz -> UTC.
 */
function localParts(date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  } catch (_) {
    // Múi giờ không hợp lệ -> rơi về UTC để vẫn chạy được.
    return { day: date.toISOString().slice(0, 10), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

// Giờ gửi cố định lúc khởi động: ưu tiên giá trị admin đã lưu (DB), rồi tới mặc định env.
// Giá trị DB sai định dạng (không nên xảy ra) -> bỏ, dùng env.
function initialScheduleTime() {
  let saved = null;
  try { saved = getSetting(SCHEDULE_SETTING_KEY); } catch (_) { saved = null; }
  if (saved != null) {
    const norm = normalizeTime(saved);
    if (norm !== null) return norm;
  }
  const fromEnv = normalizeTime(cfg.scheduleTime);
  return fromEnv === null ? '' : fromEnv;
}

// Số phút nhắc-trước lúc khởi động: giá trị admin đã lưu (DB) -> env -> mặc định 30.
function initialPrecheckMinutes() {
  let saved = null;
  try { saved = getSetting(PRECHECK_SETTING_KEY); } catch (_) { saved = null; }
  if (saved != null) { const n = normalizeMinutes(saved); if (n != null) return n; }
  const envN = normalizeMinutes(cfg.precheckMinutes);
  return envN == null ? 30 : envN;
}

// Công tắc báo ship lúc khởi động: giá trị admin đã lưu (DB) ghi đè mặc định env (cfg.shipEnabled).
function initialShipEnabled() {
  const saved = safeGet(SHIP_ENABLED_KEY);
  if (saved != null) return saved === 'true';
  return !!cfg.shipEnabled;
}

/** Khôi phục thống kê seed gần nhất từ DB (để hiển thị giữ qua restart). null nếu chưa có/hỏng. */
function initialShipSeed() {
  const raw = safeGet(SHIP_SEED_INFO_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Cấu hình "nhắc ra Zalo" lúc khởi động: DB (admin lưu) ghi đè env.
function initialAlert() {
  const a = cfg.alert || {};
  const savedEnabled = safeGet(ALERT_ENABLED_KEY);
  const savedAccount = safeGet(ALERT_ACCOUNT_KEY);
  const savedPhone = safeGet(ALERT_PHONE_KEY);
  const savedName = safeGet(ALERT_NAME_KEY);
  return {
    enabled: savedEnabled != null ? savedEnabled === 'true' : !!a.enabled,
    account: savedAccount != null ? savedAccount : (a.account || ''),
    phone: savedPhone != null ? savedPhone : (a.phone || ''),
    name: savedName != null ? savedName : (a.name || 'Admin'),
  };
}

// Trạng thái runtime (dùng cho /api/auto-notify + dashboard)
const state = {
  enabled: cfg.enabled,
  running: false,
  // Sau khi khởi động lại: nếu bật (true), MỌI lượt gửi tự động (interval/scheduled/webhook) bị
  // hoãn — kể cả "gửi bù" đợt đang dở — tới khi admin bấm "Quét & gửi" hoặc bật lại auto. Đặt ở
  // startAutoNotify khi resumeOnBoot=false; gỡ khi có hành động chủ động của admin.
  awaitingResume: false,
  lastRun: null,       // ISO time của lần chạy gần nhất
  lastResult: null,    // tóm tắt lần chạy gần nhất
  // BÁO SHIP (song song với báo hàng): quét đơn đã có "ND báo ship" và tự gửi. Cờ chạy + kết quả
  // tách riêng để lượt ship không đụng lượt báo hàng và hiện được trạng thái riêng trên dashboard.
  // shipEnabled = công tắc RIÊNG (độc lập báo hàng) — bật/tắt trên trang Cài đặt, lưu bền DB.
  shipEnabled: initialShipEnabled(),
  shipSeeding: false,   // đang chạy seed "ảnh chụp tồn cũ" lúc bật báo ship
  lastShipSeed: initialShipSeed(),   // kết quả seed gần nhất { at, scanned, seeded } (khôi phục từ DB)
  runningShip: false,
  lastShipRun: null,
  lastShipResult: null,
  startedAt: null,
  scheduleTime: initialScheduleTime(), // '' = gửi ngay (interval); 'HH:MM' = hẹn giờ
  lastScheduledDay: null,              // YYYY-MM-DD (giờ VN) của lần chạy-theo-lịch gần nhất
  precheckMinutes: initialPrecheckMinutes(), // nhắc soạn ND trước giờ gửi (phút); 0 = tắt
  lastPrecheckDay: null,               // YYYY-MM-DD của lần nhắc gần nhất (1 lần/ngày)
  lastPrecheck: null,                  // kết quả nhắc gần nhất (để hiện trên Cài đặt)
  // Nhắc ra Zalo (nội bộ)
  ...(() => { const a = initialAlert(); return { alertEnabled: a.enabled, alertAccount: a.account, alertPhone: a.phone, alertName: a.name }; })(),
  lastAlert: null,                     // kết quả gửi nhắc Zalo gần nhất
};

let timer = null;      // timer BÁO HÀNG (hẹn giờ / interval)
let shipTimer = null;  // timer BÁO SHIP (cadence RIÊNG, nhanh hơn — cfg.shipIntervalMs)

/**
 * Tới giờ hẹn chưa? (chạy MỖI scheduleCheckMs). Chỉ gọi Basso khi ĐÃ tới giờ và CHƯA chạy hôm
 * nay -> mỗi ngày đúng 1 lượt gửi. Nếu server khởi động lại SAU giờ hẹn mà hôm đó chưa chạy,
 * lượt này vẫn nổ để "gửi bù" — an toàn vì dedup (auto_notified) chặn gửi trùng khách.
 */
function scheduleTick() {
  // BÁO HÀNG theo giờ hẹn — chỉ chạy khi báo hàng đang BẬT và có đặt giờ.
  if (state.enabled && state.scheduleTime) {
    const { day, minutes } = localParts(new Date());
    const [h, m] = state.scheduleTime.split(':').map(Number);
    const target = h * 60 + m;

    // NHẮC SOẠN ND: trước giờ gửi `precheckMinutes` phút, quét (đọc tươi) & cảnh báo đơn thiếu ND.
    // Chạy 1 lần/ngày trong khung [target-lead, target) — sau giờ gửi thì thôi (lượt gửi tự xử lý).
    const lead = state.precheckMinutes;
    if (lead > 0) {
      const precheckAt = target - lead;
      if (precheckAt >= 0 && minutes >= precheckAt && minutes < target && state.lastPrecheckDay !== day) {
        state.lastPrecheckDay = day;
        runPrecheck(day);
      }
    }

    // GỬI đúng giờ (1 lần/ngày). Đặt mốc "đã chạy hôm nay" TRƯỚC để không nổ 2 lần ở 2 tick liền
    // nhau; nhưng nếu lượt bị BỎ (runner offline / đang chạy lượt khác) thì NHẢ mốc ra để thử lại
    // ở tick kế -> đúng 17h mà runner offline sẽ TỰ GỬI BÙ khi runner online lại, không mất cả ngày.
    if (minutes >= target && state.lastScheduledDay !== day) {
      state.lastScheduledDay = day;
      console.log(`[auto-notify] tới giờ ${state.scheduleTime} (${cfg.timezone}) — chạy lượt gửi theo lịch cho ngày ${day}.`);
      Promise.resolve(runAutoNotify({ trigger: 'scheduled' }))
        .then((r) => {
          if (r && r.skipped) {
            state.lastScheduledDay = null;
            console.warn(`[auto-notify] lượt ${state.scheduleTime} bị bỏ (${r.reason || 'không rõ'}) — sẽ thử lại ở lần kiểm tra kế (${Math.round(cfg.scheduleCheckMs / 1000)}s).`);
          } else if (r && state.alertEnabled) {
            // Gửi xong -> nhắn tổng kết ra Zalo cho người trực.
            dispatchAlert(buildSummaryAlertMessage(r)).catch(() => {});
          }
        })
        .catch(() => { state.lastScheduledDay = null; });
    }
  }
  // Báo ship KHÔNG đi theo nhịp này nữa — nó có timer RIÊNG (shipTimer) quét nhanh hơn.
}

/** 1 nhịp ở chế độ GỬI NGAY (không hẹn giờ) cho BÁO HÀNG. Báo ship dùng timer riêng. */
function intervalTick() {
  if (state.enabled) runAutoNotify({ trigger: 'interval' });
}

/** Quét & gửi báo ship 1 lượt ở nền (không chặn) — chỉ khi CÔNG TẮC BÁO SHIP đang BẬT. Nuốt lỗi.
 * Trigger mặc định 'ship-poll' -> đọc TƯƠI từ Basso để bắt ND ship mới ngay (gần real-time). */
function maybeRunShip(trigger = 'ship-poll') {
  if (!state.shipEnabled) return;
  runAutoNotifyShip({ trigger }).catch(() => {});
}

/**
 * NHẮC SOẠN ND (không gửi): quét tươi, ghi cảnh báo số đơn còn thiếu nội dung báo hàng + lưu kết
 * quả vào state.lastPrecheck để trang Cài đặt hiển thị. Chạy trước giờ gửi để NV kịp soạn nốt.
 */
async function runPrecheck(day) {
  try {
    const p = await previewAutoNotify();
    state.lastPrecheck = { at: new Date().toISOString(), day, ...p };
    if (p.missingContent > 0) {
      const names = p.missingList.slice(0, 20)
        .map((o) => `${o.customerName || o.orderCode || '?'}${o.staff ? ` (${o.staff})` : ''}`).join(', ');
      console.warn(`[auto-notify] NHẮC (trước giờ gửi ${state.scheduleTime}): ${p.missingContent} đơn CHƯA có ND báo hàng — sẽ bị bỏ qua nếu không soạn kịp: ${names}`);
    } else {
      console.log(`[auto-notify] NHẮC (trước giờ gửi ${state.scheduleTime}): ${p.ready} đơn đã đủ ND, không đơn nào thiếu ✅`);
    }
    // Nhắc ra Zalo (nếu bật): bắn tin cho người trực để biết mà không cần mở mi.
    if (state.alertEnabled) {
      dispatchAlert(buildPrecheckAlertMessage(p)).catch(() => {});
    }
  } catch (e) {
    console.warn('[auto-notify] nhắc soạn ND lỗi:', e.message);
  }
}

/**
 * NHẮC RA ZALO (nội bộ) — bắn 1 tin cho người trực (state.alertPhone) bằng account state.alertAccount
 * qua chính local-runner. KHÔNG đi qua notifyOne (không ghi Lịch sử báo, không cập nhật web) — chỉ
 * là tin nội bộ. Trả { ok, error }. Bỏ qua nếu thiếu SĐT/nội dung hoặc runner offline.
 */
async function dispatchAlert(message, opts = {}) {
  const phone = String((opts.phone != null ? opts.phone : state.alertPhone) || '').trim();
  const account = opts.account != null ? opts.account : state.alertAccount;
  const name = (opts.name != null ? opts.name : state.alertName) || 'Admin';
  if (!phone) return { ok: false, error: 'Chưa cấu hình SĐT nhận nhắc' };
  if (!message) return { ok: false, error: 'Thiếu nội dung' };
  const online = await checkLocalHealth().catch(() => false);
  if (!online) {
    state.lastAlert = { at: new Date().toISOString(), ok: false, error: 'local-runner offline', phone };
    return { ok: false, error: 'local-runner offline' };
  }
  const resolved = await resolveAlertAccount(account);
  let r;
  try {
    r = await sendBaoHang({
      profile: resolved.profile || 'default',
      account: resolved.account,
      keyword: phone,          // tìm hội thoại theo SĐT người nhận
      name,
      message,
      strictMatch: false,
      // Nhắc nội bộ = TIN 1-1 cho người trực -> luôn chế độ cá nhân (tab "Cá nhân" + mục "Tin nhắn"),
      // không phụ thuộc "Kiểu báo" của account. Trước đây thiếu -> mặc định nhóm -> tìm trong
      // "Trò chuyện" không ra chat cá nhân của người trực -> KHONG_THAY_HOI_THOAI.
      notifyTarget: 'personal',
    });
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  state.lastAlert = { at: new Date().toISOString(), ok: !!r.ok, error: r.error || null, phone };
  if (!r.ok) console.warn(`[auto-notify] gửi nhắc Zalo thất bại (${phone}): ${r.error}`);
  return r;
}

/** Tìm account Zalo để gửi nhắc theo tên (saleworkName/name/key). Không thấy -> dùng tên như account. */
async function resolveAlertAccount(nameOrKey) {
  const target = String(nameOrKey || '').trim().toLowerCase();
  if (!target) return { profile: 'default', account: undefined };
  let accounts = [];
  try { accounts = await getAccountsCached(); } catch (_) { accounts = []; }
  const norm = (s) => String(s || '').trim().toLowerCase();
  const a = (accounts || []).find((x) => norm(x.saleworkName) === target || norm(x.name) === target || norm(x.key) === target);
  if (a) return { profile: a.key, account: a.saleworkName || undefined };
  return { profile: 'default', account: nameOrKey };
}

/** Soạn tin NHẮC (trước giờ gửi) gửi ra Zalo. */
function buildPrecheckAlertMessage(p) {
  const lines = [`🔔 [mi] Nhắc soạn ND — trước giờ gửi ${state.scheduleTime}`,
    `Sẽ gửi: ${p.willSend} đơn · Thiếu ND: ${p.missingContent}`];
  if (p.missingContent > 0) {
    const names = (p.missingList || []).slice(0, 15)
      .map((o) => `- ${o.customerName || o.orderCode || '?'}${o.staff ? ` (${o.staff})` : ''}`).join('\n');
    lines.push(`Đơn CHƯA có ND (sẽ bị bỏ qua nếu không soạn kịp):\n${names}${(p.missingList || []).length > 15 ? '\n…' : ''}`);
  } else {
    lines.push('✅ Mọi đơn sẽ gửi đều đã có nội dung.');
  }
  return lines.join('\n');
}

/** Soạn tin TỔNG KẾT (sau khi gửi) gửi ra Zalo. */
function buildSummaryAlertMessage(r) {
  const other = (r.skippedBacklog || 0) + (r.skippedDelayed || 0) + (r.skippedAutoOff || 0)
    + (r.skippedNoAccount || 0) + (r.skippedBrand || 0);
  return [`✅ [mi] Đã chạy gửi lúc ${state.scheduleTime}`,
    `Gửi thành công: ${r.sent || 0} · Lỗi: ${r.failed || 0}`,
    `Thiếu ND (bỏ qua): ${r.skippedNoContent || 0} · Bỏ qua khác: ${other}`].join('\n');
}

/** Tóm tắt tình trạng hẹn giờ cho dashboard/Cài đặt. */
function scheduleInfo() {
  if (!state.scheduleTime) return { mode: 'interval', scheduleTime: '', precheckMinutes: state.precheckMinutes };
  const { day, minutes } = localParts(new Date());
  const [h, m] = state.scheduleTime.split(':').map(Number);
  const target = h * 60 + m;
  const ranToday = state.lastScheduledDay === day;
  let next; // trạng thái lượt kế: đã gửi hôm nay | chờ tới giờ hôm nay | (đã qua giờ) gửi ngay/mai
  if (ranToday) next = 'done_today';
  else if (minutes < target) next = 'today';
  else next = 'due';
  const lead = state.precheckMinutes;
  const precheckAt = lead > 0 && target - lead >= 0 ? minutesToHHMM(target - lead) : '';
  return {
    mode: 'scheduled', scheduleTime: state.scheduleTime, timezone: cfg.timezone, ranToday, next,
    precheckMinutes: lead, precheckTime: precheckAt,
  };
}

/** Lỗi tạm thời (runner down / mạng / timeout) — KHÔNG nên trừ lượt thử của đơn. */
function isTransientError(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('econnrefused') || m.includes('local-runner') ||
    m.includes('timeout') || m.includes('hết thời gian') ||
    m.includes('network') || m.includes('fetch failed') ||
    m.includes('socket') || m.includes('etimedout')
  );
}

/**
 * Quy 1 mốc thời gian về "ngày lịch" theo múi giờ cfg.timezone (VN) để so sánh, KHÔNG lệ thuộc
 * giờ máy chủ. Nhận: unix giây (date_inventory của Basso, vd 1780531200), unix ms, hoặc chuỗi
 * ISO (autoEnabledAt). Trả 'YYYY-MM-DD' (so sánh chuỗi = so ngày), null nếu không parse được.
 *
 * PHẢI bucket theo VN, KHÔNG theo UTC: date_inventory là nửa đêm GIỜ VN (vd 06/07 00:00 VN =
 * 05/07 17:00 UTC). Nếu chia ngày theo UTC (floor ms/86400000) thì đơn "về hôm nay" rơi vào
 * bucket "hôm qua", còn autoEnabledAt (bấm Bật ban ngày VN) ở bucket "hôm nay" -> đơn hôm nay
 * bị coi là "tồn cũ" và bỏ HẾT. So theo ngày VN thì "đơn về CÙNG ngày bật auto" mới gửi đúng.
 */
function localDayKey(value) {
  if (value == null || value === '') return null;
  let ms;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    ms = n < 1e12 ? n * 1000 : n; // giây -> ms
  } else {
    const t = Date.parse(value);
    if (Number.isNaN(t)) return null;
    ms = t;
  }
  return localParts(new Date(ms)).day; // 'YYYY-MM-DD' theo cfg.timezone (VN)
}

/**
 * Quyết định 1 đơn có được TỰ ĐỘNG gửi không, và nếu KHÔNG thì vì lý do gì. DÙNG CHUNG cho lượt
 * gửi thật (runAutoNotify) và xem trước (previewAutoNotify) -> số "sẽ gửi" trên preview LUÔN KHỚP
 * số thật lúc gửi. Trả { decision:'send'|'skip', reason?, acct? }. Các reason bỏ qua:
 *   not_target | no_content | already | max_retries | delayed | no_account | auto_off | brand | backlog
 * Check RẺ (trạng thái/nội dung/đã gửi/Delay) chạy TRƯỚC; chỉ đơn còn lọt mới resolve account (đắt hơn).
 */
async function classifyForAuto(order, delayedMap) {
  if (order.statusCode !== 'not_sent') return { decision: 'skip', reason: 'not_target' }; // chỉ "Chưa báo"
  // Chỉ tự gửi khi Basso ĐÃ soạn sẵn "ND báo hàng" (raw.content). Đơn trống ND -> bỏ qua.
  if (!order.noiDungBaoHang || !String(order.noiDungBaoHang).trim()) return { decision: 'skip', reason: 'no_content' };
  const rec = getAutoRecord(autoKey(order));
  // Đã gửi (bot 'success' hoặc báo tay 'manual') -> không gửi lại. Hết lượt thử -> thôi.
  if (rec && (rec.status === 'success' || rec.status === 'manual')) return { decision: 'skip', reason: 'already' };
  if (rec && rec.attempts >= cfg.maxRetries) return { decision: 'skip', reason: 'max_retries' };
  // Cờ Delay/Loại trừ (lưu ở mi) -> tạm hoãn: bỏ khỏi cả luồng tự động (khớp "Báo hàng loạt").
  if (delayedMap && delayedMap.has(autoKey(order))) return { decision: 'skip', reason: 'delayed' };

  // MÔ HÌNH B: chọn account theo NV phụ trách đơn (kênh Zalo mặc định, Facebook nếu đơn/NV được
  // định tuyến FB). source 'store' = account Zalo khớp NV, 'store-fb' = account Facebook khớp NV.
  const acct = await resolveForOrder(order, { defaultAccount: cfg.account, profile: cfg.profile });
  const fromStore = acct.source === 'store' || acct.source === 'store-fb';
  // CÔ LẬP THEO NV: chỉ gửi đơn khớp đúng 1 account khi bật requireAccount.
  if (cfg.requireAccount && !fromStore) return { decision: 'skip', reason: 'no_account', acct };
  // Đơn cần báo FB nhưng NV chưa có tài khoản Facebook -> bỏ (không gửi nhầm kênh).
  if (acct.skip && acct.skipReason === 'fb_no_account') return { decision: 'skip', reason: 'no_account', acct };
  // Account của NV bị TẮT "Tự động báo" -> bỏ qua (để NV báo tay).
  if (fromStore && acct.autoEnabled === false) return { decision: 'skip', reason: 'auto_off', acct };
  // HƯỚNG A: NV chưa có Zalo cho brand của đơn -> bỏ (tránh gửi nhầm brand).
  if (acct.skip && acct.skipReason === 'brand') return { decision: 'skip', reason: 'brand', acct };
  // CHỈ BÁO ĐƠN VỀ TỪ KHI BẬT AUTO: đơn về TRƯỚC ngày bật "Tự động báo" (autoEnabledAt) -> bỏ,
  // tránh nhắn trùng loạt khách cũ đã xử lý tay. Tắt qua AUTO_NOTIFY_ONLY_NEW=false. So theo NGÀY
  // nên đơn về CÙNG ngày bật auto vẫn gửi. Chỉ áp dụng cho account khớp NV có mốc autoEnabledAt.
  if (cfg.onlyNewOrders && fromStore && acct.autoEnabledAt) {
    const orderDay = localDayKey(order.dateInventory);
    const sinceDay = localDayKey(acct.autoEnabledAt);
    // So sánh chuỗi 'YYYY-MM-DD' theo giờ VN: chỉ bỏ đơn về NGÀY TRƯỚC ngày bật auto.
    if (orderDay != null && sinceDay != null && orderDay < sinceDay) return { decision: 'skip', reason: 'backlog', acct };
  }
  return { decision: 'send', acct };
}

/**
 * Quyết định 1 đơn có được TỰ ĐỘNG BÁO SHIP không (song song với classifyForAuto cho báo hàng).
 * Điều kiện gửi cốt lõi: Basso ĐÃ soạn "ND báo ship" (raw.content_ship) cho đơn — đó chính là tín
 * hiệu "API nhận được nội dung báo ship". Các bước chọn account/lọc Delay/tồn đọng dùng chung với
 * báo hàng để hành vi nhất quán. Chống trùng theo autoKeyShip (tách khỏi dấu báo hàng).
 * Trả { decision:'send'|'skip', reason?, acct? }.
 */
async function classifyForShip(order, delayedMap) {
  // KHÔNG chặn theo TRẠNG THÁI. NV hay QUÊN/nhầm tick: đơn kẹt "Chưa báo" dù đang giao, HOẶC tick
  // "Đã báo ship" TAY dù Mi chưa gửi (ND ship hiện sau). Nên hễ đơn CÓ "ND báo ship" là xét gửi,
  // dù trạng thái là not_sent / notified_arrival / notified_ship. Chống trùng CHỈ dựa vào DẤU
  // auto_notified (success/manual/seeded) bên dưới -> đơn Mi đã gửi thật mới bị bỏ, còn đơn "đã báo
  // ship" trên web nhưng Mi chưa gửi (ca Hải Hà) vẫn được báo cho khách.
  // Chỉ tự gửi khi Basso ĐÃ soạn sẵn "ND báo ship" (raw.content_ship). Đơn trống -> bỏ qua.
  if (!order.noiDungBaoShip || !String(order.noiDungBaoShip).trim()) return { decision: 'skip', reason: 'no_content' };
  const rec = getAutoRecord(autoKeyShip(order));
  // Đã xử lý -> không gửi lại:
  //   'success'/'manual' = đã gửi ship (bot/tay);
  //   'seeded'           = tồn cũ đã có sẵn ND ship LÚC BẬT (chốt ảnh chụp, KHÔNG gửi).
  // Nhờ 'seeded', chỉ ND ship XUẤT HIỆN SAU khi bật (đơn chưa có dấu) mới được gửi — không phụ
  // thuộc ngày về kho, nên "ND ship mới trên đơn cũ hôm qua" vẫn gửi đúng.
  if (rec && (rec.status === 'success' || rec.status === 'manual' || rec.status === 'seeded')) return { decision: 'skip', reason: 'already' };
  if (rec && rec.attempts >= cfg.maxRetries) return { decision: 'skip', reason: 'max_retries' };
  // Cờ Delay/Loại trừ dùng chung khóa đơn (autoKey) -> đơn đang hoãn thì cũng hoãn báo ship.
  if (delayedMap && delayedMap.has(autoKey(order))) return { decision: 'skip', reason: 'delayed' };
  // KHÔNG chờ báo hàng gửi trước: NV thường đã báo hàng (tay) TRƯỚC khi Basso có ND ship, nên hễ
  // XUẤT HIỆN ND ship là GỬI NGAY — không đợi lượt báo hàng, tránh trễ ship (kể cả đơn còn "Chưa báo").

  // Chọn account theo NV phụ trách (giống báo hàng).
  const acct = await resolveForOrder(order, { defaultAccount: cfg.account, profile: cfg.profile });
  const fromStore = acct.source === 'store' || acct.source === 'store-fb';
  if (cfg.requireAccount && !fromStore) return { decision: 'skip', reason: 'no_account', acct };
  if (acct.skip && acct.skipReason === 'fb_no_account') return { decision: 'skip', reason: 'no_account', acct };
  if (fromStore && acct.autoEnabled === false) return { decision: 'skip', reason: 'auto_off', acct };
  if (acct.skip && acct.skipReason === 'brand') return { decision: 'skip', reason: 'brand', acct };
  // KHÔNG lọc theo ngày về kho nữa: "mới/cũ" của báo ship do cơ chế SEED lúc bật quyết định
  // (đơn có sẵn ND ship lúc bật -> 'seeded' -> bỏ; ND ship phát sinh sau -> gửi).
  return { decision: 'send', acct };
}

/**
 * SEED lúc bật báo ship: chụp ảnh MỌI đơn ĐANG có sẵn "ND báo ship" tại thời điểm bật rồi đánh dấu
 * 'seeded' (KHÔNG gửi) -> coi là tồn cũ, bỏ qua. MỐC TUYỆT ĐỐI: seed bất kể đơn đang bị chặn hay
 * không (account tắt auto / brand / chưa báo hàng) -> "đơn cũ" có ND ship trước lúc bật KHÔNG bao giờ
 * bị nhắn, kể cả khi sau này gỡ chặn account. Nhờ vậy chỉ ND ship XUẤT HIỆN SAU khi bật (đơn chưa có
 * dấu) mới được gửi. Chỉ đọc Basso + ghi DB, KHÔNG cần local-runner. Ghi mốc SHIP_SEEDED_KEY khi
 * xong. Muốn nhắn lại nhóm cũ -> BẬT lại (chốt mốc mới).
 *
 * Quét CẢ 'not_sent', 'notified_arrival' LẪN 'notified_ship': mỗi lần BẬT = "vạch mốc mới", loại trừ
 * MỌI đơn đang có sẵn ND ship lúc đó (kể cả đơn đã ở trạng thái "Đã báo ship" mà Mi chưa gửi) -> KHÔNG
 * nhắn loạt khi bật lại. Chỉ ND ship XUẤT HIỆN SAU khi bật (đơn chưa có dấu) mới được luồng quét gửi.
 * Nhờ vậy off -> deploy -> bật lại KHÔNG blast đơn tồn; đơn "đã báo ship tay mà Mi chưa gửi" đang tồn
 * tại đúng lúc bật sẽ bị loại trừ (gửi tay 1 lần), còn ca phát sinh SAU vẫn được bắt real-time.
 * Đơn 'failed' (thử hụt, khách CHƯA nhận) KHÔNG bị đè 'seeded' -> vẫn được thử lại (giữ dấu cũ).
 * @returns {Promise<{at:string, scanned:number, seeded:number}>}
 */
async function seedShip() {
  let scanned = 0;
  let seeded = 0;
  const seen = new Set();
  // Seed ĐỒNG BỘ phạm vi với luồng gửi: 'notified_ship' chỉ seed trong N ngày gần đây (và bỏ hẳn nếu
  // shipRecentDays=0) -> không seed đơn nằm ngoài tầm quét gửi, tránh quét notified_ship all-time nặng.
  const seedStatuses = ['not_sent', 'notified_arrival'];
  if (cfg.shipRecentDays > 0) seedStatuses.push('notified_ship');
  for (const status of seedStatuses) {
    const days = status === 'notified_ship' ? cfg.shipRecentDays : undefined;
    // eslint-disable-next-line no-await-in-loop
    const orders = await fetchAllByStatus(status, { fresh: true, days }); // fresh: chốt đúng hiện trạng lúc bấm Bật
    for (const o of orders) {
      const k = autoKey(o);
      if (seen.has(k)) continue;
      seen.add(k);
      scanned += 1;
      // MỐC TUYỆT ĐỐI: đánh dấu 'seeded' MỌI đơn đang có sẵn ND ship lúc bật (BẤT KỂ account đang
      // bật/tắt "Tự động", brand, đã báo hàng hay chưa) -> KHÔNG gửi. Chỉ ND ship XUẤT HIỆN SAU khi
      // bật (đơn chưa có dấu) mới được gửi. Chủ đích: "đơn cũ" (đã có ND ship trước lúc bật) KHÔNG
      // bao giờ bị nhắn, kể cả sau này khi gỡ chặn account. Muốn nhắn lại nhóm cũ -> BẬT lại để chốt
      // mốc mới. (Đánh đổi: đơn đã 'seeded' mà về sau có ND ship MỚI cũng bị bỏ tới lần BẬT kế — hiếm,
      // vì ND ship 1 đơn thường chỉ soạn 1 lần; và đúng ý "chỉ nhắn đơn mới sau khi bật".)
      if (!o.noiDungBaoShip || !String(o.noiDungBaoShip).trim()) continue; // chưa có ND ship -> khỏi seed
      const key = autoKeyShip(o);
      if (getAutoRecord(key)) continue;   // đã có dấu (đã gửi/tay/seeded/thử-hụt trước) -> giữ nguyên
      recordAutoNotified(key, 'seeded', 0); // đánh dấu tồn cũ: KHÔNG gửi
      seeded += 1;
    }
  }
  const at = new Date().toISOString();
  state.lastShipSeed = { at, scanned, seeded };
  try { setSetting(SHIP_SEEDED_KEY, at); } catch (_) { /* ignore */ }
  // Lưu bền thống kê để dòng "Đã seed N đơn tồn cũ" không mất khi server restart/recycle.
  try { setSetting(SHIP_SEED_INFO_KEY, JSON.stringify(state.lastShipSeed)); } catch (_) { /* ignore */ }
  console.log(`[auto-ship] SEED lúc bật: đánh dấu ${seeded} đơn tồn cũ (đã có sẵn ND ship) trong ${scanned} đơn quét — sẽ KHÔNG gửi; chỉ gửi ND ship phát sinh sau lúc bật.`);
  return { at, scanned, seeded };
}

/** Chạy seed ở nền (chỉ 1 lần cùng lúc). Seed lỗi -> KHÔNG chốt mốc để lần sau thử lại (an toàn). */
async function startShipSeed() {
  if (state.shipSeeding) return;
  state.shipSeeding = true;
  try {
    await seedShip();
  } catch (e) {
    console.warn('[auto-ship] SEED lỗi (sẽ thử lại):', e.message);
  } finally {
    state.shipSeeding = false;
  }
}

/**
 * Lấy TẤT CẢ đơn theo 1 trạng thái qua mọi trang (vì không cập nhật web nên tập này không tự co lại).
 * @param {string} status - mã trạng thái Basso ('not_sent' báo hàng | 'notified_arrival' báo ship...)
 * @param {object} [opts] { fresh, days } — fresh=true: đọc tươi từ Basso, bỏ qua cache (dùng cho
 *   webhook để thấy NGAY đơn vừa về/vừa có ND ship, không bị cache 30s che). Poller thường dùng cache
 *   cho nhẹ. days > 0: CHỈ lấy đơn về kho trong N ngày gần đây (giới hạn tập notified_ship tích lũy).
 */
async function fetchAllByStatus(status, opts = {}) {
  const all = [];
  const seen = new Set();
  const MAX_PAGES = 50;
  let capped = false;
  // days > 0 -> truyền xuống getOrders để Basso lọc theo cửa sổ ngày (resolveDateWindow). 0/undefined
  // -> all-time (giữ hành vi cũ cho not_sent/notified_arrival là tập sống, nhỏ).
  const days = opts.days > 0 ? opts.days : undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { orders, total } = await getOrders({ status, page, pageSize: 100, fresh: !!opts.fresh, days });
    for (const o of orders) {
      const k = autoKey(o);
      if (!seen.has(k)) { seen.add(k); all.push(o); }
    }
    if (orders.length < 100) return all;               // hết trang thật -> đã quét hết
    if (total != null && all.length >= total) return all; // đã lấy đủ tổng
    if (page === MAX_PAGES) capped = true;             // còn trang đầy mà đã tới trần -> có thể sót
  }
  // Chạm trần khi vẫn còn trang đầy: cảnh báo để không tưởng nhầm "đã quét hết" (bỏ sót đơn cuối).
  if (capped) {
    console.warn(`[auto-notify] ⚠️ CHẠM TRẦN ${MAX_PAGES} trang (${all.length} đơn trạng thái "${status}") — có thể CÒN đơn chưa quét/gửi. Backlog thực sự lớn thì tăng trần trong fetchAllByStatus.`);
  }
  return all;
}

/** Lấy TẤT CẢ đơn "Chưa báo" (luồng tự động BÁO HÀNG). */
const fetchAllNotSent = (opts = {}) => fetchAllByStatus('not_sent', opts);

/**
 * Quét đơn "Chưa báo" và tự gửi. An toàn khi gọi song song (có khóa `running`).
 * @param {object} [opts] { trigger?: 'interval'|'webhook'|'manual' }
 * @returns {Promise<object>} tóm tắt { trigger, scanned, candidates, sent, failed, skipped, results }
 */
/**
 * LÕI DÙNG CHUNG cho cả tự động BÁO HÀNG và BÁO SHIP: quét đơn theo trạng thái, phân loại, gom theo
 * profile rồi gửi tuần tự. Ghi kết quả vào `summary` (mutate). KHÔNG tự đặt/nhả state.running* —
 * hàm gọi (runAutoNotify / runAutoNotifyShip) lo phần đó để mỗi luồng có cờ chạy riêng.
 * @param {object} p
 * @param {string} p.trigger  'interval'|'webhook'|'manual'|'scheduled'
 * @param {'hang'|'ship'} p.kind  loại tin gửi
 * @param {string} p.statusFilter  mã trạng thái Basso để quét ('not_sent' | 'notified_arrival')
 * @param {(order:object, delayedMap:Map)=>Promise<{decision:string,reason?:string,acct?:object}>} p.classify
 * @param {(order:object)=>string} p.keyOf  hàm tạo khóa dedup (autoKey | autoKeyShip)
 * @param {string} p.logTag  nhãn log ('auto-notify' | 'auto-ship')
 * @param {object} p.summary  đối tượng tóm tắt để ghi kết quả vào
 */
async function executeNotifyPass({ trigger, kind, statusFilter, classify, keyOf, logTag, summary }) {
  // R4: runner offline thì bỏ cả lượt, KHÔNG trừ attempts (tránh "bỏ cuộc" oan).
  const online = await checkLocalHealth();
  if (!online) {
    summary.skipped = true;
    summary.reason = 'local-runner offline';
    console.warn(`[${logTag}:${trigger}] bỏ lượt — local-runner offline (không trừ lượt thử).`);
    return;
  }

  // R6: bọc quét + gửi trong khóa dùng chung -> không chạy chồng với báo-tay (notifyMany) hay lượt kia.
  // Đặt quét đơn TRONG khóa để thấy trạng thái mới nhất sau khi luồng kia vừa gửi xong.
  await withLock(async () => {
    // Đọc TƯƠI (bỏ cache) cho webhook (thấy ngay đơn mới / ND vừa soạn), lượt theo lịch, và
    // poll báo ship ('ship-poll') — để bắt ND ship MỚI ngay, không dính cache 30s.
    const fresh = trigger === 'webhook' || trigger === 'scheduled' || trigger === 'ship-poll';
    // statusFilter có thể là 1 mã, hoặc MẢNG các entry. Mỗi entry = chuỗi mã ('not_sent') HOẶC
    // object { status, days } khi cần GIỚI HẠN cửa sổ ngày cho riêng trạng thái đó (báo ship dùng
    // { status: 'notified_ship', days: N } để không kéo cả kho notified_ship tích lũy).
    const statuses = (Array.isArray(statusFilter) ? statusFilter : [statusFilter])
      .map((s) => (typeof s === 'string' ? { status: s } : s));
    const orders = [];
    const seenKeys = new Set();
    for (const st of statuses) {
      // eslint-disable-next-line no-await-in-loop
      const part = await fetchAllByStatus(st.status, { fresh, days: st.days });
      for (const o of part) {
        const k = autoKey(o);
        if (!seenKeys.has(k)) { seenKeys.add(k); orders.push(o); }
      }
    }
    summary.scanned = orders.length;
    const delayedMap = getDelayedMap();

    // Phân loại TẤT CẢ đơn 1 lượt -> danh sách SẼ GỬI + đếm lý do bỏ qua.
    const toSend = [];
    for (const order of orders) {
      // eslint-disable-next-line no-await-in-loop
      const c = await classify(order, delayedMap);
      // classify đã resolve account -> lấy luôn profile để gom (khỏi resolve lại).
      if (c.decision === 'send') { toSend.push({ order, profileKey: (c.acct && c.acct.profile) || 'default' }); continue; }
      const bump = (k) => { summary[k] = (summary[k] || 0) + 1; };
      if (c.reason === 'no_content') bump('skippedNoContent');
      else if (c.reason === 'delayed') bump('skippedDelayed');
      else if (c.reason === 'no_account') bump('skippedNoAccount');
      else if (c.reason === 'auto_off') bump('skippedAutoOff');
      else if (c.reason === 'brand') bump('skippedBrand');
      else if (c.reason === 'backlog') bump('skippedBacklog');
      // 'already' / 'max_retries' / 'not_target' -> không đếm (không phải "đáng gửi")
    }
    // GOM THEO PROFILE (ổn định theo thứ tự tài khoản xuất hiện đầu) -> bot gửi tuần tự HẾT đơn
    // của 1 tài khoản/NV rồi mới sang cái kế, giữ context tái dùng -> đỡ mở/đóng browser.
    const rank = new Map();
    toSend.forEach((t) => { if (!rank.has(t.profileKey)) rank.set(t.profileKey, rank.size); });
    const ordered = toSend
      .map((t, i) => ({ ...t, _i: i }))
      .sort((a, b) => (rank.get(a.profileKey) - rank.get(b.profileKey)) || (a._i - b._i));
    summary.candidates = ordered.length;

    for (let i = 0; i < ordered.length; i += 1) {
      const { order, profileKey } = ordered[i];
      // Giữ context nếu đơn kế cùng profile (đã gom) -> tái dùng browser, đóng ở đơn cuối mỗi profile.
      const keepContext = i + 1 < ordered.length && ordered[i + 1].profileKey === profileKey;
      const key = keyOf(order);
      const prev = getAutoRecord(key);

      // eslint-disable-next-line no-await-in-loop
      const r = await notifyOne(order, {
        profile: cfg.profile,
        defaultAccount: cfg.account,   // fallback khi NV không có trong ZALO_ACCOUNT_MAP
        kind,
        skipWebUpdate: !cfg.updateWeb, // mặc định đẩy trạng thái về web Basso (tắt qua AUTO_NOTIFY_UPDATE_WEB=false)
        strictMatch: true,             // R5: tự động -> chỉ gửi khi khớp chắc chắn, không "lấy đại"
        actor: 'bot',                  // audit: luồng tự động
        keepContext,                   // báo loạt gom theo profile -> giữ browser cho đơn kế cùng account
      });

      // Phân loại lỗi để quyết định "dừng cả lượt" hay "tính 1 attempt rồi đi tiếp".
      // CHỈ coi là transient (dừng lượt, KHÔNG trừ lượt) khi runner THỰC SỰ offline — xác
      // nhận bằng health-check thay vì chỉ dò chữ trong message.
      // eslint-disable-next-line no-await-in-loop
      const runnerDown = !r.ok && isTransientError(r.error) && !(await checkLocalHealth());
      if (r.ok) {
        recordAutoNotified(key, 'success', (prev ? prev.attempts : 0) + 1);
        summary.sent += 1;
      } else if (r.loginRequired) {
        // Zalo hiện trang login (chưa đăng nhập): mọi đơn còn lại cũng sẽ fail như nhau -> DỪNG
        // cả lượt NGAY, KHÔNG trừ lượt thử để thử lại sau khi đã đăng nhập.
        summary.failed += 1;
        summary.results.push({ orderId: key, customerName: order.customerName, ok: false, transient: true, error: r.error });
        summary.stopped = 'Zalo chưa đăng nhập';
        console.warn(`[${logTag}:${trigger}] dừng giữa chừng — Zalo chưa đăng nhập: ${r.error}`);
        break;
      } else if (runnerDown) {
        // Runner sập / mạng tới runner đứt giữa chừng: không trừ lượt, dừng luôn để thử lại sau.
        summary.failed += 1;
        summary.results.push({ orderId: key, customerName: order.customerName, ok: false, transient: true, error: r.error });
        summary.stopped = 'local-runner offline giữa chừng';
        console.warn(`[${logTag}:${trigger}] dừng giữa chừng — runner offline: ${r.error}`);
        break;
      } else {
        // Lỗi cấp-đơn (runner vẫn sống): tính 1 lượt thử, ĐI TIẾP đơn khác. Hết maxRetries thì thôi.
        recordAutoNotified(key, 'failed', (prev ? prev.attempts : 0) + 1);
        summary.failed += 1;
      }
      summary.results.push({
        orderId: key,
        customerName: order.customerName,
        ok: r.ok,
        error: r.error || r.updateError || null,
      });
      // Nghỉ NGẪU NHIÊN trước khi sang khách kế (chỉ GIỮA các đơn) để tránh gửi dồn quá nhanh.
      if (i + 1 < ordered.length) {
        // eslint-disable-next-line no-await-in-loop
        await delayBetweenCustomers();
      }
    }

    // Log tổng kết. Với báo ship, phần lớn đơn "notified_arrival" chưa có ND ship -> KHÔNG log khi
    // chỉ toàn thiếu ND (tránh spam console mỗi lượt); chỉ log khi thật sự có đơn để gửi hoặc (báo
    // hàng) có tồn đọng đáng lưu ý.
    const worthLog = toSend.length || (kind === 'hang' && (summary.skippedNoContent || summary.skippedBacklog));
    if (worthLog) {
      const noun = kind === 'ship' ? 'đơn chờ báo ship' : 'đơn chưa báo';
      const skipNo = summary.skippedNoContent ? `, bỏ qua ${summary.skippedNoContent} đơn trống ND` : '';
      const skipDelay = summary.skippedDelayed ? `, bỏ qua ${summary.skippedDelayed} đơn đã Delay` : '';
      const skipOff = summary.skippedAutoOff ? `, bỏ qua ${summary.skippedAutoOff} đơn (account tắt auto)` : '';
      const skipNoAcc = summary.skippedNoAccount ? `, bỏ qua ${summary.skippedNoAccount} đơn (không khớp account)` : '';
      const skipBrand = summary.skippedBrand ? `, bỏ qua ${summary.skippedBrand} đơn (NV chưa có Zalo cho brand)` : '';
      const skipBack = summary.skippedBacklog ? `, bỏ qua ${summary.skippedBacklog} đơn tồn đọng (về trước khi bật auto)` : '';
      console.log(`[${logTag}:${trigger}] gửi ${summary.sent} ✅ / ${summary.failed} ❌ (quét ${summary.scanned} ${noun}${skipNo}${skipDelay}${skipOff}${skipNoAcc}${skipBrand}${skipBack})`);
    }
  });
}

async function runAutoNotify(opts = {}) {
  const trigger = opts.trigger || 'manual';
  // TẠM DỪNG SAU KHỞI ĐỘNG: chặn mọi lượt gửi TỰ ĐỘNG (interval/scheduled/webhook) — kể cả "gửi
  // bù" đợt đang dở — cho tới khi admin CHỦ ĐỘNG bấm "Quét & gửi" (trigger 'manual'). Cú bấm đó
  // vừa chạy lượt này vừa GỠ tạm dừng để auto tiếp tục bình thường. Tắt chờ bằng AUTO_NOTIFY_RESUME_ON_BOOT=true.
  if (state.awaitingResume) {
    if (trigger !== 'manual') {
      return { trigger, skipped: true, paused: true, reason: 'Tạm dừng sau khi khởi động lại — chờ admin bấm "Quét & gửi" để tiếp tục.' };
    }
    state.awaitingResume = false;
    if (!timer) startTimer();
    console.log('[auto-notify] admin bấm "Quét & gửi" — gỡ tạm dừng sau khởi động, auto chạy lại bình thường.');
  }
  // Chế độ HẸN GIỜ: "có hàng về" (webhook) chỉ để cập nhật — KHÔNG gửi ngay. Cả ngày gom lại,
  // đúng giờ (trigger 'scheduled') mới gửi. Nút "Quét & gửi ngay" (trigger 'manual') vẫn gửi
  // được ngay vì đó là hành động chủ đích của admin.
  if (trigger === 'webhook' && state.scheduleTime) {
    return {
      trigger, skipped: true, deferred: true, scheduleTime: state.scheduleTime,
      reason: `Đã hẹn giờ gửi lúc ${state.scheduleTime} (${cfg.timezone}) — không gửi ngay khi có hàng về`,
    };
  }
  if (state.running) {
    return { trigger, skipped: true, reason: 'Đang chạy một lượt khác' };
  }
  state.running = true;
  const summary = { trigger, scanned: 0, candidates: 0, sent: 0, failed: 0, results: [] };
  try {
    await executeNotifyPass({
      trigger, kind: 'hang', statusFilter: 'not_sent',
      classify: classifyForAuto, keyOf: autoKey, logTag: 'auto-notify', summary,
    });
  } catch (err) {
    summary.error = err.message;
    console.error(`[auto-notify:${trigger}] lỗi:`, err.message);
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
    state.lastResult = summary;
  }
  return summary;
}

/**
 * CHẨN ĐOÁN (read-only): với TỪNG đơn "Đã báo hàng" (notified_arrival), chạy classifyForShip và
 * trả lý do CỤ THỂ vì sao gửi/bỏ qua báo ship — để soi "vì sao khách X không được tự gửi". Không
 * gửi gì, không cần runner. Kèm trạng thái công tắc/seed + tổng hợp theo lý do.
 */
async function debugShip() {
  const runnerOnline = await checkLocalHealth().catch(() => false);
  // Quét "Chưa báo" + "Đã báo hàng" (all-time) + "Đã báo ship" (N ngày gần đây) — khớp đúng phạm vi
  // luồng gửi ship thật (khử trùng theo autoKey) để soi được cả ca "đã báo ship tay mà Mi chưa gửi".
  const orders = [];
  const seen = new Set();
  const debugStatuses = ['not_sent', 'notified_arrival'];
  if (cfg.shipRecentDays > 0) debugStatuses.push('notified_ship');
  for (const st of debugStatuses) {
    // eslint-disable-next-line no-await-in-loop
    const part = await fetchAllByStatus(st, { fresh: true, days: st === 'notified_ship' ? cfg.shipRecentDays : undefined });
    for (const o of part) { const k = autoKey(o); if (!seen.has(k)) { seen.add(k); orders.push(o); } }
  }
  const delayedMap = getDelayedMap();
  const rows = [];
  for (const order of orders) {
    // eslint-disable-next-line no-await-in-loop
    const c = await classifyForShip(order, delayedMap);
    const rec = getAutoRecord(autoKeyShip(order));
    const acct = c.acct || {};
    rows.push({
      customerName: order.customerName || '',
      phone: order.phone || '',
      statusCode: order.statusCode,
      hasShipContent: !!(order.noiDungBaoShip && String(order.noiDungBaoShip).trim()),
      shipMark: rec ? rec.status : null, // 'seeded' | 'success' | 'manual' | 'failed' | null
      decision: c.decision,              // 'send' | 'skip'
      reason: c.reason || null,          // no_content | already | delayed | no_account | auto_off | brand | backlog
      // Chi tiết chọn account -> soi vì sao brand/Danh bạ không gửi:
      account: acct.account || acct.profile || null,
      channel: acct.channel || null,       // 'zalo' | 'facebook' (Danh bạ có link FB -> facebook)
      source: acct.source || null,         // 'store' | 'store-fb' | 'default' | 'legacy'
      autoEnabled: acct.autoEnabled,       // false = account đang TẮT "Tự động"
      orderBrand: acct.orderBrand || null, // brand đọc từ mã đơn (BS/SU…)
      acctSkip: acct.skipReason || null,   // 'brand' (NV chưa có Zalo cho brand) | 'fb_no_account'
    });
  }
  const byReason = {};
  for (const r of rows) {
    const k = r.decision === 'send' ? 'WILL_SEND' : (r.reason || 'skip');
    byReason[k] = (byReason[k] || 0) + 1;
  }
  return {
    shipEnabled: state.shipEnabled,
    shipSeeding: state.shipSeeding,
    seededAt: safeGet(SHIP_SEEDED_KEY),
    runnerOnline,
    scanned: rows.length,
    willSend: byReason.WILL_SEND || 0,
    byReason,
    orders: rows.slice(0, 300),
  };
}

/**
 * TỰ ĐỘNG BÁO SHIP: hễ đơn có "ND báo ship" (content_ship) là tự nhắn khách NGAY và chuyển trạng
 * thái sang "Đã báo ship" (notified_ship) — KHÔNG bắt buộc "Đã báo hàng" trước (NV hay quên tick
 * trạng thái nên quét cả "Chưa báo" lẫn "Đã báo hàng"). Chỉ bỏ đơn ĐÃ báo ship. Khác báo hàng: ship
 * KHÔNG hoãn theo giờ hẹn 17:00 — có nội dung là gửi. Cờ chạy + kết quả riêng (state.runningShip /
 * lastShipResult) để không đụng lượt báo hàng.
 * @param {object} [opts] { trigger?: 'interval'|'webhook'|'manual'|'scheduled' }
 */
async function runAutoNotifyShip(opts = {}) {
  const trigger = opts.trigger || 'manual';
  // Tôn trọng công tắc RIÊNG: poller/webhook chỉ gửi khi báo ship đang BẬT. Nút "chạy tay" (manual)
  // vẫn chạy để admin test dù đang tắt.
  if (trigger !== 'manual' && !state.shipEnabled) {
    return { trigger, kind: 'ship', skipped: true, reason: 'Tự động báo ship đang TẮT' };
  }
  // CHƯA SEED xong (đang seed / seed lỗi) -> KHÔNG gửi để tránh nhắn LOẠT đơn tồn cũ có sẵn ND ship.
  // Tự thử seed lại nếu lần trước lỗi (poller tick kế sẽ chạy được khi đã chốt mốc).
  if (trigger !== 'manual' && state.shipEnabled && !safeGet(SHIP_SEEDED_KEY)) {
    if (!state.shipSeeding) startShipSeed().catch(() => {});
    return { trigger, kind: 'ship', skipped: true, reason: state.shipSeeding ? 'Đang seed đơn tồn cũ' : 'Chờ seed đơn tồn cũ' };
  }
  if (state.runningShip) {
    return { trigger, kind: 'ship', skipped: true, reason: 'Đang chạy một lượt báo ship khác' };
  }
  state.runningShip = true;
  const summary = { trigger, kind: 'ship', scanned: 0, candidates: 0, sent: 0, failed: 0, results: [] };
  try {
    // Quét "Chưa báo" + "Đã báo hàng" (all-time, tập sống nhỏ) -> bắt đơn có ND ship dù NV quên tick.
    // + "Đã báo ship" GIỚI HẠN N ngày gần đây (cfg.shipRecentDays) -> bắt ca "NV tick 'Đã báo ship'
    // tay nhưng Mi chưa gửi, ND ship hiện sau" (Hải Hà) mà không kéo cả kho notified_ship tích lũy.
    // shipRecentDays=0 -> bỏ notified_ship (chỉ 2 trạng thái đầu như trước). Chống trùng bằng dấu.
    const statusFilter = ['not_sent', 'notified_arrival'];
    if (cfg.shipRecentDays > 0) statusFilter.push({ status: 'notified_ship', days: cfg.shipRecentDays });
    await executeNotifyPass({
      trigger, kind: 'ship', statusFilter,
      classify: classifyForShip, keyOf: autoKeyShip, logTag: 'auto-ship', summary,
    });
  } catch (err) {
    summary.error = err.message;
    console.error(`[auto-ship:${trigger}] lỗi:`, err.message);
  } finally {
    state.runningShip = false;
    state.lastShipRun = new Date().toISOString();
    state.lastShipResult = summary;
  }
  return summary;
}

/** Có ít nhất 1 luồng (báo hàng HOẶC báo ship) đang bật -> cần chạy timer nền. */
function anyEnabled() { return state.enabled || state.shipEnabled; }

/**
 * Đồng bộ timer với trạng thái bật/tắt. 2 timer ĐỘC LẬP:
 *   - timer BÁO HÀNG: chạy khi báo hàng bật (hẹn giờ/interval).
 *   - shipTimer BÁO SHIP: chạy khi báo ship bật (cadence nhanh riêng).
 */
function syncTimer() {
  if (state.enabled) { if (!timer) startTimer(); }
  else stopTimer();
  if (state.shipEnabled) { if (!shipTimer) startShipTimer(); }
  else stopShipTimer();
}

/** Timer RIÊNG cho báo ship — quét nhanh hơn báo hàng (cfg.shipIntervalMs), đọc tươi mỗi lượt. */
function startShipTimer() {
  if (shipTimer) return;
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  setTimeout(() => maybeRunShip(), 5000);
  shipTimer = setInterval(() => maybeRunShip(), cfg.shipIntervalMs);
  if (shipTimer.unref) shipTimer.unref();
}

function stopShipTimer() {
  if (shipTimer) { clearInterval(shipTimer); shipTimer = null; }
}

/** Bật/tắt tự động BÁO HÀNG lúc runtime (không cần restart). */
function setEnabled(enabled) {
  const on = !!enabled;
  if (on === state.enabled) return getStatus();
  state.enabled = on;
  // Admin bật auto = hành động chủ động -> gỡ tạm dừng sau khởi động (nếu đang chờ).
  if (on) state.awaitingResume = false;
  syncTimer();
  console.log(`[auto-notify] báo hàng ${on ? 'BẬT' : 'TẮT'} (mỗi ${Math.round(cfg.intervalMs / 1000)}s)`);
  return getStatus();
}

/**
 * Bật/tắt tự động BÁO SHIP lúc runtime (độc lập báo hàng). Lưu bền vào DB, áp dụng ngay.
 * Khi BẬT: chốt mốc mới + chạy SEED nền (đánh dấu đơn đang có sẵn ND ship là tồn cũ, không gửi) ->
 * chỉ ND ship phát sinh SAU khi bật mới được gửi. Xoá mốc seed cũ để buộc seed lại cho lần bật này.
 */
function setShipEnabled(enabled) {
  const on = !!enabled;
  state.shipEnabled = on;
  try { setSetting(SHIP_ENABLED_KEY, on ? 'true' : 'false'); } catch (err) {
    console.warn('[auto-notify] không lưu được công tắc báo ship vào DB:', err.message);
  }
  if (on) {
    // Admin bật báo ship = hành động chủ động -> gỡ tạm dừng sau khởi động (nếu đang chờ).
    state.awaitingResume = false;
    // Mỗi lần BẬT = chốt "ảnh chụp tồn cũ" MỚI: xoá mốc cũ rồi seed lại (chặn gửi cho tới khi seed
    // xong nhờ gate trong runAutoNotifyShip). Đơn có sẵn ND ship lúc này -> đánh dấu 'seeded' (bỏ).
    try { setSetting(SHIP_SEEDED_KEY, null); } catch (_) { /* ignore */ }
    startShipSeed().catch(() => {});
  }
  syncTimer();
  console.log(`[auto-notify] báo ship ${on ? 'BẬT (đang seed ảnh chụp tồn cũ…)' : 'TẮT'}`);
  return getStatus();
}

function startTimer() {
  if (timer) return;
  state.startedAt = new Date().toISOString();
  if (state.scheduleTime) {
    // HẸN GIỜ (báo hàng): chỉ kiểm tra đồng hồ định kỳ (rẻ), tới giờ mới quét & gửi 1 lượt/ngày.
    // Báo ship vẫn được quét mỗi nhịp (trong scheduleTick). Kiểm tra sớm sau 5s để "gửi bù".
    setTimeout(scheduleTick, 5000);
    timer = setInterval(scheduleTick, cfg.scheduleCheckMs);
  } else {
    // GỬI NGAY (không hẹn giờ): chạy 1 nhịp sau 5s rồi lặp theo interval. Mỗi nhịp gồm báo hàng
    // (nếu bật) + báo ship (nếu bật) — withLock tự xếp hàng nên không đụng nhau.
    setTimeout(intervalTick, 5000);
    timer = setInterval(intervalTick, cfg.intervalMs);
  }
  if (timer.unref) timer.unref();
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  if (!shipTimer) state.startedAt = null;
}

/** Khởi động cùng server (nếu báo hàng HOẶC báo ship được bật). */
function startAutoNotify() {
  if (!anyEnabled()) {
    console.log('[auto-notify] TẮT (đặt AUTO_NOTIFY=true / AUTO_NOTIFY_SHIP=true để bật, hoặc bật trên dashboard)');
    return;
  }
  syncTimer(); // dựng timer báo hàng (nếu bật) + timer báo ship RIÊNG (nếu bật)
  if (state.enabled) {
    // Sau RESTART: mặc định TẠM DỪNG gửi tự động BÁO HÀNG (gồm "gửi bù" đợt đang dở) tới khi admin
    // bấm "Quét & gửi" hoặc bật lại auto. Timer VẪN chạy để gỡ tạm dừng sau;
    // runAutoNotify tự bỏ mọi lượt tự động khi awaitingResume=true. AUTO_NOTIFY_RESUME_ON_BOOT=true để chạy lại ngay.
    if (!cfg.resumeOnBoot) {
      state.awaitingResume = true;
      console.log('[auto-notify] BÁO HÀNG BẬT — nhưng TẠM DỪNG sau khởi động lại: KHÔNG tự gửi bù. Bấm "Quét & gửi" trên dashboard (hoặc đặt AUTO_NOTIFY_RESUME_ON_BOOT=true) để tiếp tục.');
    } else if (state.scheduleTime) {
      const pc = state.precheckMinutes > 0 ? `, nhắc soạn ND trước ${state.precheckMinutes} phút` : '';
      console.log(`[auto-notify] BÁO HÀNG BẬT — HẸN GIỜ gửi lúc ${state.scheduleTime} (${cfg.timezone}) mỗi ngày${pc}, profile=${cfg.profile}`);
    } else {
      console.log(`[auto-notify] BÁO HÀNG BẬT — GỬI NGAY, quét đơn "Chưa báo" mỗi ${Math.round(cfg.intervalMs / 1000)}s, profile=${cfg.profile}`);
    }
  } else {
    console.log('[auto-notify] báo hàng TẮT');
  }
  console.log(`[auto-notify] BÁO SHIP ${state.shipEnabled ? 'BẬT' : 'TẮT'}${state.shipEnabled ? ` — quét đơn "Đã báo hàng" có ND ship mỗi ${Math.round(cfg.shipIntervalMs / 1000)}s, gửi ngay` : ''}`);
  // Seed lần đầu nếu bật ship (qua env) mà CHƯA từng seed -> tránh nhắn loạt đơn tồn cũ lần đầu bật.
  // Đã seed rồi (khởi động lại) thì KHÔNG seed lại: ND ship phát sinh lúc server tắt vẫn là "mới" -> gửi.
  if (state.shipEnabled && !safeGet(SHIP_SEEDED_KEY)) {
    console.log('[auto-ship] chưa có mốc seed -> chạy seed lần đầu (chốt ảnh chụp tồn cũ).');
    startShipSeed().catch(() => {});
  }
}

/**
 * Đặt GIỜ GỬI CỐ ĐỊNH lúc runtime (admin đổi trên trang Cài đặt). Lưu bền vào DB để giữ qua
 * restart. '' hoặc trống -> tắt hẹn giờ (quay lại gửi ngay theo interval). Ném lỗi .code='BAD_TIME'
 * nếu sai định dạng. Áp dụng NGAY: khởi động lại timer theo chế độ mới.
 */
function setScheduleTime(value) {
  const norm = normalizeTime(value);
  if (norm === null) {
    const e = new Error('Giờ không hợp lệ — cần định dạng HH:MM (00:00–23:59), vd 17:00. Để trống = gửi ngay.');
    e.code = 'BAD_TIME';
    throw e;
  }
  state.scheduleTime = norm;
  try { setSetting(SCHEDULE_SETTING_KEY, norm); } catch (err) {
    console.warn('[auto-notify] không lưu được giờ gửi vào DB:', err.message);
  }
  // Đổi giờ -> reset mốc "đã chạy hôm nay" (nếu đổi sang giờ đã qua & hôm nay chưa gửi, lượt kế
  // sẽ nổ; nếu hôm nay đã gửi rồi thì scheduleTick vẫn chặn theo lastScheduledDay lần kế đặt lại).
  // Thực tế: chỉ reset khi chuyển giờ để không kẹt trạng thái cũ.
  state.lastScheduledDay = null;
  // Áp dụng ngay: dựng lại timer theo chế độ mới (hẹn giờ <-> interval).
  if (state.enabled && timer) { stopTimer(); startTimer(); } // chỉ dựng lại timer BÁO HÀNG (ship có timer riêng)
  console.log(`[auto-notify] đặt giờ gửi cố định = ${norm || '(trống → gửi ngay theo interval)'}`);
  return getStatus();
}

/**
 * Đặt SỐ PHÚT NHẮC SOẠN ND trước giờ gửi (0 = tắt nhắc). Lưu bền vào DB. Ném lỗi .code='BAD_PRECHECK'
 * nếu không hợp lệ (cần số nguyên 0–1439). Reset mốc "đã nhắc hôm nay" để áp dụng ngay hôm nay.
 */
function setPrecheckMinutes(value) {
  const n = normalizeMinutes(value);
  if (n === null) {
    const e = new Error('Số phút nhắc trước không hợp lệ — cần số nguyên 0–1439 (0 = tắt nhắc).');
    e.code = 'BAD_PRECHECK';
    throw e;
  }
  state.precheckMinutes = n;
  try { setSetting(PRECHECK_SETTING_KEY, String(n)); } catch (err) {
    console.warn('[auto-notify] không lưu được số phút nhắc vào DB:', err.message);
  }
  state.lastPrecheckDay = null; // cho phép nhắc lại hôm nay theo mốc mới
  console.log(`[auto-notify] đặt nhắc soạn ND trước giờ gửi = ${n} phút${n === 0 ? ' (TẮT nhắc)' : ''}`);
  return getStatus();
}

/**
 * XEM TRƯỚC (không gửi): quét "Chưa báo" và đếm bao nhiêu đơn ĐÃ đủ nội dung báo hàng (sẵn sàng
 * gửi) vs CHƯA có ND (sẽ bị bỏ qua tới giờ gửi). Dùng cho nút "Kiểm tra" trên Cài đặt để người
 * phụ trách soạn nốt ND trước giờ hẹn. Đọc TƯƠI (bỏ cache) để phản ánh đúng hiện trạng.
 */
async function previewAutoNotify() {
  const online = await checkLocalHealth().catch(() => false);
  const orders = await fetchAllNotSent({ fresh: true });
  const delayedMap = getDelayedMap();
  const c = {
    willSend: 0, no_content: 0, already: 0, max_retries: 0,
    delayed: 0, no_account: 0, auto_off: 0, brand: 0, backlog: 0,
  };
  const missingList = [];
  for (const order of orders) {
    // eslint-disable-next-line no-await-in-loop
    const cls = await classifyForAuto(order, delayedMap);
    if (cls.decision === 'send') { c.willSend += 1; continue; }
    if (cls.reason && c[cls.reason] != null) c[cls.reason] += 1;
    if (cls.reason === 'no_content' && missingList.length < 100) {
      missingList.push({ customerName: order.customerName || '', orderCode: order.orderCode || order.orderId || null, staff: order.staff || '' });
    }
  }
  // "bỏ qua vì lý do KHÁC ngoài thiếu ND" (tồn cũ, tắt auto, không khớp account, brand, Delay).
  const skippedOther = c.backlog + c.auto_off + c.no_account + c.brand + c.delayed;
  return {
    scanned: orders.length,
    willSend: c.willSend,
    ready: c.willSend,               // tương thích tên cũ: "ready" = số sẽ gửi thật
    missingContent: c.no_content,
    alreadyHandled: c.already + c.max_retries,
    skippedBacklog: c.backlog,
    skippedDelayed: c.delayed,
    skippedAutoOff: c.auto_off,
    skippedNoAccount: c.no_account,
    skippedBrand: c.brand,
    skippedOther,
    missingList,
    runnerOnline: online,
    scheduleTime: state.scheduleTime,
    timezone: cfg.timezone,
  };
}

/**
 * Đặt cấu hình NHẮC RA ZALO (nội bộ). Chỉ đổi field được gửi lên. Lưu bền vào DB, áp dụng ngay.
 * @param {{enabled?:boolean, account?:string, phone?:string, name?:string}} patch
 */
function setAlertConfig(patch = {}) {
  if (patch.enabled !== undefined) {
    state.alertEnabled = !!patch.enabled;
    try { setSetting(ALERT_ENABLED_KEY, state.alertEnabled ? 'true' : 'false'); } catch (_) { /* ignore */ }
  }
  if (patch.account !== undefined) {
    state.alertAccount = String(patch.account || '').trim();
    try { setSetting(ALERT_ACCOUNT_KEY, state.alertAccount); } catch (_) { /* ignore */ }
  }
  if (patch.phone !== undefined) {
    state.alertPhone = String(patch.phone || '').trim();
    try { setSetting(ALERT_PHONE_KEY, state.alertPhone); } catch (_) { /* ignore */ }
  }
  if (patch.name !== undefined) {
    state.alertName = String(patch.name || '').trim();
    try { setSetting(ALERT_NAME_KEY, state.alertName); } catch (_) { /* ignore */ }
  }
  console.log(`[auto-notify] cấu hình nhắc Zalo: ${state.alertEnabled ? 'BẬT' : 'TẮT'} · account=${state.alertAccount || '(trống)'} · SĐT=${state.alertPhone || '(trống)'}`);
  return getStatus();
}

/**
 * GỬI THỬ 1 tin nhắc ra Zalo NGAY (nút "Gửi thử" trên Cài đặt) để kiểm tra kênh. Dùng giá trị
 * truyền lên (nếu có) hoặc cấu hình đã lưu. Không phụ thuộc trạng thái bật/tắt.
 */
async function sendAlertTest(patch = {}) {
  const account = patch.account != null ? patch.account : state.alertAccount;
  const phone = patch.phone != null ? patch.phone : state.alertPhone;
  const name = patch.name != null ? patch.name : state.alertName;
  const msg = `🔔 [mi] Tin thử — nếu bạn nhận được tin này thì kênh nhắc ra Zalo đã hoạt động. Giờ gửi cố định: ${state.scheduleTime || '(chưa đặt)'}.`;
  return dispatchAlert(msg, { account, phone, name });
}

function getStatus() {
  return {
    enabled: state.enabled,
    running: state.running,
    // true = đang tạm dừng sau khi khởi động lại, chờ admin bấm "Quét & gửi" để tiếp tục gửi tự động.
    awaitingResume: state.awaitingResume,
    intervalMs: cfg.intervalMs,
    shipIntervalMs: cfg.shipIntervalMs,
    profile: cfg.profile,
    maxRetries: cfg.maxRetries,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    // Tự động báo ship (công tắc RIÊNG, độc lập báo hàng): bật/tắt + trạng thái + kết quả gần nhất.
    shipEnabled: state.shipEnabled,
    shipSeeding: state.shipSeeding,     // đang chốt "ảnh chụp tồn cũ" lúc bật
    lastShipSeed: state.lastShipSeed,   // { at, scanned, seeded } lần seed gần nhất
    runningShip: state.runningShip,
    lastShipRun: state.lastShipRun,
    lastShipResult: state.lastShipResult,
    scheduleTime: state.scheduleTime,
    timezone: cfg.timezone,
    precheckMinutes: state.precheckMinutes,
    lastPrecheck: state.lastPrecheck,
    schedule: scheduleInfo(),
    // Nhắc ra Zalo (nội bộ)
    alertEnabled: state.alertEnabled,
    alertAccount: state.alertAccount,
    alertPhone: state.alertPhone,
    alertName: state.alertName,
    lastAlert: state.lastAlert,
  };
}

module.exports = {
  runAutoNotify, runAutoNotifyShip, debugShip, startAutoNotify, setEnabled, setShipEnabled, setScheduleTime, setPrecheckMinutes,
  setAlertConfig, sendAlertTest, previewAutoNotify, getStatus, autoKey,
};
