'use strict';
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const config = require('./config');

/**
 * Adapter tới Basso Partner API ("Hàng về VN").
 *
 * Auth 2 lớp:
 *   - Header `X-Partner-Api-Key` cho MỌI request.
 *   - access_token lấy qua POST /partner/login {email, pass} -> data.access_token (kèm expires_at),
 *     gửi kèm header `Authorization: Bearer <token>`. Token được cache & tự login lại khi hết hạn.
 *
 * Mock: nếu chưa cấu hình BASSO_API_BASE_URL (hoặc USE_MOCK=true) => đọc server/mock/orders.json
 * (file mock đã theo đúng shape raw `rows` của API để dùng chung normalizeOrder).
 */

const MOCK_FILE = path.join(__dirname, 'mock', 'orders.json');

// Mã trạng thái API -> nhãn tiếng Việt hiển thị
const STATUS_LABELS = {
  not_sent: 'Chưa báo',
  notified_arrival: 'Đã báo hàng',
  notified_ship: 'Đã báo ship',
  send_failed: 'Gửi lỗi',
  error: 'Lỗi',
};

// ----------------------------------------------------------------------------
// Token cache + HTTP helper
// ----------------------------------------------------------------------------
let _token = null;        // access_token
let _tokenExp = 0;        // unix seconds

function baseHeaders() {
  const h = { 'Accept': 'application/json' };
  if (config.basso.partnerApiKey) h['X-Partner-Api-Key'] = config.basso.partnerApiKey;
  return h;
}

async function login() {
  const res = await fetch(`${config.basso.baseUrl}/partner/login`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.basso.email, pass: config.basso.pass }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false || !json.data || !json.data.access_token) {
    throw new Error(`Login Basso thất bại: ${json.message || res.status} ${JSON.stringify(json.errors || '')}`);
  }
  _token = json.data.access_token;
  // expires_at là unix seconds; nếu không có thì mặc định 1h
  _tokenExp = json.data.expires_at || Math.floor(Date.now() / 1000) + 3600;
  return _token;
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && _tokenExp - now > 60) return _token; // còn > 60s thì dùng lại
  return login();
}

/**
 * Gọi API có xác thực. Tự login & retry 1 lần nếu 401 (token hỏng).
 */
