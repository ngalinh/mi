'use strict';
const config = require('./config');
const { getOrders, updateOrderStatus, getArrivedItems } = require('./bassoApi');
const { sendBaoHang } = require('./playwrightProxy');
const { buildBaoHangMessage, buildBaoShipMessage } = require('../shared/messageTemplate');
const { addReport, updateReport, getAutoRecord, recordAutoNotified, autoKey } = require('./db');
const { withLock } = require('./lock');
const { resolveForOrder } = require('./accountResolver');

/**
 * Báo hàng/ship cho 1 đơn: build tin nhắn -> gửi qua local-runner -> (tùy chọn) cập nhật
 * trạng thái về web -> ghi report.
 * @param {object} order - đơn đã chuẩn hóa
 * @param {object} [opts] { profile, account, messageOverride, kind, skipWebUpdate } kind = 'hang' | 'ship'
 */
/**
 * Mã đơn để HIỂN THỊ trên report = "Mã ĐH" (orderCode, vd BS26052646), KHÔNG phải id nội bộ (vd 546).
 * orderCode nằm trên từng sản phẩm nên: ưu tiên client gửi sẵn, không có thì tra qua getArrivedItems
 * (mọi luồng đều truyền đủ id/customerId/dateInventory nên luôn tra được), gộp các mã khác nhau
 * (1 dòng có thể nhiều SP). Không tra được (đơn không có SP, hoặc API rỗng/lỗi) -> trả null để UI
 * hiển thị "—". KHÔNG fallback về id nội bộ nữa để tránh nhầm id (546) với mã ĐH (BS...).
 * @param {object} order
 * @returns {Promise<string|null>}
 */
async function resolveOrderMeta(order) {
  let orderCode = order.orderCode && String(order.orderCode).trim() ? String(order.orderCode).trim() : null;
  let images = [];
  try {
    const { items } = await getArrivedItems({
      id: order.id,
      customerId: order.customerId,
      dateInventory: order.dateInventory,
    });
    const list = items || [];
    if (!orderCode) {
      const codes = [...new Set(list.map((it) => it.orderCode).filter(Boolean))];
      if (codes.length) orderCode = codes.join(', ');
      else console.warn(`[notify] đơn id=${order.id} không có mã ĐH (không có SP đã về) -> report để trống`);
    }
    // Ảnh SP để hiển thị thumbnail trên Lịch sử báo (giữ tối đa 20, UI cắt còn 4 + "+N").
    images = [...new Set(list.map((it) => it.image).filter(Boolean))].slice(0, 20);
  } catch (err) {
    console.warn(`[notify] không tra được SP cho đơn id=${order.id}: ${err.message}`);
  }
  return { orderCode, images };
}

async function notifyOne(order, opts = {}) {
  const kind = opts.kind === 'ship' ? 'ship' : 'hang';
  const newStatus = kind === 'ship' ? 'notified_ship' : 'notified_arrival';
  const message = opts.messageOverride && opts.messageOverride.trim()
    ? opts.messageOverride.trim()
    : (kind === 'ship' ? buildBaoShipMessage(order) : buildBaoHangMessage(order));

  // Tìm khách: dùng SĐT (whitelist + tìm) và tên (khớp hội thoại)
  const keyword = order.phone || order.customerName;

  // MÔ HÌNH B: mỗi tài khoản Zalo 1 profile riêng. Resolver quyết định profile + saleworkName
  // theo NV phụ trách đơn (accountsStore trên runner), fallback ZALO_ACCOUNT_MAP / mặc định.
  const resolved = await resolveForOrder(order, opts);

  // Tra mã ĐH + ảnh SP TRƯỚC khi gửi để dòng "đang báo" đã đủ thông tin hiển thị (chỉ tra 1 lần,
  // dùng lại cho cả lúc cập nhật kết quả cuối).
  const meta = await resolveOrderMeta(order);

  // Ghi 1 dòng "đang báo" (pending) NGAY trước khi gửi. Nhờ vậy cả báo tự động lẫn báo tay đều
  // thấy ngay đã nhận lệnh gửi cho khách nào, kể cả khi job kéo dài (sendBaoHang poll tới 10 phút)
  // hay đang xếp hàng trong báo loạt. Sau khi gửi xong sẽ UPDATE chính dòng này thành success/failed.
  const pending = addReport({
    orderId: meta.orderCode,
    customerName: order.customerName,
    phone: order.phone,
    staff: order.staff,
    message,
    status: 'pending',
    images: meta.images,
    sentBy: opts.actor || null,
    // Tài khoản Zalo dùng để gửi (để đối chiếu trên Lịch sử báo): ưu tiên tên dropdown,
    // không có thì tới profile/key, cuối cùng 'default'.
    zaloAccount: resolved.account || resolved.profile || null,
  });

  let result;
  try {
    result = await sendBaoHang({
      profile: resolved.profile || 'default',
      account: resolved.account,
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

  // Chốt kết quả vào CHÍNH dòng "đang báo" đã ghi ở trên (không tạo dòng mới).
  const report = updateReport(pending.id, {
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
