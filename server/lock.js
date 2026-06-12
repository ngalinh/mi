'use strict';

/**
 * Mutex đơn giản trong-tiến-trình: nối các tác vụ thành chuỗi FIFO để CHẠY TUẦN TỰ.
 *
 * Dùng cho R6: báo-tay (notifyService.notifyMany) và báo-tự-động (autoNotify.runAutoNotify)
 * KHÔNG được chạy chồng nhau trên cùng tập đơn — nếu không, cả hai có thể cùng chọn 1 đơn
 * "Chưa báo" (trước khi đơn kịp được đánh dấu) và gửi trùng tin cho khách.
 *
 * Cả hai luồng cùng nằm trong 1 process server nên 1 mutex bộ-nhớ là đủ.
 */
let tail = Promise.resolve();

/**
 * Chạy `fn` sau khi mọi tác vụ đã xếp hàng trước đó hoàn tất (kể cả khi chúng lỗi).
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>} kết quả của fn
 */
function withLock(fn) {
  const result = tail.then(() => fn());
  // Giữ chuỗi tiếp tục dù fn thành công hay lỗi (nuốt lỗi ở nhánh chuỗi, không ở nhánh trả về).
  tail = result.then(() => undefined, () => undefined);
  return result;
}

module.exports = { withLock };
