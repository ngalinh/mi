'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const fetch = require('node-fetch');
const config = require('./config');

const MOCK_FILE = path.join(__dirname, 'mock', 'shipping.json');

/**
 * Adapter tới trang "Quản lý giao hàng" của web admin Basso.
 *
 * KHÁC Partner API (bassoApi.js):
 *   - Endpoint là AJAX nội bộ của web admin: `${BASSO_WEB_BASE_URL}/shipping_order/`
 *     (mặc định https://basso.vn/basso/shipping_order/).
 *   - Auth bằng COOKIE PHIÊN (ci_session), gửi qua header `Cookie` — KHÔNG có
 *     X-Partner-Api-Key / Bearer. Vì Basso chưa mở phần giao hàng qua Partner API.
 *   - Header `X-Requested-With: XMLHttpRequest` là bắt buộc (server chỉ trả JSON cho AJAX).
 *
 * ĐỌC danh sách:
 *   GET /shipping_order/?page&shipping_id&status&user_approve&key&filter_date
 *   -> { error:false, data:[...], pagination:{...}, has_inventory_manager_role }
 *
 * THAO TÁC (đổi trạng thái 1 đơn):
 *   POST /shipping_order/  (application/x-www-form-urlencoded)  body: action=<...>&id=<id>
 *   -> { error:false, message:"Cập nhật thành công", status:"<mới>", waiting_prepared_at? }
 *
 * Xem thêm bản đồ API đã xác minh: docs/basso-shipping-api.md
 */

// Keep-alive: tái dùng TCP/TLS cho các call liên tiếp (giống bassoApi.js).
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const keepAliveAgent = (parsedURL) => (parsedURL.protocol === 'https:' ? _httpsAgent : _httpAgent);

// ----------------------------------------------------------------------------
// Hằng số nghiệp vụ (xác minh từ dữ liệu thật — xem docs/basso-shipping-api.md)
// ----------------------------------------------------------------------------

// Trạng thái đơn (field `status` trong danh sách & response thao tác) -> nhãn tiếng Việt.
// Vòng đời: waiting -> exported -> completed.
const STATUS_LABELS = {
  waiting: 'Đã soạn hàng',   // đã soạn, chờ giao (kèm waiting_prepared_at)
  exported: 'Đã giao shipper', // đã xuất cho ĐVVC/shipper
  completed: 'Đã giao hàng',   // đã giao tới khách
};

// `action` GỬI ĐI cho từng nút thao tác. Các giá trị dưới đây lấy từ request thật bắt được
// (DevTools → Payload). LƯU Ý: chữ `action` KHÔNG nhất thiết trùng `status` trả về — luôn đọc
// `status` trong response để biết trạng thái mới. Nếu 1 nút gọi sai, chỉ cần sửa 1 dòng ở đây.
const ACTIONS = {
  prepared: 'exported', // nút "Đã soạn hàng"  (đã xác nhận: action=exported -> status=waiting)
  ship: 'shipped',      // nút "Giao shipper"   (-> status=exported)
  revert: 'waiting',    // nút "Chưa giao hàng" (hoàn tác -> status=waiting)
  complete: 'completed', // nút "Đã giao hàng"  (-> status=completed)
};

// Chi nhánh (tab trên web) -> giá trị field `branch`.
const BRANCHES = { all: '', hanoi: 'ha-noi', hcm: 'ho-chi-minh' };

// ----------------------------------------------------------------------------
// HTTP helper
// ----------------------------------------------------------------------------

