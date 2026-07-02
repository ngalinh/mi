'use strict';
const config = require('./config');
const { getOrders, getTabUsers } = require('./bassoApi');

/**
 * NẠP SẴN (preload / cache-warm) DANH SÁCH HÀNG VỀ.
 *
 * Vấn đề: mỗi call Basso mất vài giây và dashboard cần ~vài call lúc mở. Cache RAM (SWR ở
 * bassoApi) làm các lần sau gần như tức thì, NHƯNG cache rỗng ở 2 thời điểm -> đúng lúc đó
 * người dùng phải ĐỢI Basso:
 *   1) ngay sau khi server khởi động / deploy lại (người mở đầu tiên gánh trọn thời gian);
 *   2) ngay sau khi sửa 1 dòng (updateArrivedVnRow -> invalidateOrdersCache xoá sạch cache).
 *
 * Module này tự "mở dashboard hộ" theo chu kỳ ở NỀN: gọi đúng "khung nhìn mặc định" mà
 * dashboard tải lúc boot (trang 1 tab "Chưa báo" + đếm 4 trạng thái + danh sách nhân viên)
 * để cache luôn ấm. Nhờ vậy người dùng mở lên là có ngay, rồi SWR tự làm mới nền.
 *
 * Bật/tắt qua BASSO_PRELOAD_INTERVAL_MS (0 = tắt). Tự tắt khi MOCK hoặc cache danh sách tắt.
 */

const state = {
  enabled: false,
  running: false,
  runs: 0,
  lastRun: null,    // ISO time lần warm gần nhất
  lastOk: null,     // boolean: lần gần nhất thành công?
  lastMs: null,     // thời gian (ms) của lần gần nhất
  lastError: null,  // message lỗi gần nhất (nếu có)
};

let timer = null;

/**
 * Warm 1 lượt: nạp đúng khung nhìn mặc định của dashboard vào cache RAM.
 * An toàn khi gọi chồng — có cờ `running` để bỏ qua lượt trùng.
 * @param {string} [trigger] nhãn nguồn gọi (startup|interval|manual) cho log
 */
async function warmOnce(trigger = 'interval') {
  if (state.running) return state;
  state.running = true;
  const t0 = Date.now();
  try {
    // Warm ĐÚNG khung server-mode mà dashboard tải lúc boot. Phải TRÙNG cache key với call
    // thật của client thì mở dashboard mới ăn cache ấm:
    //   1) Danh sách trang 1 tab "Chưa báo" trong cửa sổ ngày mặc định (days khớp DEFAULT_DAYS).
    //   2) Đếm "chưa báo" all-time (không days) — đúng call loadCounts client dùng cho nút Báo loạt.
    //   3) Danh sách nhân viên.
    // (Bỏ warm getStatusCounts 4-call — dashboard không còn thanh thẻ đếm nữa -> khỏi dội Basso.)
    const days = config.basso.defaultDays || undefined;
    await getOrders({ status: 'not_sent', page: 1, pageSize: 20, days });
    await Promise.all([
      getTabUsers(),
      getOrders({ status: 'not_sent', page: 1, pageSize: 1 }),
    ]);
    state.lastOk = true;
    state.lastError = null;
  } catch (e) {
    state.lastOk = false;
    state.lastError = e.message;
    if (config.basso.logTiming) console.warn(`[preload:${trigger}] lỗi: ${e.message}`);
  } finally {
    state.lastMs = Date.now() - t0;
    state.lastRun = new Date().toISOString();
    state.runs += 1;
    state.running = false;
  }
  if (config.basso.logTiming && state.lastOk) {
    console.log(`[preload:${trigger}] warm cache ${state.lastMs}ms`);
  }
  return state;
}

/** Khởi động cùng server: warm ngay sau vài giây rồi lặp theo chu kỳ. */
function start() {
  if (config.basso.useMock) {
    console.log('[preload] TẮT (đang ở chế độ MOCK — dữ liệu sẵn, không cần nạp trước)');
    return;
  }
  if (!config.basso.listCacheTtlMs) {
    console.log('[preload] TẮT (BASSO_LIST_CACHE_TTL_MS=0 — cache danh sách đang tắt)');
    return;
  }
  const interval = config.basso.preloadIntervalMs;
  if (!interval) {
    console.log('[preload] TẮT (đặt BASSO_PRELOAD_INTERVAL_MS>0 để bật nạp sẵn)');
    return;
  }
  state.enabled = true;
  // Warm lần đầu sau 2s (để server/đăng nhập Basso ổn định), rồi lặp định kỳ giữ cache ấm.
  setTimeout(() => { warmOnce('startup'); }, 2000);
  timer = setInterval(() => { warmOnce('interval'); }, interval);
  if (timer.unref) timer.unref(); // không giữ tiến trình sống chỉ vì timer này
  console.log(`[preload] BẬT — nạp sẵn danh sách hàng về mỗi ${Math.round(interval / 1000)}s (giữ cache ấm)`);
}

function getStatus() {
  return { ...state, intervalMs: config.basso.preloadIntervalMs };
}

module.exports = { start, warmOnce, getStatus };
