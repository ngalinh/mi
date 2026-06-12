'use strict';
const config = require('./config');
const { getOrders } = require('./bassoApi');
const { notifyOne } = require('./notifyService');
const { getAutoRecord, recordAutoNotified } = require('./db');

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
 * Chống gửi trùng: bảng `auto_notified` (SQLite). Gửi thành công 1 lần là khóa lại;
 * gửi lỗi thì tăng attempts, quá `maxRetries` thì bỏ qua (tránh spam khi local-runner offline).
 */

const cfg = config.autoNotify;

// Trạng thái runtime (dùng cho /api/auto-notify + dashboard)
const state = {
  enabled: cfg.enabled,
  running: false,
  lastRun: null,       // ISO time của lần chạy gần nhất
  lastResult: null,    // tóm tắt lần chạy gần nhất
  startedAt: null,
};

let timer = null;

/** Đơn có đủ điều kiện tự gửi không? */
function isCandidate(order) {
  if (order.statusCode !== 'not_sent') return false; // chỉ "Chưa báo"
  if (order.hasZalo === false) return false;          // khách chưa có Zalo -> bỏ qua
  const rec = getAutoRecord(order.id);
  if (!rec) return true;
  if (rec.status === 'success') return false;         // đã tự gửi thành công rồi
  return rec.attempts < cfg.maxRetries;               // còn lượt thử lại
}

/**
 * Quét đơn "Chưa báo" và tự gửi. An toàn khi gọi song song (có khóa `running`).
 * @param {object} [opts] { trigger?: 'interval'|'webhook'|'manual' }
 * @returns {Promise<object>} tóm tắt { trigger, scanned, candidates, sent, failed, skipped, results }
 */
async function runAutoNotify(opts = {}) {
  const trigger = opts.trigger || 'manual';
  if (state.running) {
    return { trigger, skipped: true, reason: 'Đang chạy một lượt khác' };
  }
  state.running = true;
  const summary = { trigger, scanned: 0, candidates: 0, sent: 0, failed: 0, results: [] };
  try {
    // Chỉ lấy đơn "Chưa báo" cho nhẹ (API hỗ trợ filter status).
    const { orders } = await getOrders({ status: 'not_sent' });
    summary.scanned = orders.length;
    const candidates = orders.filter(isCandidate);
    summary.candidates = candidates.length;

    for (const order of candidates) {
      const prev = getAutoRecord(order.id);
      const attempts = (prev ? prev.attempts : 0) + 1;
      // eslint-disable-next-line no-await-in-loop
      const r = await notifyOne(order, {
        profile: cfg.profile,
        account: cfg.account,
        kind: 'hang',
      });
      const status = r.ok ? 'success' : 'failed';
      recordAutoNotified(order.id, status, attempts);
      if (r.ok) summary.sent += 1; else summary.failed += 1;
      summary.results.push({
        orderId: order.id,
        customerName: order.customerName,
        ok: r.ok,
        attempts,
        error: r.error || r.updateError || null,
      });
    }

    if (candidates.length) {
      console.log(`[auto-notify:${trigger}] gửi ${summary.sent} ✅ / ${summary.failed} ❌ (quét ${summary.scanned} đơn chưa báo)`);
    }
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
  // Chạy 1 lượt sau 5s (để local-runner kịp online), rồi lặp theo interval.
  setTimeout(() => { runAutoNotify({ trigger: 'interval' }); }, 5000);
  timer = setInterval(() => { runAutoNotify({ trigger: 'interval' }); }, cfg.intervalMs);
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
    console.log(`[auto-notify] BẬT — quét đơn "Chưa báo" mỗi ${Math.round(cfg.intervalMs / 1000)}s, profile=${cfg.profile}`);
  } else {
    console.log('[auto-notify] TẮT (đặt AUTO_NOTIFY=true để bật, hoặc bật trên dashboard)');
  }
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
  };
}

module.exports = { runAutoNotify, startAutoNotify, setEnabled, getStatus };
