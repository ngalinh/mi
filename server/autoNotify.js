'use strict';
const config = require('./config');
const { getOrders } = require('./bassoApi');
const { notifyOne } = require('./notifyService');
const { getAutoRecord, recordAutoNotified, autoKey } = require('./db');
const { checkLocalHealth } = require('./playwrightProxy');
const { withLock } = require('./lock');

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

// Trạng thái runtime (dùng cho /api/auto-notify + dashboard)
const state = {
  enabled: cfg.enabled,
  running: false,
  lastRun: null,       // ISO time của lần chạy gần nhất
  lastResult: null,    // tóm tắt lần chạy gần nhất
  startedAt: null,
};

let timer = null;

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

/** Đơn có đủ điều kiện tự gửi không? */
function isCandidate(order) {
  if (order.statusCode !== 'not_sent') return false; // chỉ "Chưa báo"
  // Chỉ tự gửi khi Basso ĐÃ soạn sẵn "ND báo hàng" (raw.content). Đơn trống nội
  // dung -> bỏ qua hoàn toàn, KHÔNG dùng template mặc định để tránh gửi câu chung chung.
  if (!order.noiDungBaoHang || !String(order.noiDungBaoHang).trim()) return false;
  const rec = getAutoRecord(autoKey(order));
  if (!rec) return true;
  // Đã gửi (bot 'success' hoặc đã báo tay 'manual') -> bot không gửi lại.
  if (rec.status === 'success' || rec.status === 'manual') return false;
  return rec.attempts < cfg.maxRetries;               // 'failed' -> còn lượt thử lại
}

/** Lấy TẤT CẢ đơn "Chưa báo" qua mọi trang (vì không cập nhật web nên tập này không tự co lại). */
async function fetchAllNotSent() {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { orders, total } = await getOrders({ status: 'not_sent', page, pageSize: 100 });
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
      const orders = await fetchAllNotSent();
      summary.scanned = orders.length;
      // Đơn "Chưa báo" nhưng Basso chưa soạn "ND báo hàng" -> bỏ qua (không gửi).
      summary.skippedNoContent = orders.filter(
        (o) => o.statusCode === 'not_sent' && !(o.noiDungBaoHang && String(o.noiDungBaoHang).trim()),
      ).length;
      const candidates = orders.filter(isCandidate);
      summary.candidates = candidates.length;

      for (const order of candidates) {
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
        });

        if (r.ok) {
          recordAutoNotified(key, 'success', (prev ? prev.attempts : 0) + 1);
          summary.sent += 1;
        } else if (isTransientError(r.error)) {
          // Runner vừa sập / mạng lỗi giữa chừng: không trừ lượt, dừng luôn để thử lại sau.
          summary.failed += 1;
          summary.results.push({ orderId: key, customerName: order.customerName, ok: false, transient: true, error: r.error });
          summary.stopped = 'local-runner offline giữa chừng';
          console.warn(`[auto-notify:${trigger}] dừng giữa chừng — lỗi tạm thời: ${r.error}`);
          break;
        } else {
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

      if (candidates.length || summary.skippedNoContent) {
        const skip = summary.skippedNoContent ? `, bỏ qua ${summary.skippedNoContent} đơn trống ND` : '';
        console.log(`[auto-notify:${trigger}] gửi ${summary.sent} ✅ / ${summary.failed} ❌ (quét ${summary.scanned} đơn chưa báo${skip})`);
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

module.exports = { runAutoNotify, startAutoNotify, setEnabled, getStatus, autoKey };
