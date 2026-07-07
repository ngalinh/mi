'use strict';
const config = require('./config');
const { getOrders } = require('./bassoApi');
const { notifyOne } = require('./notifyService');
const { getAutoRecord, recordAutoNotified, autoKey, getSetting, setSetting, getDelayedMap } = require('./db');
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
  lastRun: null,       // ISO time của lần chạy gần nhất
  lastResult: null,    // tóm tắt lần chạy gần nhất
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

let timer = null;

/**
 * Tới giờ hẹn chưa? (chạy MỖI scheduleCheckMs). Chỉ gọi Basso khi ĐÃ tới giờ và CHƯA chạy hôm
 * nay -> mỗi ngày đúng 1 lượt gửi. Nếu server khởi động lại SAU giờ hẹn mà hôm đó chưa chạy,
 * lượt này vẫn nổ để "gửi bù" — an toàn vì dedup (auto_notified) chặn gửi trùng khách.
 */
function scheduleTick() {
  if (!state.scheduleTime) return;
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
 * Lấy TẤT CẢ đơn "Chưa báo" qua mọi trang (vì không cập nhật web nên tập này không tự co lại).
 * @param {object} [opts] { fresh } — fresh=true: đọc tươi từ Basso, bỏ qua cache (dùng cho webhook
 *   để thấy NGAY đơn vừa về, không bị cache 30s che). Poller thường dùng cache cho nhẹ.
 */
async function fetchAllNotSent(opts = {}) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { orders, total } = await getOrders({ status: 'not_sent', page, pageSize: 100, fresh: !!opts.fresh });
    for (const o of orders) {
      const k = autoKey(o);
      if (!seen.has(k)) { seen.add(k); all.push(o); }
    }
    if (orders.length < 100) break;                 // hết trang
    if (total != null && all.length >= total) break; // đã lấy đủ
  }
  return all;
}

/**
 * Quét đơn "Chưa báo" và tự gửi. An toàn khi gọi song song (có khóa `running`).
 * @param {object} [opts] { trigger?: 'interval'|'webhook'|'manual' }
 * @returns {Promise<object>} tóm tắt { trigger, scanned, candidates, sent, failed, skipped, results }
 */
