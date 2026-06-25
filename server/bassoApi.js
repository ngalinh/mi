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
let _loginPromise = null; // lần login đang chạy (single-flight) — gộp các request đồng thời

function baseHeaders() {
  const h = { 'Accept': 'application/json' };
  if (config.basso.partnerApiKey) h['X-Partner-Api-Key'] = config.basso.partnerApiKey;
  return h;
}

/**
 * fetch có timeout (AbortController). Nếu upstream Basso chậm/treo, hủy sau
 * requestTimeoutMs và ném lỗi rõ ràng thay vì để request treo vô thời hạn.
 */
async function fetchWithTimeout(url, opts = {}) {
  const ms = config.basso.requestTimeoutMs;
  if (!ms) return fetch(url, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Basso không phản hồi sau ${ms}ms (timeout) — thử lại sau`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  // Theo tài liệu Partner API: /partner/login dùng application/x-www-form-urlencoded
  // (KHÔNG phải JSON). Backend PHP đọc $this->input->post(); gửi JSON sẽ làm email/pass
  // rỗng -> "Đăng nhập thất bại". Vì vậy phải gửi form-urlencoded.
  const form = new URLSearchParams();
  form.set('email', config.basso.email);
  form.set('pass', config.basso.pass);
  const res = await fetchWithTimeout(`${config.basso.baseUrl}/partner/login`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
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
  // SINGLE-FLIGHT: nhiều request đồng thời (vd /api/orders + 5 lần đếm của /api/order-counts)
  // khi token chưa có sẽ CHIA SẺ một lần login, tránh đăng nhập 6 lần cùng lúc -> Basso quá tải/timeout.
  if (_loginPromise) return _loginPromise;
  _loginPromise = login().finally(() => { _loginPromise = null; });
  return _loginPromise;
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
  const res = await fetchWithTimeout(url.toString(), {
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// variationsItem là CHUỖI JSON (vd '[{"name":"Color","value":"RED"}]'); parse an toàn.
function parseVariations(v) {
  let arr = v;
  if (typeof v === 'string') {
    if (!v.trim()) return [];
    try { arr = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && (x.value != null && String(x.value).trim() !== ''))
    .map((x) => ({ name: x.name || '', value: x.value || '' }));
}

/**
 * 1 sản phẩm "Hàng về VN" (getArrivedVnItems / get_vn_wasehouse_items) -> shape hiển thị.
 * Tên field thô xác nhận từ response thật: orderCode, order_id, nameItem, linkItem, image,
 * variationsItem(JSON string), soLuongVe, tongsanpham, tongsanphamDaVe, canNang, phiShip,
 * phiShipNoiDia, price, term_fee, currency_rate, currency_symbol, shipCode, shipStatus, shipped_time.
 */
function normalizeItem(it) {
  const price = num(it.price);                       // Giá sp (ngoại tệ)
  const rate = num(it.currency_rate);                // tỷ giá -> VND
  const shipFee = Math.round(num(it.phiShip));       // Phí VC (VND)
  const termFee = Math.round(num(it.term_fee));      // Phụ thu (VND)
  // Tổng giá (VND) = giá quy đổi + phí VC + phụ thu (khớp cách web tính)
  const totalVnd = Math.round(price * rate) + shipFee + termFee;
  return {
    orderCode: it.orderCode || '',                   // Mã ĐH
    orderId: it.order_id ?? null,
    name: it.nameItem || '',                          // Tên SP
    link: it.linkItem || '',                          // Link SP
    image: it.image || '',                            // Ảnh SP
    variations: parseVariations(it.variationsItem),   // Size/Màu: [{name,value}]
    quantity: it.soLuongVe ?? null,                   // SL về
    arrivedQty: it.tongsanphamDaVe ?? null,           // đã về (x)
    totalQty: it.tongsanpham ?? null,                 // tổng (y) -> "x/y"
    weight: it.canNang != null ? num(it.canNang) : null, // Cân nặng (kg)
    shipFee,                                          // Phí VC (VND)
    shipFeeDomestic: Math.round(num(it.phiShipNoiDia)),
    priceValue: price,                                // Giá sp (số)
    currencySymbol: it.currency_symbol || '$',
    currencyRate: rate,
    termFee,                                          // Phụ thu (VND)
    totalVnd,                                         // Tổng giá (VND)
    shipCode: it.shipCode || '',                      // Mã vận đơn
    shipStatusLabel: it.shipped_time ? 'Đã giao' : 'Chưa giao',
    shippedDate: it.shipped_time ? formatUnixDate(it.shipped_time) : '',
  };
}

/** raw row (API hoặc mock) -> shape nội bộ (KHÔNG kèm items — items load lazy qua getArrivedItems) */
function normalizeOrder(raw) {
  const code = raw.status || 'not_sent';
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

// Cache danh sách hàng về trong RAM (TTL ngắn). Tránh gọi lại Basso cho mỗi lần
// auto-sync / đổi tab / gõ tìm kiếm lặp lại. Key = bộ lọc đã chuẩn hóa.
const _listCache = new Map(); // key -> { at:number, data:object }

function listCacheGet(key) {
  const ttl = config.basso.listCacheTtlMs;
  if (!ttl) return null;
  const hit = _listCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (hit) _listCache.delete(key);
  return null;
}
function listCacheSet(key, data) {
  if (!config.basso.listCacheTtlMs) return;
  _listCache.set(key, { at: Date.now(), data });
}
/** Xóa cache danh sách — gọi sau khi dữ liệu đổi (cập nhật trạng thái/ghi chú). */
function invalidateOrdersCache() {
  _listCache.clear();
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
    const rows = loadMock();
    let orders = rows.map(normalizeOrder);
    orders = applyClientFilters(orders, { status, staff, q });
    const total = orders.length;
    // Phân trang phía "server" cho cả mock để khớp hành vi API thật (Hướng B).
    const startIdx = (page - 1) * pageSize;
    orders = orders.slice(startIdx, startIdx + pageSize);
    orders.forEach((o, i) => { o.stt = startIdx + i + 1; });
    const tabUsers = uniqueStaff(rows);
    return { source: 'mock', orders, tabUsers, total, page };
  }

  const query = {
    page,
    page_size: pageSize,
    status: status && status !== 'all' ? status : undefined,
    from: toApiDate(from),
    to: toApiDate(to),
    key: q || undefined,
    tab: staff || undefined,
  };

  const cacheKey = JSON.stringify(query);
  const cached = listCacheGet(cacheKey);
  if (cached) return { ...cached, source: 'api-cache' };

  const data = await apiFetch('/partner/getArrivedVnList', { query });

  const rows = data.rows || [];
  const orders = rows.map(normalizeOrder);
  orders.forEach((o, i) => { o.stt = (page - 1) * pageSize + i + 1; });
  const tabUsers = (data.tab_users || []).map((u) => ({ user_id: u.user_id, name: u.name }));
  const result = { source: 'api', orders, tabUsers, total: data.total ?? orders.length, page: data.page ?? page };
  listCacheSet(cacheKey, result);
  return result;
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
 * Lấy chi tiết sản phẩm đã về của 1 dòng (load lazy khi mở rộng).
 * Key: id HOẶC (customerId + dateInventory). Dùng /partner/getArrivedVnItems.
 * @param {{id?:string|number, customerId?:number, dateInventory?:number}} p
 * @returns {Promise<{source, items}>}
 */
async function getArrivedItems({ id, customerId, dateInventory } = {}) {
  if (config.basso.useMock) {
    const rows = loadMock();
    const row = rows.find((r) =>
      (id != null && id !== '' && String(r.id) === String(id)) ||
      (customerId != null && dateInventory != null &&
        String(r.customer_id) === String(customerId) &&
        String(r.date_inventory) === String(dateInventory)));
    const items = row && Array.isArray(row.items) ? row.items.map(normalizeItem) : [];
    return { source: 'mock', items };
  }
  const data = await apiFetch('/partner/getArrivedVnItems', {
    query: { id, customer_id: customerId, date_inventory: dateInventory },
  });
  const items = (data && Array.isArray(data.items) ? data.items : []).map(normalizeItem);
  return { source: 'api', items };
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
  invalidateOrdersCache(); // dữ liệu đã đổi -> bỏ cache để lần load sau lấy mới
  return { ok: true, record: data && data.record };
}

// Nhóm trạng thái trên dashboard -> mã trạng thái Basso (để đếm & lọc server-side).
const GROUP_STATUS = [
  ['todo', 'not_sent'],
  ['arrival', 'notified_arrival'],
  ['ship', 'notified_ship'],
  ['failed', 'send_failed'],
];

/**
 * Đếm số đơn theo từng nhóm trạng thái (tổng THẬT trên toàn bộ dữ liệu, không phải
 * chỉ trang hiện tại) + danh sách nhân viên đầy đủ. Dùng cho 4 thẻ trạng thái khi
 * phân trang server-side (Hướng B).
 * @param {object} [filters] { from, to, staff, q }
 * @returns {Promise<{counts:{todo,arrival,ship,failed,total}, tabUsers}>}
 */
async function getStatusCounts(filters = {}) {
  const { from, to, q } = filters;
  const staff = /^\d+$/.test(String(filters.staff || '')) ? filters.staff : undefined;

  if (config.basso.useMock) {
    const rows = loadMock();
    const orders = applyClientFilters(rows.map(normalizeOrder), { staff, q });
    const counts = { todo: 0, arrival: 0, ship: 0, failed: 0, total: orders.length };
    for (const o of orders) {
      if (o.statusCode === 'not_sent') counts.todo += 1;
      else if (o.statusCode === 'notified_arrival') counts.arrival += 1;
      else if (o.statusCode === 'notified_ship') counts.ship += 1;
      else if (o.statusCode === 'send_failed' || o.statusCode === 'error') counts.failed += 1;
    }
    return { counts, tabUsers: uniqueStaff(rows) };
  }

  const base = {
    from: toApiDate(from), to: toApiDate(to), key: q || undefined, tab: staff || undefined,
    page: 1, page_size: 1,
  };
  const cacheKey = 'counts:' + JSON.stringify(base);
  const cached = listCacheGet(cacheKey);
  if (cached) return cached;

  // Login MỘT LẦN trước khi bắn loạt -> 5 request bên dưới chỉ tái dùng token, không tự login.
  await getToken();
  // 1 lần gọi "tất cả" (lấy total + tab_users đầy đủ) + 4 lần theo từng status.
  // page_size=1 nên rất nhẹ; chạy song song để giảm độ trễ.
  const [allData, ...statusData] = await Promise.all([
    apiFetch('/partner/getArrivedVnList', { query: base }),
    ...GROUP_STATUS.map(([, code]) => apiFetch('/partner/getArrivedVnList', { query: { ...base, status: code } })),
  ]);
  const counts = { total: allData.total ?? 0, todo: 0, arrival: 0, ship: 0, failed: 0 };
  GROUP_STATUS.forEach(([group], i) => { counts[group] = statusData[i].total ?? 0; });
  const tabUsers = (allData.tab_users || []).map((u) => ({ user_id: u.user_id, name: u.name }));
  const result = { counts, tabUsers };
  listCacheSet(cacheKey, result);
  return result;
}

/**
 * Kéo TẤT CẢ đơn khớp bộ lọc qua mọi trang (gộp lại). Dùng cho "Báo hàng loạt" để
 * không bị giới hạn ở trang đang xem. Lặp tối đa 100 trang × 100 đơn (an toàn).
 * @param {object} [filters] { status, from, to, staff, q }
 */
async function fetchAllOrders(filters = {}) {
  if (config.basso.useMock) {
    // Mock nhỏ: lấy 1 "trang" rất lớn là đủ toàn bộ.
    const { orders } = await getOrders({ ...filters, page: 1, pageSize: 100 });
    return orders;
  }
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { orders, total } = await getOrders({ ...filters, page, pageSize: 100 });
    for (const o of orders) {
      if (!seen.has(o.id)) { seen.add(o.id); all.push(o); }
    }
    if (orders.length < 100) break;                 // hết trang
    if (total != null && all.length >= total) break; // đã đủ
  }
  return all;
}

module.exports = { getOrders, getStatusCounts, fetchAllOrders, getArrivedItems, updateOrderStatus, invalidateOrdersCache, normalizeOrder, normalizeItem, STATUS_LABELS };
