'use strict';
/**
 * Sinh nội dung "báo ship" (báo khách khi giao shipper) từ dữ liệu Quản lý giao hàng.
 * Xem plan: docs/shipping-notify-plan.md
 *
 * Hướng B (an toàn): CHỈ ĐVVC được khai trong CARRIERS mới gửi. ĐVVC ngoài registry -> không
 * gửi (sendable=false, reason='unregistered') để tầng trên cảnh báo NV, KHÔNG gửi mẫu chung.
 *
 * Module thuần (không I/O) -> dùng lại được cho: preview (Pha 0), gửi tay (Pha 1), auto (Pha 2).
 */

// Registry ĐVVC -> mẫu. type: 'link' (dùng shipper_link) | 'tracking' (mã vận đơn) | 'none' (không gửi).
// trackUrl: hàm dựng link tra cứu từ mã vận đơn (chỉ ĐVVC có pattern riêng, vd GHTK).
const CARRIERS = {
  2: { name: 'Giao hàng tiết kiệm', type: 'tracking', trackUrl: (code) => `https://i.ghtk.vn/${code}` },
  3: { name: 'AhaMove', type: 'link' },
  4: { name: 'Viettel Post', type: 'tracking' },
  7: { name: 'Grab', type: 'link' },
  8: { name: 'Nhận hàng tại VP', type: 'none' },
};

function fmtCod(n) {
  return (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
}

/**
 * @param {object} order shape chuẩn hoá (từ shippingApi.normalizeShipping):
 *   { recipient, shipping, shippingId, trackingCode, codAmount, shipperLink }
 * @returns {{ sendable:boolean, message:string, carrier:string, reason?:string }}
 *   reason khi không gửi: 'unregistered' (ĐVVC chưa khai) | 'no_notify' (VP, khách tự lấy)
 *   | 'no_link' (nhóm link thiếu shipper_link) | 'no_code' (nhóm tracking thiếu mã vận đơn)
 */
function buildDeliveryMessage(order = {}) {
  const reg = CARRIERS[Number(order.shippingId)];
  const carrier = (reg && reg.name) || order.shipping || 'đơn vị vận chuyển';
  if (!reg) return { sendable: false, message: '', carrier, reason: 'unregistered' };
  if (reg.type === 'none') return { sendable: false, message: '', carrier, reason: 'no_notify' };

  const name = order.recipient || 'mình';
  const code = order.trackingCode || '';
  const link = order.shipperLink || '';

  if (reg.type === 'link') {
    if (!link) return { sendable: false, message: '', carrier, reason: 'no_link' };
    return {
      sendable: true, carrier,
      message:
        `Anh/Chị ${name} ơi, đơn hàng của mình đã được bàn giao cho ${carrier} rồi ạ 🚚\n`
        + `📦 Theo dõi đơn hàng: ${link}\n`
        + `Anh/Chị để ý điện thoại để nhận hàng giúp em ạ 💕`,
    };
  }
  // tracking
  if (!code) return { sendable: false, message: '', carrier, reason: 'no_code' };
  const trackLine = reg.trackUrl ? `\n🔎 Theo dõi đơn hàng: ${reg.trackUrl(code)}` : '';
  return {
    sendable: true, carrier,
    message:
      `Anh/Chị ${name} ơi, đơn hàng của mình đã được bàn giao cho ${carrier} rồi ạ 🚚\n`
      + `📦 Mã vận đơn: ${code}\n`
      + `💰 Thu COD: ${fmtCod(order.codAmount)}${trackLine}\n`
      + `Dự kiến 2–5 ngày (tùy khu vực) mình sẽ nhận được hàng. Nếu cần hỗ trợ về đơn hàng, Anh/Chị cứ nhắn bên em nhé 💕`,
  };
}

// Nhãn lý do không gửi -> câu tiếng Việt cho UI.
const REASON_LABEL = {
  unregistered: 'ĐVVC chưa khai mẫu báo ship — cần bổ sung mẫu trước khi gửi.',
  no_notify: 'ĐVVC này không gửi tin (khách tự tới lấy).',
  no_link: 'Chưa có link theo dõi shipper (AhaMove/Grab) — chưa đặt shipper?',
  no_code: 'Chưa có mã vận đơn.',
};

module.exports = { CARRIERS, buildDeliveryMessage, REASON_LABEL };
