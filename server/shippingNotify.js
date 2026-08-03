'use strict';
/**
 * Sinh nội dung "báo ship" (báo khách khi giao shipper) từ dữ liệu Quản lý giao hàng.
 * Xem plan: docs/shipping-notify-plan.md
 *
 * ĐVVC ngoài registry (CARRIERS) -> dùng MẪU CHUNG dự phòng (DEFAULT_TEMPLATES.fallback, admin
 * sửa được như mẫu riêng) — thích nghi theo dữ liệu THỰC TẾ đơn đang có (link hay mã vận đơn,
 * cái nào có thì dùng, không ép loại). CHỈ áp dụng cho gửi TAY (Pha 0/1, có NV xem trước trong
 * modal trước khi bấm Gửi) — luồng TỰ ĐỘNG (Pha 2, shippingAutoNotify.js) vẫn BỎ QUA ĐVVC chưa
 * khai registry, không tự gửi mẫu chung khi chưa có người xem qua.
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
// COD đã format, {link} link theo dõi shipper (nhóm link), {trackUrl} link tra cứu (chỉ GHTK),
// {shipFeeLine} dòng "Phí ship khách trả" — CHỈ có nội dung khi ship_payer='customer' (khách trả
// phí ship, cần chuẩn bị thêm tiền cho shipper); Cty trả thì {shipFeeLine} là chuỗi rỗng.
const DEFAULT_TEMPLATES = {
  2: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Mã vận đơn: {code}\n'
    + '💰 Thu COD: {cod}{shipFeeLine}\n'
    + '🔎 Theo dõi đơn hàng: {trackUrl}\n'
    + 'Dự kiến 2–5 ngày (tùy khu vực) mình sẽ nhận được hàng. Nếu cần hỗ trợ về đơn hàng, Anh/Chị cứ nhắn bên em nhé 💕',
  3: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Theo dõi đơn hàng: {link}{shipFeeLine}\n'
    + 'Anh/Chị để ý điện thoại để nhận hàng giúp em ạ 💕',
  4: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Mã vận đơn: {code}\n'
    + '💰 Thu COD: {cod}{shipFeeLine}\n'
    + 'Dự kiến 2–5 ngày (tùy khu vực) mình sẽ nhận được hàng. Nếu cần hỗ trợ về đơn hàng, Anh/Chị cứ nhắn bên em nhé 💕',
  7: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚\n'
    + '📦 Theo dõi đơn hàng: {link}{shipFeeLine}\n'
    + 'Anh/Chị để ý điện thoại để nhận hàng giúp em ạ 💕',
  // Mẫu CHUNG dự phòng cho ĐVVC chưa khai riêng (xem buildFallbackMessage) — {trackingLine}/
  // {codLine} tự rỗng nếu đơn không có link/mã/COD tương ứng, không ép phải có.
  fallback: 'Anh/Chị {name} ơi, đơn hàng của mình đã được bàn giao cho {carrier} rồi ạ 🚚{trackingLine}{codLine}{shipFeeLine}\n'
    + 'Anh/Chị để ý điện thoại để nhận hàng giúp em ạ 💕',
};

function fmtCod(n) {
  return (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
}

// Dòng "Phí ship khách trả" — chỉ sinh ra khi ship_payer='customer' VÀ phí > 0. Cty trả -> rỗng,
// không hiện vào tin (khách không cần biết/trả thêm gì).
function buildShipFeeLine(order) {
  if (String(order.shipPayer) !== 'customer') return '';
  const fee = Number(order.shipFee) || 0;
  if (fee <= 0) return '';
  return `\n💵 Phí ship (khách trả): ${fmtCod(fee)}`;
}

/** Thay {key} trong template bằng vars[key] (chuỗi rỗng nếu thiếu). Không hỗ trợ điều kiện/lặp. */
function renderTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => (vars[key] != null ? String(vars[key]) : ''));
}

/**
 * Mẫu CHUNG cho ĐVVC chưa khai registry — thích nghi theo dữ liệu THỰC TẾ đang có trên đơn (không
 * biết ĐVVC này thuộc nhóm link hay tracking, nên ưu tiên link nếu có, không thì dùng mã vận đơn
 * nếu có; không có gì thì chỉ báo "đã bàn giao" trơn, vẫn hữu ích hơn im lặng không gửi).
 */
