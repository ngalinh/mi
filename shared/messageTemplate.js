'use strict';

/**
 * Mẫu tin nhắn báo hàng về.
 *
 * `order` là 1 dòng "hàng về" lấy từ dashboard, chuẩn hóa qua server/bassoApi.js.
 * Nếu order đã có sẵn `noiDungBaoHang` (cột "ND báo hàng" trên web) thì ưu tiên dùng nguyên văn.
 * Ngược lại sẽ build từ template mặc định bên dưới.
 *
 * Bạn chỉnh nội dung/biến ở đây là toàn hệ thống dùng theo.
 */

function formatDate(value) {
  if (!value) return '';
  // Hỗ trợ cả "04/06/2026" lẫn ISO; trả lại nguyên văn nếu không parse được.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function defaultTemplate(order) {
  const ten = order.customerName || 'quý khách';
  const ngay = formatDate(order.warehouseDate) || 'hôm nay';
  return [
    `Dạ ${ten} ơi, đơn hàng của mình đã về kho VN ngày ${ngay} ạ 🎉`,
    `Shop sẽ tiến hành giao hàng/booking ship sớm nhất.`,
    `Mình kiểm tra giúp shop thông tin nhận hàng nhé. Cảm ơn ${ten} đã ủng hộ ạ! ❤️`,
  ].join('\n');
}

/**
 * @param {object} order  - đơn đã chuẩn hóa
 * @param {object} [opts]
 * @param {boolean} [opts.preferOrderContent=true] - ưu tiên nội dung "ND báo hàng" có sẵn từ web
 * @returns {string}
 */
function buildBaoHangMessage(order, opts = {}) {
  const preferOrderContent = opts.preferOrderContent !== false;
  if (preferOrderContent && order && order.noiDungBaoHang && String(order.noiDungBaoHang).trim()) {
    return String(order.noiDungBaoHang).trim();
  }
  return defaultTemplate(order || {});
}

function defaultShipTemplate(order) {
  const ten = order.customerName || 'quý khách';
  return [
    `Dạ ${ten} ơi, đơn hàng của mình đã được shop gửi đi giao ạ 🚚`,
    `Mình để ý điện thoại giúp shop để nhận hàng nhé. Cảm ơn ${ten} ạ! ❤️`,
  ].join('\n');
}

/**
 * Tin nhắn báo ship. Ưu tiên nội dung "ND báo ship" có sẵn từ web.
 */
function buildBaoShipMessage(order, opts = {}) {
  const preferOrderContent = opts.preferOrderContent !== false;
  if (preferOrderContent && order && order.noiDungBaoShip && String(order.noiDungBaoShip).trim()) {
    return String(order.noiDungBaoShip).trim();
  }
  return defaultShipTemplate(order || {});
}

module.exports = { buildBaoHangMessage, buildBaoShipMessage, defaultTemplate, defaultShipTemplate, formatDate };
