'use strict';
/**
 * Pha 1 — Gửi tay báo ship từ trang "Quản lý giao hàng" (xem docs/shipping-notify-plan.md).
 *
 * Tái dùng hạ tầng gửi Zalo/Facebook sẵn có (playwrightProxy + accountResolver + reports) —
 * KHÔNG đụng tới notifyService.js vì service đó gắn chặt với shape đơn "Hàng về VN"
 * (customerId/dateInventory). Đơn "Quản lý giao hàng" không có 2 field này.
 */
const { sendBaoHang, sendBaoHangFb } = require('./playwrightProxy');
const { resolveForOrder, isRetryableAccountError } = require('./accountResolver');
const { buildDeliveryMessage, REASON_LABEL } = require('./shippingNotify');
const { syncShipStatusByCode } = require('./bassoApi');
const {
  addReport, updateReport, getZaloName, getFbLink,
  getShippingNotified, markShippingNotified, getShippingTemplates,
  getContactReportTarget, getContactKenhSale,
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

  const built = buildDeliveryMessage(order, getShippingTemplates());
  if (!built.sendable) {
    return { ok: false, error: REASON_LABEL[built.reason] || 'Chưa gửi được.', reason: built.reason };
  }

  const staff = firstApproveUser(order);
  const orderCode = firstOrderCode(order);
  // KÊNH SALE THEO KHÁCH: như notifyService.js — nếu khách đã gắn sẵn kênh sale trong Danh bạ,
  // dùng làm mặc định khi lượt gửi này không tự chọn kênh sale.
  const kenhSale = opts.kenhSale || getContactKenhSale(order.phone);
  const resolved = await resolveForOrder({ staff, orderCode, phone: order.phone }, { ...opts, kenhSale });
  // NGOẠI LỆ THEO KHÁCH: "Kiểu báo riêng" trong Danh bạ ('personal'/'group') GHI ĐÈ kiểu báo mặc
  // định của NV phụ trách (vd NV báo nhóm nhưng riêng khách này không có group Zalo, phải báo cá
  // nhân). Thiếu bước này thì auto-ship luôn dùng kiểu báo của tài khoản Zalo (theo NV) bất kể
  // Danh bạ cấu hình gì cho khách -> tìm sai hội thoại (KHONG_THAY_HOI_THOAI). Chỉ áp cho kênh
  // Zalo — Facebook không có tab cá nhân/nhóm.
  if (resolved.channel !== 'facebook') {
    const override = getContactReportTarget(order.phone);
    if (override) resolved.notifyTarget = override;
  }
  // LOG CHẨN ĐOÁN: account + kiểu báo đã chọn cho đơn này (đối chiếu khi khách báo gửi nhầm nhóm/cá nhân).
  console.log(`[shipping-notify] ${order.recipient || order.phone || '?'} | staff=${staff || '-'} -> channel=${resolved.channel || 'zalo'} account=${resolved.account || '-'} source=${resolved.source} notifyTarget=${resolved.notifyTarget || 'group'}`);
  if (resolved.skip) {
    const err = resolved.skipReason === 'fb_no_account'
      ? `Đơn cần báo qua Facebook nhưng NV ${staff || '—'} chưa có tài khoản Facebook.`
      : resolved.skipReason === 'channel_no_account'
        ? `Chưa cấu hình kênh sale "${kenhSale}" cho NV ${staff || '—'}. Vào Cài đặt → Kênh Sale để thêm.`
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
      // NV được gắn NHIỀU tài khoản Zalo không phân biệt được bằng brand (resolved.fallbackAccounts,
      // xem accountResolver.js) -> thử lần lượt: account chính trước, "không thấy hội thoại" (khách
      // có thể đang nằm ở tài khoản kia) thì thử account dự phòng kế tiếp.
      const candidates = [resolved, ...(Array.isArray(resolved.fallbackAccounts) ? resolved.fallbackAccounts : [])];
      for (let i = 0; i < candidates.length; i += 1) {
        const cand = candidates[i];
        try {
          // eslint-disable-next-line no-await-in-loop
          result = await sendBaoHang({
            profile: cand.profile || 'default',
            account: cand.account,
            keyword,
            name: matchName,
            message: built.message,
            notifyTarget: cand.notifyTarget || resolved.notifyTarget,
          });
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        if (result.ok || i === candidates.length - 1 || !isRetryableAccountError(result.error)) {
          if (cand !== resolved && result.ok) {
            console.log(`[shipping-notify] account "${resolved.account || resolved.profile}" không thấy hội thoại -> gửi thành công qua account dự phòng "${cand.account || cand.profile}"`);
            resolved.account = cand.account;
            resolved.profile = cand.profile;
          }
          break;
        }
        console.log(`[shipping-notify] account "${cand.account || cand.profile}" không thấy hội thoại -> thử account dự phòng "${candidates[i + 1].account || candidates[i + 1].profile}"`);
      }
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  let report = updateReport(pending.id, {
    status: result.ok ? 'success' : 'failed',
    error: result.ok ? null : result.error,
    jobId: result.jobId,
    zaloAccount: resolved.account || resolved.profile || null,
  });

  if (result.ok) {
    markShippingNotified(order.id, order.phone);
    // Đồng bộ "Đã báo ship" về Hàng về VN — best-effort, KHÔNG chặn kết quả gửi (tin đã đi rồi).
    try {
      const sync = await syncShipStatusByCode({ phone: order.phone, code: order.trackingCode });
      // Gắn customerId/dateInventory của dòng vừa khớp vào report -> Hàng về VN hiện được
      // "Người gửi/Tài khoản" ngay trên dòng đơn (getLastReportMap/getSentTimesMap khớp theo
      // 2 khoá này). Nhiều dòng khớp (hiếm) -> lấy dòng ĐẦU làm đại diện, đủ cho mục đích hiển thị.
      const first = sync.matches && sync.matches[0];
      if (first) report = updateReport(pending.id, { customerId: first.customerId, dateInventory: first.dateInventory });
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

module.exports = { sendShippingOne, sendShippingBulk, firstApproveUser };