function buildFallbackMessage(order, carrier, tpl) {
  const name = order.recipient || 'mình';
  const link = order.shipperLink || '';
  const code = order.trackingCode || '';
  let trackingLine = '';
  if (link) trackingLine = `\n📦 Theo dõi đơn hàng: ${link}`;
  else if (code) trackingLine = `\n📦 Mã vận đơn: ${code}`;
  const codLine = Number(order.codAmount) > 0 ? `\n💰 Thu COD: ${fmtCod(order.codAmount)}` : '';
  return renderTemplate(tpl, { name, carrier, trackingLine, codLine, shipFeeLine: buildShipFeeLine(order) });
}

/**
 * @param {object} order shape chuẩn hoá (từ shippingApi.normalizeShipping):
 *   { recipient, shipping, shippingId, trackingCode, codAmount, shipperLink }
 * @param {object} [overrides] map shippingId(string)|'fallback' -> template text tuỳ chỉnh (từ
 *   db.getShippingTemplates()); thiếu key nào thì dùng DEFAULT_TEMPLATES[shippingId|'fallback'].
 * @returns {{ sendable:boolean, message:string, carrier:string, reason?:string, usedFallback?:boolean }}
 *   reason khi không gửi: 'no_notify' (VP, khách tự lấy) | 'no_link' (nhóm link thiếu
 *   shipper_link) | 'no_code' (nhóm tracking thiếu mã vận đơn)
 */
function buildDeliveryMessage(order = {}, overrides = {}) {
  const reg = CARRIERS[Number(order.shippingId)];
  const carrier = (reg && reg.name) || order.shipping || 'đơn vị vận chuyển';
  if (!reg) {
    const tpl = (overrides && overrides.fallback) || DEFAULT_TEMPLATES.fallback;
    return { sendable: true, carrier, usedFallback: true, message: buildFallbackMessage(order, carrier, tpl) };
  }
  if (reg.type === 'none') return { sendable: false, message: '', carrier, reason: 'no_notify' };

  const name = order.recipient || 'mình';
  const code = order.trackingCode || '';
  const link = order.shipperLink || '';
  const shipFeeLine = buildShipFeeLine(order);
  const tpl = (overrides && overrides[String(order.shippingId)]) || DEFAULT_TEMPLATES[String(order.shippingId)];

  if (reg.type === 'link') {
    if (!link) return { sendable: false, message: '', carrier, reason: 'no_link' };
    return { sendable: true, carrier, message: renderTemplate(tpl, { name, carrier, link, shipFeeLine }) };
  }
  // tracking
  if (!code) return { sendable: false, message: '', carrier, reason: 'no_code' };
  const trackUrl = reg.trackUrl ? reg.trackUrl(code) : '';
  return { sendable: true, carrier, message: renderTemplate(tpl, { name, carrier, code, cod: fmtCod(order.codAmount), trackUrl, shipFeeLine }) };
}

// Nhãn lý do không gửi -> câu tiếng Việt cho UI.
const REASON_LABEL = {
  no_notify: 'ĐVVC này không gửi tin (khách tự tới lấy).',
  no_link: 'Chưa có link theo dõi shipper (AhaMove/Grab) — chưa đặt shipper?',
  no_code: 'Chưa có mã vận đơn.',
};

// Dữ liệu mẫu để xem trước khi sửa template (không phải đơn thật) — đủ field renderTemplate cần.
// shipFeeLine có ví dụ sẵn (khách trả phí ship) để admin thấy dòng này trông thế nào khi xuất hiện.
const SAMPLE_SHIP_FEE_LINE = '\n💵 Phí ship (khách trả): 20.000đ';
const SAMPLE_VARS = {
  2: { name: 'Minh Anh', carrier: 'Giao hàng tiết kiệm', code: 'S1234567890', cod: fmtCod(350000), trackUrl: 'https://i.ghtk.vn/S1234567890', shipFeeLine: SAMPLE_SHIP_FEE_LINE },
  3: { name: 'Minh Anh', carrier: 'AhaMove', link: 'https://aha.link/track/abc123', shipFeeLine: SAMPLE_SHIP_FEE_LINE },
  4: { name: 'Minh Anh', carrier: 'Viettel Post', code: '147928260778', cod: fmtCod(250000), shipFeeLine: '' },
  7: { name: 'Minh Anh', carrier: 'Grab', link: 'https://express.grab.com/track/abc123', shipFeeLine: '' },
  fallback: {
    name: 'Minh Anh', carrier: 'ĐVVC Mới (chưa khai mẫu riêng)',
    trackingLine: '\n📦 Mã vận đơn: XYZ123456', codLine: '\n💰 Thu COD: 150.000đ', shipFeeLine: '',
  },
};

module.exports = {
  CARRIERS, DEFAULT_TEMPLATES, SAMPLE_VARS, renderTemplate, buildDeliveryMessage, REASON_LABEL,
};