async function runAutoNotify(opts = {}) {
  const trigger = opts.trigger || 'manual';
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
    // R4: runner offline thì bỏ cả lượt, KHÔNG trừ attempts (tránh "bỏ cuộc" oan).
    const online = await checkLocalHealth();
    if (!online) {
      summary.skipped = true;
      summary.reason = 'local-runner offline';
      console.warn(`[auto-notify:${trigger}] bỏ lượt — local-runner offline (không trừ lượt thử).`);
      return summary;
    }

    // R6: bọc quét + gửi trong khóa dùng chung -> không chạy chồng với báo-tay (notifyMany).
    // Đặt quét đơn TRONG khóa để thấy trạng thái mới nhất sau khi luồng kia vừa gửi xong.
    await withLock(async () => {
      // Đọc TƯƠI (bỏ cache) cho:
      //  - webhook "vừa có hàng về" -> thấy ngay đơn mới;
      //  - lượt gửi theo lịch (scheduled) -> lấy ND báo hàng MỚI NHẤT do Basso/NV vừa soạn phút
      //    chót, không dính cache 30s (tránh bỏ sót đơn vừa được soạn nội dung).
      // Poller định kỳ (interval) vẫn dùng cache cho nhẹ.
      const orders = await fetchAllNotSent({ fresh: trigger === 'webhook' || trigger === 'scheduled' });
      summary.scanned = orders.length;
      const delayedMap = getDelayedMap();

      // Phân loại TẤT CẢ đơn 1 lượt (dùng chung với preview) -> danh sách SẼ GỬI + đếm lý do bỏ qua.
      const toSend = [];
      for (const order of orders) {
        // eslint-disable-next-line no-await-in-loop
        const c = await classifyForAuto(order, delayedMap);
        // classifyForAuto đã resolve account -> lấy luôn profile để gom (khỏi resolve lại).
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
        const key = autoKey(order);
        const prev = getAutoRecord(key);

        // eslint-disable-next-line no-await-in-loop
        const r = await notifyOne(order, {
          profile: cfg.profile,
          defaultAccount: cfg.account,   // fallback khi NV không có trong ZALO_ACCOUNT_MAP
          kind: 'hang',
          skipWebUpdate: !cfg.updateWeb, // mặc định đẩy trạng thái về web Basso (tắt qua AUTO_NOTIFY_UPDATE_WEB=false)
          strictMatch: true,             // R5: tự động -> chỉ gửi khi khớp chắc chắn, không "lấy đại"
          actor: 'bot',                  // audit: luồng tự động
          keepContext,                   // báo loạt gom theo profile -> giữ browser cho đơn kế cùng account
        });

        // Phân loại lỗi để quyết định "dừng cả lượt" hay "tính 1 attempt rồi đi tiếp".
        // CHỈ coi là transient (dừng lượt, KHÔNG trừ lượt) khi runner THỰC SỰ offline — xác
        // nhận bằng health-check thay vì chỉ dò chữ trong message. Lỗi Playwright CẤP-ĐƠN (vd
        // mở hội thoại 1 khách bị "Timeout ... exceeded") cũng chứa chữ "timeout"; trước đây bị
        // hiểu nhầm là transient -> break bỏ dở cả lượt + đơn đó retry vô hạn (không tăng attempt).
        // eslint-disable-next-line no-await-in-loop
        const runnerDown = !r.ok && isTransientError(r.error) && !(await checkLocalHealth());
        if (r.ok) {
          recordAutoNotified(key, 'success', (prev ? prev.attempts : 0) + 1);
          summary.sent += 1;
        } else if (runnerDown) {
          // Runner sập / mạng tới runner đứt giữa chừng: không trừ lượt, dừng luôn để thử lại sau.
          summary.failed += 1;
          summary.results.push({ orderId: key, customerName: order.customerName, ok: false, transient: true, error: r.error });
          summary.stopped = 'local-runner offline giữa chừng';
          console.warn(`[auto-notify:${trigger}] dừng giữa chừng — runner offline: ${r.error}`);
          break;
        } else {
          // Lỗi cấp-đơn (runner vẫn sống, kể cả khi message có chữ "timeout"): tính 1 lượt thử,
          // ĐI TIẾP đơn khác thay vì bỏ dở cả lượt. Hết maxRetries thì thôi.
          recordAutoNotified(key, 'failed', (prev ? prev.attempts : 0) + 1);
          summary.failed += 1;
        }
        summary.results.push({
          orderId: key,
          customerName: order.customerName,
          ok: r.ok,
          error: r.error || r.updateError || null,
        });
      }

      if (toSend.length || summary.skippedNoContent || summary.skippedBacklog) {
        const skipNo = summary.skippedNoContent ? `, bỏ qua ${summary.skippedNoContent} đơn trống ND` : '';
        const skipDelay = summary.skippedDelayed ? `, bỏ qua ${summary.skippedDelayed} đơn đã Delay` : '';
        const skipOff = summary.skippedAutoOff ? `, bỏ qua ${summary.skippedAutoOff} đơn (account tắt auto)` : '';
        const skipNoAcc = summary.skippedNoAccount ? `, bỏ qua ${summary.skippedNoAccount} đơn (không khớp account)` : '';
        const skipBrand = summary.skippedBrand ? `, bỏ qua ${summary.skippedBrand} đơn (NV chưa có Zalo cho brand)` : '';
        const skipBack = summary.skippedBacklog ? `, bỏ qua ${summary.skippedBacklog} đơn tồn đọng (về trước khi bật auto)` : '';
        console.log(`[auto-notify:${trigger}] gửi ${summary.sent} ✅ / ${summary.failed} ❌ (quét ${summary.scanned} đơn chưa báo${skipNo}${skipDelay}${skipOff}${skipNoAcc}${skipBrand}${skipBack})`);
      }
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

/** Bật/tắt poller lúc runtime (không cần restart). */
function setEnabled(enabled) {
  const on = !!enabled;
  if (on === state.enabled && (!on || timer)) return getStatus();
  state.enabled = on;
  if (on) startTimer(); else stopTimer();
  console.log(`[auto-notify] ${on ? 'BẬT' : 'TẮT'} (mỗi ${Math.round(cfg.intervalMs / 1000)}s)`);
  return getStatus();
}

function startTimer() {
  if (timer) return;
  state.startedAt = new Date().toISOString();
  if (state.scheduleTime) {
    // HẸN GIỜ: chỉ kiểm tra đồng hồ định kỳ (rẻ), tới giờ mới quét & gửi 1 lượt/ngày.
    // Kiểm tra sớm sau 5s để "gửi bù" nếu khởi động lại khi đã qua giờ hẹn mà hôm đó chưa chạy.
    setTimeout(scheduleTick, 5000);
    timer = setInterval(scheduleTick, cfg.scheduleCheckMs);
  } else {
    // GỬI NGAY (không hẹn giờ): chạy 1 lượt sau 5s rồi lặp theo interval như trước.
    setTimeout(() => { runAutoNotify({ trigger: 'interval' }); }, 5000);
    timer = setInterval(() => { runAutoNotify({ trigger: 'interval' }); }, cfg.intervalMs);
  }
  if (timer.unref) timer.unref();
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  state.startedAt = null;
}

/** Khởi động cùng server (nếu AUTO_NOTIFY=true). */
function startAutoNotify() {
  if (state.enabled) {
    startTimer();
    if (state.scheduleTime) {
      const pc = state.precheckMinutes > 0 ? `, nhắc soạn ND trước ${state.precheckMinutes} phút` : '';
      console.log(`[auto-notify] BẬT — HẸN GIỜ gửi lúc ${state.scheduleTime} (${cfg.timezone}) mỗi ngày${pc}, profile=${cfg.profile}`);
    } else {
      console.log(`[auto-notify] BẬT — GỬI NGAY, quét đơn "Chưa báo" mỗi ${Math.round(cfg.intervalMs / 1000)}s, profile=${cfg.profile}`);
    }
  } else {
    console.log('[auto-notify] TẮT (đặt AUTO_NOTIFY=true để bật, hoặc bật trên dashboard)');
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
  if (state.enabled && timer) { stopTimer(); startTimer(); }
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
    intervalMs: cfg.intervalMs,
    profile: cfg.profile,
    maxRetries: cfg.maxRetries,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
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
  runAutoNotify, startAutoNotify, setEnabled, setScheduleTime, setPrecheckMinutes,
  setAlertConfig, sendAlertTest, previewAutoNotify, getStatus, autoKey,
};
