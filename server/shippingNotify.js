'use strict';
/**
 * Sinh nội dung "báo ship" (báo khách khi giao shipper) từ dữ liệu Quản lý giao hàng.
 * Xem plan: docs/shipping-notify-plan.md
 *
 * Hướng B (an toàn): CHỈ ĐVVC được khai trong CARRIERS mới gửi. ĐVVC ngoài registry -> không
 * gửi (sendable=false, reason='unregistered') để tầng trên cảnh báo NV, KHÔNG gửi mẫu chung.
 *
 * Module thuần (không I/O) -> dùng lại được cho: preview (Pha 0), gửi tay (Pha 1), auto (Pha 2).
 * Pha 3: NỘI DUNG mẫu (DEFAULT_TEMPLATES) admin sửa được trên Cài đặt (lưu DB qua
 * db.getShippingTemplates/setShippingTemplate) — registry ĐVVC (loại link/tracking, có gửi hay
 * không) vẫn CỐ ĐỊNH ở đây, buildDeliveryMessage chỉ nhận `overrides` từ tầng gọi (index.js/
 * shippingSendService.js đọc DB) để giữ module này thuần, không tự I/O.
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

// Mẫu tin MẶC ĐỊNH theo shippingId — admin sửa được trên Cài đặt (Pha 3). Placeholder thay bằng
// {tên}: {name} người nhận, {carrier} tên ĐVVC, {code} mã vận đơn (nhóm tracking), {cod} số tiền
// COD đã format, {link} link theo dõi shipper (nhóm link), {trackUrl} link tra cứu (chỉ GHTK).
const DEFAULT_TEMPLATES = {
  2: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Mã vận đơn: {code}\n'
    + '💰 Thu COD: {cod}\n'
    + '🔎 Theo dõi đơn hàng: {trackUrl}\n'
    + 'Dự kiến 2–5 ngày (tùy khu vực) mình sẽ nhận được hàng. Nếu cần hỗ trợ về đơn hàng, Anh/Chị cứ nhắn bên em nhé 💕',
  3: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Theo dõi đơn hàng: {link}\n'
    + 'Anh/Chị để ý điện thoại để nhận hàng giúp em ạ 💕',
  4: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Mã vận đơn: {code}\n'
    + '💰 Thu COD: {cod}\n'
    + 'Dự kiến 2–5 ngày (tùy khu vực) mình sẽ nhận được hàng. Nếu cần hỗ trợ về đơn hàng, Anh/Chị cứ nhắn bên em nhé 💕',
  7: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Theo dõi đơn hàng: {link}\n'
    + 'Anh/Chị để ý điện thoại để nhận hàng giúp em ạ 💕',
};

function fmtCod(n) {
  return (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
}

/** Thay {key} trong template bằng vars[key] (chuỗi rỗng nếu thiếu). Không hỗ trợ điều kiện/lặp. */
function renderTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => (vars[key] != null ? String(vars[key]) : ''));
}

/**
 * @param {object} order shape chuẩn hoá (từ shippingApi.normalizeShipping):
 *   { recipient, shipping, shippingId, trackingCode, codAmount, shipperLink }
 * @param {object} [overrides] map shippingId(string) -> template text tuỳ chỉnh (từ
 *   db.getShippingTemplates()); thiếu key nào thì dùng DEFAULT_TEMPLATES[shippingId].
 * @returns {{ sendable:boolean, message:string, carrier:string, reason?:string }}
 *   reason khi không gửi: 'unregistered' (ĐVVC chưa khai) | 'no_notify' (VP, khách tự lấy)
 *   | 'no_link' (nhóm link thiếu shipper_link) | 'no_code' (nhóm tracking thiếu mã vận đơn)
 */
function buildDeliveryMessage(order = {}, overrides = {}) {
  const reg = CARRIERS[Number(order.shippingId)];
  const carrier = (reg && reg.name) || order.shipping || 'đơn vị vận chuyển';
  if (!reg) return { sendable: false, message: '', carrier, reason: 'unregistered' };
  if (reg.type === 'none') return { sendable: false, message: '', carrier, reason: 'no_notify' };

  const name = order.recipient || 'mình';
  const code = order.trackingCode || '';
  const link = order.shipperLink || '';
  const tpl = (overrides && overrides[String(order.shippingId)]) || DEFAULT_TEMPLATES[String(order.shippingId)];

  if (reg.type === 'link') {
    if (!link) return { sendable: false, message: '', carrier, reason: 'no_link' };
    return { sendable: true, carrier, message: renderTemplate(tpl, { name, carrier, link }) };
  }
  // tracking
  if (!code) return { sendable: false, message: '', carrier, reason: 'no_code' };
  const trackUrl = reg.trackUrl ? reg.trackUrl(code) : '';
  return { sendable: true, carrier, message: renderTemplate(tpl, { name, carrier, code, cod: fmtCod(order.codAmount), trackUrl }) };
}

// Nhãn lý do không gửi -> câu tiếng Việt cho UI.
const REASON_LABEL = {
  unregistered: 'ĐVVC chưa khai mẫu báo ship — cần bổ sung mẫu trước khi gửi.',
  no_notify: 'ĐVVC này không gửi tin (khách tự tới lấy).',
  no_link: 'Chưa có link theo dõi shipper (AhaMove/Grab) — chưa đặt shipper?',
  no_code: 'Chưa có mã vận đơn.',
};

// Dữ liệu mẫu để xem trước khi sửa template (không phải đơn thật) — đủ field renderTemplate cần.
const SAMPLE_VARS = {
  2: { name: 'Minh Anh', carrier: 'Giao hàng tiết kiệm', code: 'S1234567890', cod: fmtCod(350000), trackUrl: 'https://i.ghtk.vn/S1234567890' },
  3: { name: 'Minh Anh', carrier: 'AhaMove', link: 'https://aha.link/track/abc123' },
  4: { name: 'Minh Anh', carrier: 'Viettel Post', code: '147928260778', cod: fmtCod(250000) },
  7: { name: 'Minh Anh', carrier: 'Grab', link: 'https://express.grab.com/track/abc123' },
};

module.exports = {
  CARRIERS, DEFAULT_TEMPLATES, SAMPLE_VARS, renderTemplate, buildDeliveryMessage, REASON_LABEL,
};