async function apiFetch(pathName, { method = 'GET', query, body, _retried = false } = {}) {
  const token = await getToken();
  const url = new URL(config.basso.baseUrl + pathName);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      ...baseHeaders(),
      'Authorization': `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried) {
    _token = null; // ép login lại
    return apiFetch(pathName, { method, query, body, _retried: true });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`API ${pathName} lỗi: ${json.message || res.status} ${JSON.stringify(json.errors || '')}`);
  }
  return json.data;
}

// ----------------------------------------------------------------------------
// Chuẩn hóa
// ----------------------------------------------------------------------------
function formatUnixDate(sec) {
  if (!sec) return '';
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * 1 sản phẩm trong snapshot "Hàng về VN" (getArrivedVnList?include_items=1
 * hoặc getArrivedVnItems) -> shape nội bộ hiển thị.
 * Field nguồn theo tài liệu Partner API 8.3/8.4.
 */
function normalizeItem(it) {
  return {
    orderCode: it.orderCode || '',                 // Mã ĐH (vd SU01042501)
    orderId: it.order_id ?? null,
    name: it.nameItem || '',                        // Tên SP
    link: it.linkItem || '',                        // Link SP (nếu có)
    image: it.image || '',                          // Ảnh SP (nếu có)
    quantity: it.soLuongVe ?? null,                 // SL về
    weight: it.canNang ?? null,                     // Cân nặng (kg)
    shipFee: it.phiShip ?? null,                    // Phí VC
    shipFeeDomestic: it.phiShipNoiDia ?? null,      // Phí ship nội địa (nếu có)
    shipCode: it.shipCode || '',                    // Mã vận đơn (nếu có)
    shipStatus: it.shipStatus || '',                // Trạng thái giao (nếu có)
  };
}

/** raw row (API hoặc mock) -> shape nội bộ */
function normalizeOrder(raw) {
  const code = raw.status || 'not_sent';
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [];
  return {
    id: String(raw.id),                       // khóa duy nhất để chọn dòng
    customerId: raw.customer_id,
    dateInventory: raw.date_inventory,        // unix — cần cho updateArrivedVnRow
    stt: null,                                // gán theo thứ tự sau khi map
    warehouseDate: formatUnixDate(raw.date_inventory),
    customerName: raw.customer_name || '',
    phone: raw.customer_phone || '',
    noiDungBaoHang: raw.content || '',
    noiDungBaoShip: raw.content_ship || '',
    statusCode: code,
    status: STATUS_LABELS[code] || code,
    note: raw.note || '',
    staff: raw.employee_name || '',
    userId: raw.user_id,
    hasZalo: raw.has_zalo !== false,
    items,                                    // danh sách SP đã về (có thể rỗng)
  };
}

// Chuyển YYYY-MM-DD (input type=date) -> DD-MM-YYYY (API yêu cầu)
function toApiDate(isoDate) {
  if (!isoDate) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : isoDate;
}

// ----------------------------------------------------------------------------
// Public
// ----------------------------------------------------------------------------
function loadMock() {
  return JSON.parse(fs.readFileSync(MOCK_FILE, 'utf8'));
}

/**
 * Lấy danh sách hàng về.
 * @param {object} [filters] { from, to, status, staff(user_id), q, page, pageSize }
 * @returns {Promise<{source, orders, tabUsers, total, page}>}
 */
async function getOrders(filters = {}) {
  const { from, to, status, q } = filters;
  // staff chỉ hợp lệ khi là user_id dạng số; bỏ qua giá trị rác như "Tất cả"
  const staff = /^\d+$/.test(String(filters.staff || '')) ? filters.staff : undefined;
  const page = filters.page || 1;
  const pageSize = Math.min(filters.pageSize || 100, 100);

  if (config.basso.useMock) {
    let rows = loadMock();
    let orders = rows.map(normalizeOrder);
    orders = applyClientFilters(orders, { status, staff, q });
    orders.forEach((o, i) => { o.stt = i + 1; });
    const tabUsers = uniqueStaff(rows);
    return { source: 'mock', orders, tabUsers, total: orders.length, page: 1 };
  }

  const data = await apiFetch('/partner/getArrivedVnList', {
    query: {
      page,
      page_size: pageSize,
      status: status && status !== 'all' ? status : undefined,
      from: toApiDate(from),
      to: toApiDate(to),
      key: q || undefined,
      tab: staff || undefined,
      include_items: 1,                       // gắn danh sách SP vào mỗi dòng
    },
  });

  const rows = data.rows || [];
  const orders = rows.map(normalizeOrder);
  orders.forEach((o, i) => { o.stt = (page - 1) * pageSize + i + 1; });
  const tabUsers = (data.tab_users || []).map((u) => ({ user_id: u.user_id, name: u.name }));
  return { source: 'api', orders, tabUsers, total: data.total ?? orders.length, page: data.page ?? page };
}

function uniqueStaff(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.user_id != null && !map.has(r.user_id)) map.set(r.user_id, { user_id: r.user_id, name: r.employee_name });
  }
  return [...map.values()];
}

function applyClientFilters(orders, { status, staff, q } = {}) {
  return orders.filter((o) => {
    if (status && status !== 'all' && o.statusCode !== status) return false;
    if (staff && String(o.userId) !== String(staff)) return false;
    if (q) {
      const hay = `${o.customerName} ${o.phone}`.toLowerCase();
      if (!hay.includes(String(q).toLowerCase())) return false;
    }
    return true;
  });
}

/**
 * Cập nhật trạng thái + note 1 dòng hàng về (key = customer_id + date_inventory).
 * @param {{customerId:number, dateInventory:number, status:string, note?:string}} p
 */
async function updateOrderStatus({ customerId, dateInventory, status, note }) {
  if (config.basso.useMock) return { ok: true, mock: true, status };
  const data = await apiFetch('/partner/updateArrivedVnRow', {
    method: 'POST',
    body: { customer_id: customerId, date_inventory: dateInventory, status, note },
  });
  return { ok: true, record: data && data.record };
}

module.exports = { getOrders, updateOrderStatus, normalizeOrder, normalizeItem, STATUS_LABELS };
