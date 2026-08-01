'use strict';
/**
 * Pha 2 — Tự động báo ship từ "Quản lý giao hàng" (xem docs/shipping-notify-plan.md).
 *
 * ĐỘC LẬP HOÀN TOÀN với autoNotify.js (luồng CŨ dựa vào content_ship của Hàng về VN):
 * công tắc riêng (mặc định TẮT), bảng dedup riêng (shipping_notified/shipping_auto_seen),
 * timer riêng. Chỉ tái dùng: hạ tầng gửi (shippingSendService), mutex gửi (lock.js) và kênh
 * "nhắc ra Zalo nội bộ" đã cấu hình sẵn (autoNotify.dispatchAlert) để admin không phải cấu
 * hình 2 lần.
 *
 * 2 cơ chế:
 *   1) Poller (interval cfg.shippingAuto.intervalMs) — quét vận đơn gần đây (lookbackDays),
 *      gửi ngay khi AhaMove/Grab có shipper_link, hoặc Viettel/GHTK đã "Giao shipper". Đây là
 *      trigger DUY NHẤT đang hoạt động: Viettel/GHTK BẮT BUỘC NV bấm "Giao shipper" mới gửi.
 *   2) Lưới an toàn 17:00 (đơn "Đã soạn hàng" trong ngày quên bấm "Giao shipper" vẫn được báo) —
 *      code còn nguyên (runSafetyNet, route /api/shipping-auto/run-safety) nhưng trigger TỰ ĐỘNG
 *      theo giờ ĐANG TẮT (quyết định sản phẩm — xem startShippingAutoNotify()) để Viettel/GHTK
 *      không có ngoại lệ nào gửi trước khi tick "Giao shipper".
 */
const config = require('./config');
const shippingApi = require('./shippingApi');
const { CARRIERS } = require('./shippingNotify');
const shippingSendService = require('./shippingSendService');
const { delayBetweenCustomers } = require('./notifyService');
const { checkLocalHealth } = require('./playwrightProxy');
const { withLock } = require('./lock');
const {
  getSetting, setSetting, getShippingNotified, isShippingAutoSeen, markShippingAutoSeen,
} = require('./db');

const cfg = config.shippingAuto;

const ENABLED_KEY = 'shippingAuto2.enabled';
const SEEDED_KEY = 'shippingAuto2.seededAt';
const SEED_INFO_KEY = 'shippingAuto2.seedInfo';

/** Đọc 1 thiết lập, nuốt lỗi -> null. */
function safeGet(key) {
  try { return getSetting(key); } catch (_) { return null; }
}

function initialEnabled() {
  const saved = safeGet(ENABLED_KEY);
  if (saved != null) return saved === 'true';
  return !!cfg.enabled;
}

