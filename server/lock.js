'use strict';

/**
 * Mutex đơn giản trong-tiến-trình: nối các tác vụ thành chuỗi FIFO để CHẠY TUẦN TỰ.
 *
 * Dùng cho R6: báo-tay (notifyService.notifyMany) và báo-tự-động (autoNotify.runAutoNotify)
 * KHÔNG được chạy chồng nhau trên cùng tập đơn — nếu không, cả hai có thể cùng chọn 1 đơn
 * "Chưa báo" (trước khi đơn kịp được đánh dấu) và gửi trùng tin cho khách.
 *
 * Mỗi loại thông báo có mutex riêng: báo ship không chờ lượt/delay báo hàng.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const laneScope = require('../shared/notificationLane');
const tails = new Map();

/**
 * Chạy `fn` sau khi mọi tác vụ đã xếp hàng trước đó hoàn tất (kể cả khi chúng lỗi).
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>} kết quả của fn
 */
function withLock(fn, lane = laneScope.current()) {
  lane = laneScope.normalize(lane);
  if (scope.getStore()?.held && scope.getStore().lane === lane) return fn();
  const tail = tails.get(lane) || Promise.resolve();
  const result = tail.then(() => {
    const token = { held: true, lane };
    return laneScope.run(lane, () => scope.run(token, async () => {
      try { return await fn(); } finally { token.held = false; }
    }));
  });
  // Giữ chuỗi tiếp tục dù fn thành công hay lỗi (nuốt lỗi ở nhánh chuỗi, không ở nhánh trả về).
  tails.set(lane, result.then(() => undefined, () => undefined));
  return result;
}

module.exports = { withLock };
