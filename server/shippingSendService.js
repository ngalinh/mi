'use strict';
/**
 * Pha 1 — Gửi tay báo ship từ trang "Quản lý giao hàng" (xem docs/shipping-notify-plan.md).
 *
 * Tái dùng hạ tầng gửi Zalo/Facebook sẵn có (playwrightProxy + accountResolver + reports) —
 * KHÔNG đụng tới notifyService.js vì service đó gắn chặt với shape đơn "Hàng về VN"
 * (customerId/dateInventory). Đơn "Quản lý giao hàng" không có 2 field này.
 */
const { sendBaoHang, sendBaoHangFb } = require('./playwrightProxy');
const { resolveForOrder } = require('./accountResolver');
const { buildDeliveryMessage, REASON_LABEL } = require('./shippingNotify');
const { syncShipStatusByCode } = require('./bassoApi');
const {
  addReport, updateReport, getZaloName, getFbLink,
  getShippingNotified, markShippingNotified,
} = require('./db');
const { delayBetweenCustomers } = require('./notifyService');

/** NV duyệt đại diện của vận đơn — lấy từ dòng SP đầu tiên (thường cả đơn cùng 1 NV duyệt). */
function firstApproveUser(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const hit = items.find((it) => it && it.approveUser && String(it.approveUser).trim());
  return hit ? String(hit.approveUser).trim() : '';
}

/** Mã ĐH đại diện (để accountResolver khớp brand) — lấy từ dòng SP đầu tiên có mã. */
function firstOrderCode(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const hit = items.find((it) => it && it.orderCode && String(it.orderCode).trim());
  return hit ? String(hit.orderCode).trim() : '';
}

/**
 * Gửi báo ship cho 1 vận đơn (order = shape chuẩn hoá từ shippingApi.normalizeShipping).
 * @param {object} order
 * @param {object} [opts] { actor, force } — force=true bỏ qua chống gửi trùng (gửi lại tay).
 * @returns {Promise<{ok:boolean, error?:string, alreadySent?:boolean, sentAt?:string, report?:object}>}
 */
async function sendShippingOne(order, opts = {}) {
  if (!order || order.id == null) return { ok: false, error: 'Thiếu đơn' };

  if (!opts.force) {
    const seen = getShippingNotified(order.id);
    if (seen) return { ok: false, alreadySent: true, sentAt: seen.sentAt, error: `Đã gửi báo ship lúc ${seen.sentAt}` };
  }

  const built = buildDeliveryMessage(order);
  if (!built.sendable) {
    return { ok: false, error: REASON_LABEL[built.reason] || 'Chưa gửi được.', reason: built.reason };
  }

  const staff = firstApproveUser(order);
  const orderCode = firstOrderCode(order);
  const resolved = await resolveForOrder({ staff, orderCode, phone: order.phone }, opts);
  if (resolved.skip) {
    const err = resolved.skipReason === 'fb_no_account'
      ? `Đơn cần báo qua Facebook nhưng NV ${staff || '—'} chưa có tài khoản Facebook.`
      : `Chưa có tài khoản Zalo cho brand "${resolved.orderBrand || '?'}" của NV ${staff || '—'}`;
    return { ok: false, error: err };
  }

  const zaloName = getZaloName(order.phone);
  const matchName = zaloName || order.recipient;
  const keyword = order.phone || zaloName || order.recipient;

  const pending = addReport({
    orderId: order.trackingCode || String(order.id),
    customerName: order.recipient,
    phone: order.phone,
    staff,
    message: built.message,
    status: 'pending',
    sentBy: opts.actor || null,
    kind: 'ship',
    channel: resolved.channel,
    zaloAccount: resolved.account || resolved.profile || null,
  });

  let result;
  try {
    if (resolved.channel === 'facebook') {
      const fbLink = getFbLink(order.phone);
      if (!fbLink) {
        result = { ok: false, error: `Chưa có link Facebook cho khách ${order.phone || '—'} — vào trang Danh bạ để thêm.` };
      } else {
        result = await sendBaoHangFb({
          profile: resolved.profile || 'default', fbLink, keyword, name: matchName, message: built.message,
        });
      }
    } else {
      result = await sendBaoHang({
        profile: resolved.profile || 'default',
        account: resolved.account,
        keyword,
        name: matchName,
        message: built.message,
        notifyTarget: resolved.notifyTarget,
      });
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  const report = updateReport(pending.id, {
    status: result.ok ? 'success' : 'failed',
    error: result.ok ? null : result.error,
    jobId: result.jobId,
  });

  if (result.ok) {
    markShippingNotified(order.id, order.phone);
    // Đồng bộ "Đã báo ship" về Hàng về VN — best-effort, KHÔNG chặn kết quả gửi (tin đã đi rồi).
    try {
      await syncShipStatusByCode({ phone: order.phone, code: order.trackingCode });
    } catch (err) {
      console.warn(`[shipping-notify] không đồng bộ được notified_ship cho ${order.phone}/${order.trackingCode}: ${err.message}`);
    }
  }

  return { ok: result.ok, error: result.ok ? null : result.error, report };
}

/**
 * Gửi hàng loạt (tick nhiều đơn trên Quản lý giao hàng). Tuần tự + nghỉ giữa các đơn
 * (tái dùng cấu hình delay của notifyService) để tránh gửi dồn quá nhanh.
 * @param {object[]} orders
 * @param {object} [opts] { actor }
 */
async function sendShippingBulk(orders, opts = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const results = [];
  for (let i = 0; i < list.length; i += 1) {
    const order = list[i];
    // eslint-disable-next-line no-await-in-loop
    const r = await sendShippingOne(order, opts);
    results.push({ id: order.id, ok: r.ok, error: r.error || null, alreadySent: !!r.alreadySent });
    if (i + 1 < list.length) {
      // eslint-disable-next-line no-await-in-loop
      await delayBetweenCustomers();
    }
  }
  const sent = results.filter((r) => r.ok).length;
  return { total: results.length, sent, failed: results.length - sent, results };
}

module.exports = { sendShippingOne, sendShippingBulk };