function initialSeed() {
  const raw = safeGet(SEED_INFO_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

const state = {
  enabled: initialEnabled(),
  seeding: false,
  lastSeed: initialSeed(),
  running: false,
  lastRun: null,
  lastResult: null,
  runningSafety: false,
  lastSafetyRun: null,
  lastSafetyResult: null,
  lastSafetyDay: null,
};

let timer = null;
let safetyTimer = null;

/** 'YYYY-MM-DD' theo múi giờ đã cấu hình (dùng chung timezone với báo hàng). */
function ymd(date) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.autoNotify.timezone }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

/** 'YYYY-MM-DD' + số phút trong ngày theo múi giờ đã cấu hình, cho 1 mốc thời gian bất kỳ. */
function localParts(date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.autoNotify.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  } catch (_) {
    return { day: date.toISOString().slice(0, 10), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

/** Quy 1 mốc unix giây/ms về 'YYYY-MM-DD' theo múi giờ đã cấu hình. null nếu không parse được. */
function localDayKey(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return localParts(new Date(ms)).day;
}

/** Giờ hẹn dùng cho lưới an toàn — tái dùng CHUNG setting với báo hàng (autoNotify.scheduleTime). */
function readScheduleTime() {
  const saved = safeGet('autoNotify.scheduleTime');
  const raw = (saved != null && saved !== '') ? saved : (config.autoNotify.scheduleTime || '');
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * Lấy vận đơn TẠO trong `days` ngày gần đây (mọi trạng thái), qua hết các trang. Cửa sổ ngày
 * để không kéo cả lịch sử mỗi lượt quét — vận đơn tồn quá lâu mới "Giao shipper" (hiếm) sẽ được
 * lưới an toàn 17:00 (quét theo ngày SOẠN HÀNG) hoặc gửi tay bắt kịp.
 */
async function fetchRecentOrders(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const filterDate = ymd(start);
  const filterDateEnd = ymd(end);
  const all = [];
  const seen = new Set();
  const MAX_PAGES = 50;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const data = await shippingApi.getShippingOrders({ page, status: 'all', filterDate, filterDateEnd });
    const orders = data.orders || [];
    for (const o of orders) {
      if (o && o.id != null && !seen.has(o.id)) { seen.add(o.id); all.push(o); }
    }
    const pageSize = data.pageSize || orders.length || 20;
    if (orders.length < pageSize) return all;
    if (data.total != null && all.length >= data.total) return all;
    if (page === MAX_PAGES) {
      console.warn(`[auto-ship2] ⚠️ CHẠM TRẦN ${MAX_PAGES} trang (${all.length} vận đơn) — có thể còn vận đơn chưa quét.`);
    }
  }
  return all;
}

/**
 * Điều kiện TRIGGER (theo docs/shipping-notify-plan.md), KHÔNG kiểm tra lại nội dung/mã —
 * shippingSendService.sendShippingOne tự gọi buildDeliveryMessage và sẽ báo lỗi cụ thể nếu
 * thiếu (no_code/no_link) dù classify() đã cho 'send'.
 * @returns {{decision:'send'|'skip', reason?:string}}
 */
function classify(order) {
  const reg = CARRIERS[Number(order.shippingId)];
  if (!reg) return { decision: 'skip', reason: 'unregistered' };
  if (reg.type === 'none') return { decision: 'skip', reason: 'no_notify' };
  if (reg.type === 'link') {
    return order.shipperLink ? { decision: 'send' } : { decision: 'skip', reason: 'no_link_yet' };
  }
  // tracking (GHTK/Viettel...): trigger = đã bấm "Giao shipper" trở đi.
  const handedOver = order.statusCode === 'exported' || order.statusCode === 'completed';
  return handedOver ? { decision: 'send' } : { decision: 'skip', reason: 'not_exported_yet' };
}

/**
 * SEED lúc bật: đánh dấu MỌI vận đơn đang ĐỦ ĐIỀU KIỆN gửi tại thời điểm bật là "tồn cũ"
 * (shipping_auto_seen) -> KHÔNG tự gửi. Chỉ vận đơn MỚI đủ điều kiện SAU lúc bật mới được gửi.
 * KHÔNG đụng `shipping_notified` (đó là "đã THẬT SỰ gửi", dùng chung với Pha 1 gửi tay).
 */
async function seed() {
  let scanned = 0;
  let seeded = 0;
  const orders = await fetchRecentOrders(cfg.lookbackDays);
  for (const order of orders) {
    if (order.id == null) continue;
    scanned += 1;
    if (getShippingNotified(order.id)) continue;
    if (isShippingAutoSeen(order.id)) continue;
    const c = classify(order);
    if (c.decision === 'send') { markShippingAutoSeen(order.id); seeded += 1; }
  }
  const at = new Date().toISOString();
  state.lastSeed = { at, scanned, seeded };
  try { setSetting(SEEDED_KEY, at); } catch (_) { /* ignore */ }
  try { setSetting(SEED_INFO_KEY, JSON.stringify(state.lastSeed)); } catch (_) { /* ignore */ }
  console.log(`[auto-ship2] SEED lúc bật: đánh dấu ${seeded} vận đơn tồn cũ đủ điều kiện trong ${scanned} vận đơn quét — sẽ KHÔNG tự gửi; chỉ vận đơn MỚI đủ điều kiện SAU lúc bật mới được gửi.`);
  return { at, scanned, seeded };
}

async function startSeed() {
  if (state.seeding) return;
  state.seeding = true;
  try {
    await seed();
  } catch (e) {
    console.warn('[auto-ship2] SEED lỗi (sẽ thử lại):', e.message);
  } finally {
    state.seeding = false;
  }
}

/** Quét & gửi 1 lượt (poller/manual). An toàn khi gọi song song (khoá `running`). */
async function runShippingAuto(opts = {}) {
  const trigger = opts.trigger || 'manual';
  if (trigger !== 'manual' && !state.enabled) {
    return { trigger, skipped: true, reason: 'Tự động báo ship (Quản lý giao hàng) đang TẮT' };
  }
  if (trigger !== 'manual' && !safeGet(SEEDED_KEY)) {
    if (!state.seeding) startSeed().catch(() => {});
    return { trigger, skipped: true, reason: state.seeding ? 'Đang seed vận đơn tồn cũ' : 'Chờ seed vận đơn tồn cũ' };
  }
  if (state.running) return { trigger, skipped: true, reason: 'Đang chạy một lượt khác' };
  state.running = true;
  const summary = { trigger, scanned: 0, candidates: 0, sent: 0, failed: 0, byReason: {}, results: [] };
  try {
    await withLock(async () => {
      const online = await checkLocalHealth();
      if (!online) {
        summary.skipped = true;
        summary.reason = 'local-runner offline';
        console.warn(`[auto-ship2:${trigger}] bỏ lượt — local-runner offline.`);
        return;
      }
      const orders = await fetchRecentOrders(cfg.lookbackDays);
      summary.scanned = orders.length;
      const eligible = [];
      for (const order of orders) {
        if (order.id == null) continue;
        if (getShippingNotified(order.id)) continue;
        if (isShippingAutoSeen(order.id)) continue;
        const c = classify(order);
        if (c.decision !== 'send') {
          summary.byReason[c.reason] = (summary.byReason[c.reason] || 0) + 1;
          continue;
        }
        eligible.push(order);
      }
      summary.candidates = eligible.length;
      for (let i = 0; i < eligible.length; i += 1) {
        const order = eligible[i];
        // eslint-disable-next-line no-await-in-loop
        const r = await shippingSendService.sendShippingOne(order, { actor: 'auto-ship2' });
        summary.results.push({ id: order.id, ok: r.ok, error: r.error || null });
        if (r.ok) summary.sent += 1; else summary.failed += 1;
        if (i + 1 < eligible.length) {
          // eslint-disable-next-line no-await-in-loop
          await delayBetweenCustomers();
        }
      }
    });
  } catch (err) {
    summary.error = err.message;
    console.error(`[auto-ship2:${trigger}] lỗi:`, err.message);
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
    state.lastResult = summary;
  }
  return summary;
}

/**
 * LƯỚI AN TOÀN 17:00 — bắt ca NV soạn xong hàng nhưng quên bấm "Giao shipper". Quét vận đơn
 * "Đã soạn hàng" (isPrepared, chưa exported/completed) SOẠN TRONG NGÀY, chưa báo ship:
 *   - Viettel/GHTK (có mã vận đơn): gửi tin + đánh dấu notified_ship — KHÔNG đổi status vận đơn
 *     (tránh làm NV kho tưởng đã bàn giao).
 *   - AhaMove/Grab chưa có shipper_link: KHÔNG gửi, chỉ cảnh báo NV (chưa đặt shipper).
 *   - ĐVVC chưa khai mẫu (unregistered): KHÔNG gửi, chỉ cảnh báo NV.
 */
async function runSafetyNet(day) {
  if (!day) day = localParts(new Date()).day;
  if (!state.enabled) return { skipped: true, reason: 'TẮT' };
  if (state.runningSafety) return { skipped: true, reason: 'Đang chạy lượt an toàn khác' };
  state.runningSafety = true;
  const summary = { day, scanned: 0, sent: 0, failed: 0, alerted: 0, results: [] };
  try {
    await withLock(async () => {
      const online = await checkLocalHealth();
      if (!online) {
        summary.skipped = true;
        summary.reason = 'local-runner offline';
        return;
      }
      const orders = await fetchRecentOrders(cfg.lookbackDays);
      const preparedToday = orders.filter((o) => {
        if (!o.isPrepared) return false;
        if (o.statusCode === 'exported' || o.statusCode === 'completed') return false;
        if (getShippingNotified(o.id)) return false;
        const dayKey = o.preparedAtRaw ? localDayKey(o.preparedAtRaw) : null;
        return dayKey === day;
      });
      summary.scanned = preparedToday.length;

      const missingLink = [];
      const unregistered = [];
      const eligible = [];
      for (const order of preparedToday) {
        const reg = CARRIERS[Number(order.shippingId)];
        if (!reg) { unregistered.push(order); continue; }
        if (reg.type === 'none') continue;
        if (reg.type === 'link') {
          if (order.shipperLink) eligible.push(order); else missingLink.push(order);
          continue;
        }
        if (order.trackingCode) eligible.push(order);
      }

      for (let i = 0; i < eligible.length; i += 1) {
        const order = eligible[i];
        // eslint-disable-next-line no-await-in-loop
        const r = await shippingSendService.sendShippingOne(order, { actor: 'auto-ship2-safety' });
        summary.results.push({ id: order.id, ok: r.ok, error: r.error || null });
        if (r.ok) summary.sent += 1; else summary.failed += 1;
        if (i + 1 < eligible.length) {
          // eslint-disable-next-line no-await-in-loop
          await delayBetweenCustomers();
        }
      }

      if (missingLink.length || unregistered.length) {
        summary.alerted = missingLink.length + unregistered.length;
        const lines = ['⚠️ [mi] Lưới an toàn 17:00 — báo ship (Quản lý giao hàng)'];
        if (missingLink.length) {
          const names = missingLink.slice(0, 15).map((o) => o.recipient || o.trackingCode || `#${o.id}`).join(', ');
          lines.push(`${missingLink.length} đơn đã soạn hôm nay nhưng CHƯA đặt shipper (AhaMove/Grab): ${names}${missingLink.length > 15 ? '…' : ''}`);
        }
        if (unregistered.length) {
          const names = unregistered.slice(0, 15).map((o) => `${o.shipping || o.shippingId}(#${o.id})`).join(', ');
          lines.push(`${unregistered.length} đơn dùng ĐVVC CHƯA khai mẫu báo ship: ${names}${unregistered.length > 15 ? '…' : ''}`);
        }
        try {
          // eslint-disable-next-line global-require
          const autoNotify = require('./autoNotify');
          await autoNotify.dispatchAlert(lines.join('\n'));
        } catch (_) { /* kênh nhắc chưa cấu hình / lỗi gửi -> nuốt, không chặn lượt an toàn */ }
      }
    });
  } catch (err) {
    summary.error = err.message;
    console.error('[auto-ship2:safety] lỗi:', err.message);
  } finally {
    state.runningSafety = false;
    state.lastSafetyRun = new Date().toISOString();
    state.lastSafetyResult = summary;
  }
  return summary;
}

function maybeRun() {
  if (!state.enabled) return;
  runShippingAuto({ trigger: 'interval' }).catch(() => {});
}

function startTimer() {
  if (timer) return;
  setTimeout(maybeRun, 5000);
  timer = setInterval(maybeRun, cfg.intervalMs);
  if (timer.unref) timer.unref();
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

function syncTimer() {
  if (state.enabled) { if (!timer) startTimer(); } else stopTimer();
}

/** Tick đồng hồ (rẻ) cho lưới an toàn — dùng CHUNG giờ hẹn với báo hàng, tự thân chỉ chạy khi bật. */
function safetyTick() {
  if (!state.enabled) return;
  const st = readScheduleTime();
  if (!st) return;
  const { day, minutes } = localParts(new Date());
  const [h, m] = st.split(':').map(Number);
  const target = h * 60 + m;
  if (minutes >= target && state.lastSafetyDay !== day) {
    state.lastSafetyDay = day;
    Promise.resolve(runSafetyNet(day))
      .then((r) => { if (r && r.skipped) state.lastSafetyDay = null; })
      .catch(() => { state.lastSafetyDay = null; });
  }
}

function startSafetyTimer() {
  if (safetyTimer) return;
  setTimeout(safetyTick, 5000);
  safetyTimer = setInterval(safetyTick, cfg.safetyCheckMs);
  if (safetyTimer.unref) safetyTimer.unref();
}

/** Bật/tắt lúc runtime (không cần restart). Lưu bền DB. Bật = chốt mốc seed mới + seed nền. */
function setEnabled(enabled) {
  const on = !!enabled;
  state.enabled = on;
  try { setSetting(ENABLED_KEY, on ? 'true' : 'false'); } catch (err) {
    console.warn('[auto-ship2] không lưu được công tắc vào DB:', err.message);
  }
  if (on) {
    try { setSetting(SEEDED_KEY, null); } catch (_) { /* ignore */ }
    startSeed().catch(() => {});
  }
  syncTimer();
  console.log(`[auto-ship2] ${on ? 'BẬT (đang seed ảnh chụp tồn cũ…)' : 'TẮT'}`);
  return getStatus();
}

function getStatus() {
  return {
    enabled: state.enabled,
    intervalMs: cfg.intervalMs,
    lookbackDays: cfg.lookbackDays,
    seeding: state.seeding,
    lastSeed: state.lastSeed,
    running: state.running,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    runningSafety: state.runningSafety,
    lastSafetyRun: state.lastSafetyRun,
    lastSafetyResult: state.lastSafetyResult,
    scheduleTime: readScheduleTime(),
    timezone: config.autoNotify.timezone,
  };
}

/** Khởi động cùng server. Timer luôn dựng (kể cả khi tắt) để bật lại lúc runtime không cần restart. */
function startShippingAutoNotify() {
  syncTimer();
  // Lưới an toàn 17:00 ĐANG TẮT theo quyết định sản phẩm: Viettel Post/GHTK BẮT BUỘC phải bấm
  // "Giao shipper" mới gửi, không có ngoại lệ nào tự gửi trước khi NV tick trạng thái (kể cả đơn
  // đã soạn hàng trong ngày). Muốn bật lại: gọi startSafetyTimer() ở đây (hàm runSafetyNet() và
  // route POST /api/shipping-auto/run-safety vẫn còn nguyên, chỉ tắt trigger TỰ ĐỘNG theo giờ).
  // startSafetyTimer();
  if (state.enabled && !safeGet(SEEDED_KEY)) {
    console.log('[auto-ship2] chưa có mốc seed -> chạy seed lần đầu.');
    startSeed().catch(() => {});
  }
  console.log(`[auto-ship2] BÁO SHIP (Quản lý giao hàng) ${state.enabled ? `BẬT — quét mỗi ${Math.round(cfg.intervalMs / 1000)}s (lưới an toàn 17:00 đang TẮT)` : 'TẮT'}`);
}

module.exports = {
  startShippingAutoNotify, runShippingAuto, runSafetyNet, setEnabled, getStatus,
};