/** fetch có timeout (AbortController) — hủy khi web admin chậm/treo thay vì treo vô hạn. */
async function fetchWithTimeout(url, opts = {}) {
  const ms = config.bassoWeb.requestTimeoutMs;
  if (!ms) return fetch(url, { agent: keepAliveAgent, ...opts });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { agent: keepAliveAgent, ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Basso web không phản hồi sau ${ms}ms (timeout)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function baseHeaders() {
  return {
    'Accept': '*/*',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': config.bassoWeb.cookie,
    'Referer': `${config.bassoWeb.baseUrl}/shipping_order/`,
  };
}

/**
 * Ném lỗi rõ ràng khi web admin trả HTML (chưa đăng nhập -> bị redirect về trang login) thay
 * vì JSON — dấu hiệu cookie ci_session hết hạn/sai.
 */
async function parseJsonOrThrow(res, ctx) {
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    if (/<!doctype|<html|login|đăng nhập/i.test(text)) {
      throw new Error(`${ctx}: bị trả HTML (khả năng COOKIE hết hạn/sai -> cập nhật BASSO_WEB_COOKIE).`);
    }
    throw new Error(`${ctx}: response không phải JSON (HTTP ${res.status}).`);
  }
  if (!res.ok || json.error === true) {
    throw new Error(`${ctx}: ${json.message || `HTTP ${res.status}`}`);
  }
  return json;
}

// ----------------------------------------------------------------------------
// Chuẩn hóa
// ----------------------------------------------------------------------------
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtUnix(sec) {
  if (!sec) return '';
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// variations của item có thể là mảng [{name,value}] (đôi khi kèm code) — lọc rỗng.
function parseVariations(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && x.value != null && String(x.value).trim() !== '')
    .map((x) => ({ name: x.name || '', value: x.value || '' }));
}

/** 1 sản phẩm trong đơn giao hàng (items[]) -> shape hiển thị. */
function normalizeItem(it) {
  return {
    id: it.id ?? null,
    orderItemId: it.order_item_id ?? null,
    orderCode: it.order_code || '',        // Mã ĐH (vd SU09072630)
    name: it.name || '',                   // Tên SP
    image: it.image_path || '',            // Ảnh SP
    quantity: it.quantity != null ? num(it.quantity) : null,
    variations: parseVariations(it.variations), // Size/Màu…
    approveUser: it.approve_user || '',    // NV duyệt
    weight: it.item_unit_weight != null ? num(it.item_unit_weight) : null,
    note: it.note || '',
    codValue: num(it.total),               // COD của dòng
  };
}

/** 1 đơn giao hàng (data[]) -> shape nội bộ, map đúng các cột trên web. */
function normalizeShipping(raw) {
  const statusCode = raw.status || '';
  return {
    id: raw.id,                             // order_shipping id — KHÓA để gọi thao tác
    orderId: raw.order_id,
    createdAt: fmtUnix(raw.created_time),   // Ngày tạo vận đơn
    createdTime: raw.created_time,
    recipient: raw.name || '',              // Người nhận
    phone: raw.phone || '',                 // Điện thoại
    address: raw.address || '',             // Địa chỉ
    note: raw.note || '',                   // Ghi chú
    trackingCode: raw.code || '',           // Mã vận đơn
    carrierTrackingId: raw.carrier_tracking_id || '',
    carrierCode: raw.carrier_partner_code || '',   // viettelpost…
    carrierStatus: raw.carrier_status || '',       // mã trạng thái phía ĐVVC
    shipping: raw.shipping || '',           // Tên ĐVVC hiển thị (Viettel Post/AhaMove/Grab…)
    shippingId: raw.shipping_id,            // id ĐVVC (dùng cho bộ lọc)
    codAmount: num(raw.cod_amount),         // Thu COD
    shipFee: num(raw.fee),                  // Phí ship
    shipPayer: raw.ship_payer || '',        // company = "Cty trả"
    weight: num(raw.weight),
    total: num(raw.total),                  // Tổng giá trị đơn
    isPrepared: String(raw.is_prepared) === '1', // đã soạn hàng?
    preparedAt: fmtUnix(raw.waiting_prepared_at), // Thời gian soạn hàng
    branch: raw.branch || '',               // ha-noi / ho-chi-minh
    statusCode,                             // waiting/exported/completed
    status: STATUS_LABELS[statusCode] || statusCode,
    shipperName: raw.shipper_name || '',
    shipperPhone: raw.shipper_phone || '',
    shipperLink: raw.shipper_link || '',
    items: Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [],
  };
}

// ----------------------------------------------------------------------------
// Public
// ----------------------------------------------------------------------------

/**
 * Lấy danh sách đơn giao hàng.
 * @param {object} [filters]
 *   page        {number}  trang (mặc định 1)
 *   shippingId  {number}  lọc theo ĐVVC (0/để trống = tất cả)
 *   status      {string}  all | waiting | exported | completed
 *   userApprove {number}  lọc theo NV duyệt (0 = tất cả)
 *   key         {string}  tìm theo mã đơn/khách/sđt/tên NV
 *   filterDate  {string}  lọc theo ngày tạo, định dạng DD-MM-YYYY
 *   branch      {string}  '' | ha-noi | ho-chi-minh (tab chi nhánh)
 * @returns {Promise<{orders, pagination, hasInventoryManagerRole, source}>}
 */
async function getShippingOrders(filters = {}) {
  if (config.bassoWeb.useMock) {
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(MOCK_FILE, 'utf8')); } catch { /* mock trống */ }
    // Lọc mock cho khớp hành vi thật (đủ để xem giao diện offline).
    if (filters.branch) rows = rows.filter((r) => r.branch === filters.branch);
    if (filters.status && filters.status !== 'all') rows = rows.filter((r) => r.status === filters.status);
    if (filters.shippingId && String(filters.shippingId) !== '0') rows = rows.filter((r) => String(r.shipping_id) === String(filters.shippingId));
    if (filters.key) {
      const k = String(filters.key).toLowerCase();
      rows = rows.filter((r) => `${r.name} ${r.phone} ${r.code}`.toLowerCase().includes(k));
    }
    const orders = rows.map(normalizeShipping);
    return { orders, pagination: { limit: 20, total_item: orders.length, current_page: 1, total_page: 1 }, hasInventoryManagerRole: true, source: 'mock' };
  }
  const url = new URL(`${config.bassoWeb.baseUrl}/shipping_order/`);
  const q = url.searchParams;
  q.set('page', filters.page || 1);
  q.set('shipping_id', filters.shippingId || 0);
  q.set('status', filters.status || 'all');
  q.set('user_approve', filters.userApprove || 0);
  if (filters.key) q.set('key', filters.key);
  if (filters.filterDate) q.set('filter_date', filters.filterDate);
  if (filters.branch) q.set('branch', filters.branch);

  const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: baseHeaders() });
  const json = await parseJsonOrThrow(res, 'getShippingOrders');
  return {
    orders: (json.data || []).map(normalizeShipping),
    pagination: json.pagination || null,
    hasInventoryManagerRole: !!json.has_inventory_manager_role,
    source: 'api',
  };
}

