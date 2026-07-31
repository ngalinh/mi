'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { partnerApiFetch } = require('./bassoApi');

/**
 * Adapter tới nhóm Partner API "Quản lý giao hàng" (basso/shipping_order/) — mục 8.10 tài liệu.
 *
 * Dùng CHUNG Partner API với phần "Hàng về VN": xác thực bằng X-Partner-Api-Key + Bearer
 * (tự login/refresh token qua bassoApi.partnerApiFetch). KHÔNG còn dùng cookie web.
 *
 * Endpoint:
 *   GET  /partner/getShippingOrderMeta                 -> dropdown ĐVVC/status/chi nhánh/NV
 *   GET  /partner/getShippingOrderList                 -> list (data.items) + filter; ?id= chi tiết
 *   GET  /partner/getShippingInvoice?ids=1,2           -> dữ liệu phiếu giao hàng
 *   POST /partner/updateShippingOrder                  -> sửa ĐVVC/mã/phí/COD
 *   POST /partner/markShippingPrepared     {id}        -> Đã soạn hàng
 *   POST /partner/markShippingExported     {id,shipper_link?} -> Giao shipper
 *   POST /partner/markShippingExportedBulk {ids}       -> Giao shipper nhiều
 *   POST /partner/markShippingShipped      {id|ids}    -> Đã giao hàng
 *   POST /partner/revertShippingPrepared   {id}        -> Chưa giao hàng (admin/inventory_manager)
 *
 * Mock: khi Partner API chưa cấu hình (config.basso.useMock) -> đọc server/mock/shipping.json.
 */

const MOCK_FILE = path.join(__dirname, 'mock', 'shipping.json');

// Mã trạng thái vận đơn -> nhãn hiển thị (dùng khi API không trả status_display).
const STATUS_LABELS = {
  waiting: 'Chờ giao hàng',
  waiting_prepared: 'Đã soạn hàng',
  carrier_submitted: 'Lên đơn vận',
  exported: 'Giao shipper',
  completed: 'Đã giao hàng',
};

// ----------------------------------------------------------------------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function fmtUnix(sec) {
  if (!sec) return '';
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseVariations(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && x.value != null && String(x.value).trim() !== '')
    .map((x) => ({ name: x.name || '', value: x.value || '' }));
}

/** 1 SP trong vận đơn -> shape hiển thị (chịu được tên field cả web lẫn partner). */
function normalizeItem(it) {
  return {
    id: it.id ?? null,
    orderCode: it.order_code || it.orderCode || '',
    name: it.name || it.nameItem || '',
    image: it.image_path || it.image || '',
    quantity: it.quantity != null ? num(it.quantity) : (it.soLuongVe != null ? num(it.soLuongVe) : null),
    variations: parseVariations(it.variations),
    approveUser: it.approve_user || '',
    codValue: num(it.cod_amount ?? it.total ?? 0),
  };
}

/** 1 vận đơn (data.items[] / data.record) -> shape nội bộ, map đúng cột trên màn Giao hàng. */
function normalizeShipping(raw) {
  const statusCode = raw.status || '';
  const prepared = raw.is_prepared === 1 || raw.is_prepared === true || String(raw.is_prepared) === '1';
  // Nhãn: ưu tiên status_display của API; nếu không có thì suy ra (waiting + đã soạn -> "Đã soạn hàng").
  let label = raw.status_display || STATUS_LABELS[statusCode] || statusCode;
  if (!raw.status_display && statusCode === 'waiting' && prepared) label = STATUS_LABELS.waiting_prepared;
  return {
    id: raw.id,
    createdAt: fmtUnix(raw.created_time),
    createdTime: raw.created_time,
    recipient: raw.name || '',
    phone: raw.phone || '',
    address: raw.address || '',
    note: raw.note || '',
    trackingCode: raw.code || raw.carrier_tracking_id || '',
    shipping: raw.shipping || '',
    shippingId: raw.shipping_id,
    codAmount: num(raw.cod_amount),
    shipFee: num(raw.fee),
    realShipFee: raw.real_shipping_fee != null ? num(raw.real_shipping_fee) : null,
    shipPayer: raw.ship_payer || 'company',
    shipPayerLabel: raw.ship_payer_display || (raw.ship_payer === 'customer' ? 'Khách trả' : 'Cty trả'),
    weight: num(raw.weight),
    isPrepared: prepared,
    preparedAt: fmtUnix(raw.waiting_prepared_at),
    preparedAtRaw: raw.waiting_prepared_at != null ? num(raw.waiting_prepared_at) : null,
    branch: raw.branch || '',
    statusCode,
    status: label,
    canEdit: raw.can_edit !== false,
    isCarrierSubmitted: !!raw.is_carrier_submitted,
    shipperLink: raw.shipper_link || '',
    carrierCode: raw.carrier_partner_code || '',
    carrierTrackingId: raw.carrier_tracking_id || '',
    items: Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [],
  };
}

// ----------------------------------------------------------------------------
function loadMock() {
  try { return JSON.parse(fs.readFileSync(MOCK_FILE, 'utf8')); } catch { return []; }
}

