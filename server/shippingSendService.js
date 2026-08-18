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
const { syncShipStatusByCode, getTabUsers, findCustomerByOrderCode } = require('./bassoApi');
const {
  addReport, updateReport, getZaloName, getFbLink,
  getShippingNotified, markShippingNotified, getShippingTemplates,
  getContactReportTarget,
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
 * Tra `user_id` Basso của NV duyệt theo TÊN (API "Quản lý giao hàng" chỉ trả tên `approve_user`,
 * không có id). accountResolver.js khớp tài khoản "dùng chung" (sharedStaffIds) theo user_id —
 * thiếu bước này thì NV được share tài khoản của người khác sẽ KHÔNG bao giờ khớp được (rơi về
 * account "chung toàn công ty"), dù đã cấu hình share đúng ở Cài đặt. Chỉ nhận khi khớp DUY NHẤT
 * 1 NV (giống pattern /api/me) — trùng tên nhiều NV thì bỏ qua, để accountResolver tự khớp tiếp
 * theo TÊN như trước (không id).
 */
async function staffUserIdByName(name) {
  if (!name) return undefined;
  try {
    const { tabUsers } = await getTabUsers();
    const norm = (s) => String(s || '').trim().toLowerCase();
    const hit = (tabUsers || []).filter((u) => norm(u.name) === norm(name));
    return hit.length === 1 ? String(hit[0].user_id) : undefined;
  } catch {
    return undefined; // Basso lỗi -> bỏ qua, để accountResolver khớp theo tên như cũ.
  }
}

/**
 * Gửi Zalo thử lần lượt account chính + fallbackAccounts (khách có thể nằm ở tài khoản khác của
 * cùng NV) — tách riêng để gọi lại được với keyword/tên khác khi fallback SĐT khách hàng (bên dưới).
 */
async function trySendZalo(resolved, keyword, matchName, message) {
  let result;
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
        message,
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
  return result;
}

/**
 * SĐT người nhận trên vận đơn (Quản lý giao hàng) đôi khi KHÁC SĐT khách hàng thật đặt đơn (vd
 * người nhận hộ) -> tìm không ra hội thoại Zalo dù khách có Zalo thật. Tra ngược từng mã đơn
 * trong vận đơn sang "Hàng về VN" (bassoApi.findCustomerByOrderCode) để lấy SĐT khách hàng thật,
 * thử mã đầu tiên khớp được. CHỈ gọi khi lần gửi đầu đã thất bại vì "không có hội thoại"
 * (xem sendShippingOne) — không tính sẵn cho toàn bộ danh sách.
 * @returns {Promise<{customerName:string, phone:string}|null>}
 */
async function findFallbackCustomer(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const codes = [...new Set(items.map((it) => it && it.orderCode && String(it.orderCode).trim()).filter(Boolean))];
  for (const code of codes) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await findCustomerByOrderCode(code);
    if (hit && hit.phone) return hit;
  }
  return null;
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
  // user_id Basso của NV duyệt (nếu tra được) — để accountResolver khớp được tài khoản "dùng
  // chung" (sharedStaffIds) như flow "Hàng về VN", thay vì chỉ khớp theo tên.
  const staffUserId = await staffUserIdByName(staff);
  // KÊNH SALE: chỉ còn vai trò PHỤ — khi NV duyệt có ≥2 tài khoản mà brand không phân biệt được,
  // resolver dùng kênh sale (thật của vận đơn rồi tới gắn trong Danh bạ) để chọn đúng tài khoản
  // trong số đó, KHÔNG tự chọn account độc lập với NV — xem accountResolver.resolveForOrder. Phải
  // truyền kèm saleChannelLabel/saleChannel vì object đơn dựng riêng ở đây (khác shape "Hàng về
  // VN") không tự mang theo 2 field đó.
  const resolved = await resolveForOrder(
    {
      staff, userId: staffUserId, orderCode, phone: order.phone,
      saleChannel: order.saleChannel, saleChannelLabel: order.saleChannelLabel,
    },
    opts,
  );
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
  console.log(`[shipping-notify] ${order.recipient || order.phone || '?'} | staff=${staff || '-'} userId=${staffUserId || '-'} -> channel=${resolved.channel || 'zalo'} account=${resolved.account || '-'} source=${resolved.source} notifyTarget=${resolved.notifyTarget || 'group'}`);
  if (resolved.skip) {
    const err = resolved.skipReason === 'fb_no_account'
      ? `Đơn cần báo qua Facebook nhưng NV ${staff || '—'} chưa có tài khoản Facebook.`
      : resolved.skipReason === 'channel_no_account'
        ? `Đã chọn kênh sale "${opts.kenhSale}" cho lượt báo này nhưng chưa có cấu hình (kênh sale + NV) -> tài khoản Zalo cho NV ${staff || '—'}.`
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
      result = await trySendZalo(resolved, keyword, matchName, built.message);
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  // FALLBACK SĐT NGƯỜI NHẬN -> SĐT KHÁCH HÀNG THẬT: chỉ khi lần gửi trên thất bại đúng vì "không
  // có hội thoại Zalo" (KHONG_THAY_HOI_THOAI) — các lỗi khác (chưa đăng nhập, mạng...) thử số khác
  // cũng không giải quyết được. SĐT người nhận trên vận đơn có thể khác SĐT khách đặt đơn (người
  // nhận hộ) -> tra ngược mã đơn sang "Hàng về VN" rồi thử gửi lại 1 lần (docs/shipping-notify-plan.md).
  let fallback = null;
  if (!result.ok && resolved.channel !== 'facebook' && isRetryableAccountError(result.error)) {
    fallback = await findFallbackCustomer(order).catch(() => null);
    if (fallback && fallback.phone && fallback.phone !== order.phone) {
      const fbZaloName = getZaloName(fallback.phone);
      const fbMatchName = fbZaloName || fallback.customerName || matchName;
      console.log(`[shipping-notify] SĐT người nhận ${order.phone} không có hội thoại Zalo -> tra mã đơn ra khách hàng "${fallback.customerName || '?'}" (${fallback.phone}) -> thử gửi lại.`);
      const retryResult = await trySendZalo(resolved, fallback.phone, fbMatchName, built.message);
      if (retryResult.ok) {
        result = retryResult;
      } else {
        console.log(`[shipping-notify] SĐT khách hàng ${fallback.phone} cũng không có hội thoại Zalo -> giữ nguyên lỗi.`);
        result = { ...result, error: `${result.error} — đã tra ra khách hàng "${fallback.customerName || '?'}" (${fallback.phone}) và thử lại nhưng cũng không có hội thoại Zalo.` };
        fallback = null; // không override phone trên report vì cuối cùng vẫn gửi thất bại bằng SĐT gốc
      }
    } else {
      fallback = null;
    }
  }

  let report = updateReport(pending.id, {
    status: result.ok ? 'success' : 'failed',
    error: result.ok ? null : result.error,
    jobId: result.jobId,
    zaloAccount: resolved.account || resolved.profile || null,
    ...(fallback ? {
      phone: fallback.phone,
      customerName: fallback.customerName || undefined,
      phoneSource: 'fallback_customer',
      phoneOriginal: order.phone,
    } : {}),
  });

  if (result.ok) {
    // Đồng bộ theo SĐT khách hàng THẬT khi đã fallback — "Hàng về VN" lưu customer_phone, tìm
    // theo order.phone (người nhận) trong trường hợp này sẽ không khớp được dòng nào.
    const syncPhone = fallback ? fallback.phone : order.phone;
    markShippingNotified(order.id, syncPhone);
    // Đồng bộ "Đã báo ship" về Hàng về VN — best-effort, KHÔNG chặn kết quả gửi (tin đã đi rồi).
    try {
      const sync = await syncShipStatusByCode({ phone: syncPhone, code: order.trackingCode });
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
    // Tài khoản CHỌN TAY riêng cho đơn này (cột "Tài khoản gửi" trên Quản lý giao hàng, gắn kèm
    // mỗi đơn khi báo loạt qua bulkNotify) -> ưu tiên hơn opts chung (vốn không có account/profile
    // khi gửi loạt, chỉ có actor) để KHÔNG bị resolver tự suy đè lên lựa chọn tay.
    const orderOpts = (order.account || order.profile)
      ? { ...opts, account: order.account || opts.account, profile: order.profile || opts.profile }
      : opts;
    // eslint-disable-next-line no-await-in-loop
    const r = await sendShippingOne(order, orderOpts);
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