/** Kéo TẤT CẢ trang (gộp lại) cho 1 bộ lọc. Cẩn thận: có thể rất nhiều trang (mỗi trang 20). */
async function getAllShippingOrders(filters = {}, { maxPages = 50 } = {}) {
  const all = [];
  let page = 1;
  let pagination = null;
  // eslint-disable-next-line no-constant-condition
  while (page <= maxPages) {
    // eslint-disable-next-line no-await-in-loop
    const r = await getShippingOrders({ ...filters, page });
    all.push(...r.orders);
    pagination = r.pagination;
    const totalPage = Number(pagination && pagination.total_page) || 1;
    if (page >= totalPage) break;
    page += 1;
  }
  return { orders: all, pagination, source: config.bassoWeb.useMock ? 'mock' : 'api' };
}

/**
 * Đổi trạng thái 1 đơn giao hàng (thao tác cấp thấp — thường dùng qua helper bên dưới).
 * @param {string|number} id     order_shipping id (field `id`)
 * @param {string} action        giá trị action gửi đi (xem ACTIONS)
 * @param {object} [extra]       tham số phụ (vd { shipper_link })
 * @returns {Promise<{ok, status, preparedAt, message}>}
 */
async function shippingAction(id, action, extra = {}) {
  if (!id) throw new Error('shippingAction: thiếu id');
  if (!action) throw new Error('shippingAction: thiếu action');
  if (config.bassoWeb.useMock) return { ok: true, mock: true, status: action };

  const body = new URLSearchParams();
  body.set('action', action);
  body.set('id', String(id));
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') body.set(k, v);
  }
  const res = await fetchWithTimeout(`${config.bassoWeb.baseUrl}/shipping_order/`, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': new URL(config.bassoWeb.baseUrl).origin,
    },
    body: body.toString(),
  });
  const json = await parseJsonOrThrow(res, `shippingAction(${action})`);
  return {
    ok: true,
    status: json.status || '',            // trạng thái MỚI (nguồn sự thật — đừng suy từ action)
    statusLabel: STATUS_LABELS[json.status] || json.status || '',
    preparedAt: json.waiting_prepared_at || null,
    message: json.message || '',
  };
}

// Helper theo nút bấm trên web (đọc tên cho dễ dùng ở tầng trên).
const markPrepared = (id) => shippingAction(id, ACTIONS.prepared);          // "Đã soạn hàng"
const giveToShipper = (id, shipperLink) => shippingAction(id, ACTIONS.ship, shipperLink ? { shipper_link: shipperLink } : {}); // "Giao shipper"
const markCompleted = (id) => shippingAction(id, ACTIONS.complete);         // "Đã giao hàng"
const revertShipping = (id) => shippingAction(id, ACTIONS.revert);          // "Chưa giao hàng"

module.exports = {
  getShippingOrders,
  getAllShippingOrders,
  shippingAction,
  markPrepared,
  giveToShipper,
  markCompleted,
  revertShipping,
  normalizeShipping,
  normalizeItem,
  STATUS_LABELS,
  ACTIONS,
  BRANCHES,
};
