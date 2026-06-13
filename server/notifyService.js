'use strict';
const config = require('./config');
const { getOrders, updateOrderStatus } = require('./bassoApi');
const { sendBaoHang } = require('./playwrightProxy');
const { buildBaoHangMessage, buildBaoShipMessage } = require('../shared/messageTemplate');
const { addReport, getAutoRecord, recordAutoNotified, autoKey } = require('./db');
const { withLock } = require('./lock');

/**
 * Báo hàng/ship cho 1 đơn: build tin nhắn -> gửi qua local-runner -> (tùy chọn) cập nhật
 * trạng thái về web -> ghi report.
 * @param {object} order - đơn đã chuẩn hóa
 * @param {object} [opts] { profile, account, messageOverride, kind, skipWebUpdate } kind = 'hang' | 'ship'
 */
async function notifyOne(order, opts = {}) {
  const kind = opts.kind === 'ship' ? 'ship' : 'hang';
  const newStatus = kind === 'ship' ? 'notified_ship' : 'notified_arrival';
  const message = opts.messageOverride && opts.messageOverride.trim()
    ? opts.messageOverride.trim()
    : (kind === 'ship' ? buildBaoShipMessage(order) : buildBaoHangMessage(order));

  // Tìm khách: dùng SĐT (whitelist + tìm) và tên (khớp hội thoại)
  const keyword = order.phone || order.customerName;

  let result;
  try {
    result = await sendBaoHang({
      profile: opts.profile || 'default',
      account: opts.account,
      keyword,
      name: order.customerName,
      message,
      strictMatch: opts.strictMatch === true, // luồng bot: chỉ gửi khi khớp chắc chắn
    });
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  // Gửi thành công -> cập nhật trạng thái 'Đã báo hàng' ngược về web (nếu bật).
  // skipWebUpdate=true (luồng bot tự động): CHỈ lưu trạng thái trong mi, KHÔNG đẩy về web Basso.
  let updateError = null;
  if (result.ok && !opts.skipWebUpdate && config.basso.autoUpdateStatus && order.customerId != null) {
    try {
      await updateOrderStatus({
        customerId: order.customerId,
        dateInventory: order.dateInventory,
        status: newStatus,
        note: order.note || undefined,
      });
    } catch (err) {
      updateError = err.message;
    }
  }

  const report = addReport({
    orderId: order.id,
    customerName: order.customerName,
    phone: order.phone,
    staff: order.staff,
    message,
    status: result.ok ? 'success' : 'failed',
    error: result.ok ? (updateError ? `Đã gửi nhưng update web lỗi: ${updateError}` : null) : result.error,
    jobId: result.jobId,
  });

  return { order, ...result, updateError, report };
}

/**
 * Báo hàng cho nhiều đơn theo danh sách orderId. Chạy tuần tự (local-runner cũng tuần tự).
 * Bọc trong withLock để KHÔNG chạy chồng với luồng tự động (R6) -> tránh gửi trùng.
 * @param {string[]} orderIds
 * @param {object} [opts]
 */
async function notifyMany(orderIds, opts = {}) {
  return withLock(async () => {
    const { orders } = await getOrders();
    const byId = new Map(orders.map((o) => [String(o.id), o]));

    const results = [];
    for (const id of orderIds) {
      const order = byId.get(String(id));
      if (!order) {
        results.push({ orderId: id, ok: false, error: 'Không tìm thấy đơn' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await notifyOne(order, opts);
      // Báo tay thành công -> ghi dấu 'manual' để BOT không gửi lại (kể cả khi không
      // cập nhật web). Không đè lên 'success' của bot để giữ đúng badge.
      if (r.ok) {
        const key = autoKey(order);
        const ex = getAutoRecord(key);
        if (!ex || ex.status !== 'success') recordAutoNotified(key, 'manual', ex ? ex.attempts : 0);
      }
      results.push({
        orderId: id,
        customerName: order.customerName,
        ok: r.ok,
        error: r.error || r.updateError || null,
        jobId: r.jobId || null,
      });
    }

    const sent = results.filter((r) => r.ok).length;
    return { total: results.length, sent, failed: results.length - sent, results };
  });
}

module.exports = { notifyOne, notifyMany };
