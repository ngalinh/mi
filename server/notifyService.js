'use strict';
const config = require('./config');
const { getOrders, updateOrderStatus, getArrivedItems } = require('./bassoApi');
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
/**
 * Mã đơn để HIỂN THỊ trên report = "Mã ĐH" (orderCode, vd BS26052646), KHÔNG phải id nội bộ (vd 546).
 * orderCode nằm trên từng sản phẩm nên: ưu tiên client gửi sẵn, không có thì tra lazy qua getArrivedItems,
 * gộp các mã khác nhau (1 dòng có thể nhiều SP). Tra lỗi/không có -> fallback về id để report không trống.
 * @param {object} order
 * @returns {Promise<string|null>}
 */
async function resolveOrderCode(order) {
  if (order.orderCode && String(order.orderCode).trim()) return String(order.orderCode).trim();
  try {
    const { items } = await getArrivedItems({
      id: order.id,
      customerId: order.customerId,
      dateInventory: order.dateInventory,
    });
    const codes = [...new Set((items || []).map((it) => it.orderCode).filter(Boolean))];
    if (codes.length) return codes.join(', ');
  } catch (_) {
    // bỏ qua — fallback về id bên dưới
  }
  return order.id != null ? String(order.id) : null;
}

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
    orderId: await resolveOrderCode(order),
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
 * Báo hàng cho danh sách ĐƠN (object đầy đủ field do client gửi lên — đã có sẵn trên
 * dashboard). Không phải tra lại theo id nên không lệ thuộc phân trang/bộ lọc.
 * Bọc trong withLock để KHÔNG chạy chồng với luồng tự động (R6) -> tránh gửi trùng.
 * @param {object[]} orders - mỗi phần tử cần tối thiểu: customerId, dateInventory, customerName, phone
 * @param {object} [opts]
 */
async function notifyOrders(orders, opts = {}) {
  return withLock(async () => {
    const results = [];
    for (const order of orders) {
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
        orderId: order.id,
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

/**
 * (Legacy) Báo hàng theo danh sách orderId — tự tra đơn từ Basso. CẢNH BÁO: chỉ lấy
 * trang đầu nên có thể không tìm thấy khi dữ liệu nhiều; ưu tiên dùng notifyOrders.
 * @param {string[]} orderIds
 * @param {object} [opts]
 */
async function notifyMany(orderIds, opts = {}) {
  const { orders } = await getOrders();
  const byId = new Map(orders.map((o) => [String(o.id), o]));
  const found = [];
  const missing = [];
  for (const id of orderIds) {
    const o = byId.get(String(id));
    if (o) found.push(o); else missing.push(id);
  }
  const res = await notifyOrders(found, opts);
  for (const id of missing) {
    res.results.push({ orderId: id, ok: false, error: 'Không tìm thấy đơn' });
    res.total += 1; res.failed += 1;
  }
  return res;
}

module.exports = { notifyOne, notifyMany, notifyOrders };