const MOCK_META = {
  shipping_agencies: [
    { id: 4, name: 'Viettel Post' }, { id: 3, name: 'AhaMove' }, { id: 7, name: 'Grab' }, { id: 8, name: 'Nhận hàng tại VP' },
  ],
  statuses: [
    { code: 'waiting', name: 'Chờ giao hàng' }, { code: 'waiting_prepared', name: 'Đã soạn hàng' },
    { code: 'carrier_submitted', name: 'Lên đơn vận' }, { code: 'exported', name: 'Giao shipper' },
    { code: 'completed', name: 'Đã giao hàng' },
  ],
  branches: [{ code: 'ha-noi', name: 'Hà Nội' }, { code: 'ho-chi-minh', name: 'Hồ Chí Minh' }],
  approve_users: [],
  carrier_integrated_shipping_ids: [2, 4],
  shipper_link_shipping_ids: [3, 7],
  has_inventory_manager_role: true,
  page_size: 20,
};

/** Meta dựng dropdown (ĐVVC / trạng thái / chi nhánh / NV). */
async function getShippingMeta() {
  if (config.basso.useMock) return { ...MOCK_META, source: 'mock' };
  const data = await partnerApiFetch('/partner/getShippingOrderMeta');
  return { ...data, source: 'api' };
}

/**
 * Danh sách vận đơn.
 * @param {object} filters { page, shippingId, status, key, branch, userApprove, filterDate, filterDateEnd }
 */
async function getShippingOrders(filters = {}) {
  if (config.basso.useMock) {
    let rows = loadMock();
    if (filters.branch) rows = rows.filter((r) => r.branch === filters.branch);
    if (filters.status && filters.status !== 'all') {
      rows = rows.filter((r) => (filters.status === 'waiting_prepared'
        ? r.status === 'waiting' && String(r.is_prepared) === '1'
        : r.status === filters.status));
    }
    if (filters.shippingId && String(filters.shippingId) !== '0') rows = rows.filter((r) => String(r.shipping_id) === String(filters.shippingId));
    if (filters.key) {
      const k = String(filters.key).toLowerCase();
      rows = rows.filter((r) => `${r.name} ${r.phone} ${r.code}`.toLowerCase().includes(k));
    }
    const orders = rows.map(normalizeShipping);
    return { orders, total: orders.length, page: 1, pageSize: 20, hasInventoryManagerRole: true, source: 'mock' };
  }
  const query = {
    page: filters.page || 1,
    shipping_id: filters.shippingId || 0,
    status: filters.status || 'all',
    key: filters.key || undefined,
    branch: filters.branch || undefined,
    user_approve: filters.userApprove || undefined,
    filter_date: filters.filterDate || undefined,          // YYYY-MM-DD
    filter_date_end: filters.filterDateEnd || undefined,   // YYYY-MM-DD
  };
  const data = await partnerApiFetch('/partner/getShippingOrderList', { query });
  const items = data.items || data.rows || [];
  return {
    orders: items.map(normalizeShipping),
    total: data.total ?? items.length,
    page: data.page ?? query.page,
    pageSize: data.page_size ?? items.length,
    hasInventoryManagerRole: !!data.has_inventory_manager_role,
    source: 'api',
  };
}

/** Chi tiết 1 vận đơn (kèm items). */
async function getShippingOrder(id) {
  if (config.basso.useMock) {
    const row = loadMock().find((r) => String(r.id) === String(id));
    return row ? normalizeShipping(row) : null;
  }
  const data = await partnerApiFetch('/partner/getShippingOrderList', { query: { id } });
  return data && data.record ? normalizeShipping(data.record) : null;
}

/** Dữ liệu phiếu giao hàng (JSON) cho 1 hoặc nhiều id. */
async function getShippingInvoice(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (config.basso.useMock) {
    const rows = loadMock().filter((r) => list.map(String).includes(String(r.id))).map(normalizeShipping);
    return { invoices: rows, source: 'mock' };
  }
  const data = await partnerApiFetch('/partner/getShippingInvoice', { query: { ids: list.join(',') } });
  return { ...data, source: 'api' };
}

// ---- Thao tác -------------------------------------------------------------
function actionResult(data) {
  const status = (data && data.status) || '';
  return {
    ok: true,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    waitingPreparedAt: (data && data.waiting_prepared_at) ?? null,
    ids: (data && data.ids) || undefined,
    errors: (data && data.errors) || undefined,
  };
}

async function post(pathName, body) {
  if (config.basso.useMock) return actionResult({ status: 'exported', waiting_prepared_at: null });
  return actionResult(await partnerApiFetch(pathName, { method: 'POST', body }));
}

const markPrepared = (id) => post('/partner/markShippingPrepared', { id });
const giveToShipper = (id, shipperLink) => post('/partner/markShippingExported', shipperLink ? { id, shipper_link: shipperLink } : { id });
const markCompleted = (id) => post('/partner/markShippingShipped', { id });
const revertPrepared = (id) => post('/partner/revertShippingPrepared', { id });
const markExportedBulk = (ids) => post('/partner/markShippingExportedBulk', { ids });
const markShippedBulk = (ids) => post('/partner/markShippingShipped', { ids });

/** Sửa vận đơn: { id, shipping_id, code?, fee?, cod_amount? }. */
async function updateShippingOrder(payload) {
  if (config.basso.useMock) return { ok: true, mock: true };
  const data = await partnerApiFetch('/partner/updateShippingOrder', { method: 'POST', body: payload });
  return { ok: true, record: data && data.record ? normalizeShipping(data.record) : null };
}

module.exports = {
  getShippingMeta,
  getShippingOrders,
  getShippingOrder,
  getShippingInvoice,
  updateShippingOrder,
  markPrepared,
  giveToShipper,
  markCompleted,
  revertPrepared,
  markExportedBulk,
  markShippedBulk,
  normalizeShipping,
  normalizeItem,
  STATUS_LABELS,
};
