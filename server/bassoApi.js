'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const fetch = require('node-fetch');
const config = require('./config');

// Giữ kết nối (keep-alive) tới Basso: tái dùng TCP/TLS cho các call liên tiếp/đồng thời
// (mỗi lần load dashboard có ~6 call) thay vì bắt tay lại từ đầu -> giảm độ trễ rõ rệt.
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const keepAliveAgent = (parsedURL) => (parsedURL.protocol === 'https:' ? _httpsAgent : _httpAgent);

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
async function fetchWithTimeout(url, opts = {}, _attempt = 1) {
  const ms = config.basso.requestTimeoutMs;
  if (!ms) return fetch(url, { agent: keepAliveAgent, ...opts });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { agent: keepAliveAgent, ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (_attempt < 2) {
        // Retry 1 lần sau 1s trước khi báo lỗi
        await new Promise((r) => setTimeout(r, 1000));
        return fetchWithTimeout(url, opts, _attempt + 1);
      }
      throw new Error(`Basso không phản hồi sau ${ms}ms (timeout) — thử lại sau`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Đo thời gian 1 call Basso (chỉ log khi BASSO_LOG_TIMING=true) — để biết chậm do mạng hay do Basso.
async function timed(label, fn) {
  if (!config.basso.logTiming) return fn();
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[basso] ${label} ${Date.now() - t0}ms`);
  }
}

async function login() {
  // Theo tài liệu Partner API: /partner/login dùng application/x-www-form-urlencoded
  // (KHÔNG phải JSON). Backend PHP đọc $this->input->post(); gửi JSON sẽ làm email/pass
  // rỗng -> "Đăng nhập thất bại". Vì vậy phải gửi form-urlencoded.
  const form = new URLSearchParams();
  form.set('email', config.basso.email);
  form.set('pass', config.basso.pass);
  const res = await timed('login', () => fetchWithTimeout(`${config.basso.baseUrl}/partner/login`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }));
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
  const res = await timed(pathName, () => fetchWithTimeout(url.toString(), {
    method,
    headers: {
      ...baseHeaders(),
      'Authorization': `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }));

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
  // `id` từ Basso không phải lúc nào cũng có/duy nhất (có thể thiếu, rỗng hoặc = 0 cho mọi
  // dòng). Khoá ổn định thật sự của 1 dòng là (customer_id + date_inventory) — dùng nó làm
  // fallback để MỖI dòng luôn có id duy nhất. Nếu không, nhiều dòng trùng id khiến client
  // chọn nhầm dòng (vd nút "Xem nội dung" mở modal của dòng khác / rỗng).
  const rawId = raw.id != null && String(raw.id).trim() !== '' && String(raw.id) !== '0'
    ? String(raw.id)
    : '';
  return {
    id: rawId || `c${raw.customer_id}-${raw.date_inventory}`, // khóa duy nhất để chọn dòng
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

/**
 * Cửa sổ ngày mặc định (server-side) — GIẢM TẢI cold-load: chỉ kéo đơn trong N ngày gần đây
 * thay vì all-time (ít trang hơn -> Basso quét ít hơn -> nhanh hơn). Danh sách + số đếm +
 * preload cùng gọi hàm này nên DÙNG CHUNG cache key (ổn định trong ngày).
 *
 * QUAN TRỌNG: chỉ áp dụng khi caller YÊU CẦU rõ (truyền `days` > 0) và KHÔNG kèm from/to.
 * Các luồng nền (auto-notify/báo hàng loạt) KHÔNG truyền `days` -> vẫn quét all-time để
 * không bỏ sót đơn "Chưa báo" cũ hơn N ngày.
 * @param {{from?:string, to?:string, days?:number|string}} f
 * @returns {{from?:string, to?:string}} YYYY-MM-DD
 */
function resolveDateWindow({ from, to, days } = {}) {
  if (from || to) return { from, to };                 // ngày tường minh -> ưu tiên, bỏ qua days
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return { from, to }; // 0/không hợp lệ -> all-time
  const now = new Date();
  const start = new Date(now.getTime() - d * 86400000);
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: iso(start), to: iso(now) };
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
const _inflight = new Map();  // key -> Promise đang gọi Basso (single-flight theo key)

/**
 * Stale-while-revalidate: vì mỗi call Basso ~vài giây, ta trả cache NGAY cả khi đã hết
 * hạn rồi làm mới ở NỀN. Nhờ vậy quay lại 1 view đã xem (đổi tab/lật lại trang/auto-sync)
 * gần như tức thì; chỉ lần ĐẦU TIÊN (chưa có cache) mới phải đợi Basso.
 * @returns {Promise<{data:object, source:'api'|'api-cache'|'api-stale'}>}
 */
async function swrFetch(cacheKey, ttl, fetchFn) {
  if (!config.basso.listCacheTtlMs) return { data: await fetchFn(), source: 'api' }; // cache tắt
  const refresh = () => {
    if (_inflight.has(cacheKey)) return _inflight.get(cacheKey);
    const p = (async () => {
      const data = await fetchFn();
      _listCache.set(cacheKey, { at: Date.now(), data });
      return data;
    })().finally(() => _inflight.delete(cacheKey));
    _inflight.set(cacheKey, p);
    return p;
  };
  const hit = _listCache.get(cacheKey);
  if (hit) {
    const fresh = Date.now() - hit.at < ttl;
    if (!fresh) refresh().catch(() => {}); // hết hạn -> làm mới nền; lỗi thì vẫn giữ bản cũ
    return { data: hit.data, source: fresh ? 'api-cache' : 'api-stale' };
  }
  return { data: await refresh(), source: 'api' }; // chưa có cache -> phải đợi (đường chậm)
}

/**
 * Sau khi dữ liệu đổi (cập nhật trạng thái/ghi chú): KHÔNG xoá sạch cache — vì xoá sạch làm
 * lần mở dashboard KẾ TIẾP luôn "cold" (phải đợi Basso vài giây), mà shop cập nhật liên tục
 * (báo tay + auto-notify) nên gần như lúc nào cũng cold. Thay vào đó ĐÁNH DẤU STALE (at=0):
 * SWR trả bản cũ TỨC THÌ rồi tự làm mới ở nền.
 *
 * Nếu biết đúng dòng vừa đổi (patch), sửa luôn statusCode/note của nó trong MỌI list đã cache
 * để bản "stale" hiển thị đã đúng ngay (chờ nền làm mới phần còn lại: số đếm, list lọc theo
 * status). Không truyền patch -> chỉ đánh dấu stale toàn bộ.
 * @param {{customerId?:number|string, dateInventory?:number|string, status?:string, note?:string}} [patch]
 */
function invalidateOrdersCache(patch) {
  const hasKey = patch && patch.customerId != null && patch.dateInventory != null;
  for (const entry of _listCache.values()) {
    if (hasKey && entry.data && Array.isArray(entry.data.orders)) {
      for (const o of entry.data.orders) {
        if (String(o.customerId) === String(patch.customerId) &&
            String(o.dateInventory) === String(patch.dateInventory)) {
          if (patch.status) { o.statusCode = patch.status; o.status = STATUS_LABELS[patch.status] || patch.status; }
          if (patch.note !== undefined) o.note = patch.note;
        }
      }
    }
    entry.at = 0; // stale -> lần đọc kế tiếp trả ngay + làm mới nền (không bắt người dùng đợi)
  }
}

/**
 * Lấy danh sách hàng về.
 * @param {object} [filters] { from, to, status, staff(user_id), q, page, pageSize }
 * @returns {Promise<{source, orders, tabUsers, total, page}>}
 */
async function getOrders(filters = {}) {
  const { status, q } = filters;
  const { from, to } = resolveDateWindow(filters); // cửa sổ ngày mặc định khi có `days`
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
  const { data, source } = await swrFetch(cacheKey, config.basso.listCacheTtlMs, async () => {
    const raw = await apiFetch('/partner/getArrivedVnList', { query });
    const rows = raw.rows || [];
    const orders = rows.map(normalizeOrder);
    orders.forEach((o, i) => { o.stt = (page - 1) * pageSize + i + 1; });
    const tabUsers = (raw.tab_users || []).map((u) => ({ user_id: u.user_id, name: u.name }));
    return { orders, tabUsers, total: raw.total ?? orders.length, page: raw.page ?? page };
  });
  return { ...data, source };
}

/** Chạy fn cho từng item với GIỚI HẠN concurrency (giữ thứ tự kết quả). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx; idx += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Kéo TOÀN BỘ đơn (mọi trạng thái, mọi nhân viên) trong 1 khoảng ngày để dashboard lọc
 * client-side (đổi tab NV/trạng thái/trang/tìm kiếm -> tức thì, không round-trip). Kết quả
 * cache SWR theo {from,to} nên auto-sync/reload/người dùng khác vào sau ăn cache ấm.
 *
 * Nếu tổng > config.basso.clientMaxOrders -> trả { truncated:true } kèm DUY NHẤT trang đầu,
 * để client tự fallback về phân trang server (không kéo nặng làm chậm/treo).
 * @param {object} [filters] { from, to }
 * @returns {Promise<{source, orders, tabUsers, total, truncated}>}
 */
async function getAllOrders(filters = {}) {
  const { from, to } = filters;

  if (config.basso.useMock) {
    const rows = loadMock();
    const orders = rows.map(normalizeOrder);
    orders.forEach((o, i) => { o.stt = i + 1; });
    return { source: 'mock', orders, tabUsers: uniqueStaff(rows), total: orders.length, truncated: false };
  }

  const apiFrom = toApiDate(from);
  const apiTo = toApiDate(to);
  const PAGE = 100;
  const cacheKey = 'all:' + JSON.stringify({ from: apiFrom, to: apiTo });

  const fetchFn = async () => {
    // Login MỘT LẦN trước khi bắn loạt -> các trang sau tái dùng token, không tự login.
    await getToken();
    const base = { page_size: PAGE, from: apiFrom, to: apiTo };
    const first = await apiFetch('/partner/getArrivedVnList', { query: { ...base, page: 1 } });
    const rows = (first.rows || []).slice();
    const total = first.total ?? rows.length;
    const max = config.basso.clientMaxOrders;
    if (max && total > max) {
      // Quá lớn -> không kéo hết; client sẽ fallback về phân trang server.
      const orders = rows.map(normalizeOrder);
      orders.forEach((o, i) => { o.stt = i + 1; });
      return { orders, tabUsers: uniqueStaff(rows), total, truncated: true };
    }
    const lastPage = Math.min(Math.ceil(total / PAGE), 100);
    if (lastPage > 1) {
      const restPages = [];
      for (let p = 2; p <= lastPage; p += 1) restPages.push(p);
      // Kéo song song (config.basso.pageConcurrency, mặc định 8) — nhanh hơn tuần tự nhiều;
      // dial về 4 qua BASSO_PAGE_CONCURRENCY nếu Basso quá tải.
      const restRows = await mapLimit(restPages, config.basso.pageConcurrency || 8, async (p) => {
        const d = await apiFetch('/partner/getArrivedVnList', { query: { ...base, page: p } });
        return d.rows || [];
      });
      for (const r of restRows) rows.push(...r);
    }
    const orders = rows.map(normalizeOrder);
    orders.forEach((o, i) => { o.stt = i + 1; });
    return { orders, tabUsers: uniqueStaff(rows), total, truncated: false };
  };

  if (!config.basso.listCacheTtlMs) return { ...(await fetchFn()), source: 'api' };
  const { data, source } = await swrFetch(cacheKey, config.basso.listCacheTtlMs, fetchFn);
  return { ...data, source };
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
  const cacheKey = 'items:' + JSON.stringify({ id, customerId, dateInventory });
  const { data, source } = await swrFetch(cacheKey, config.basso.listCacheTtlMs, async () => {
    const raw = await apiFetch('/partner/getArrivedVnItems', {
      query: { id, customer_id: customerId, date_inventory: dateInventory },
    });
    const items = (raw && Array.isArray(raw.items) ? raw.items : []).map(normalizeItem);
    return { items };
  });
  return { source, ...data };
}

/**
 * Lấy RIÊNG nội dung báo hàng/ship của 1 đơn — FRESH, KHÔNG qua cache SWR.
 *
 * Dùng cho nút "Xem/Tải nội dung": khi danh sách (đã cache) chưa có `content` — vd Basso vừa
 * soạn ND sau khi mi đã cache list, hoặc list trả thiếu content — thì lấy trực tiếp của đúng đơn.
 * Thu hẹp getArrivedVnList theo SĐT khách (key) để chỉ kéo vài dòng, rồi khớp đúng dòng bằng
 * (customer_id + date_inventory). Chỉ đọc, không đổi dữ liệu.
 * @param {{customerId:number|string, dateInventory:number|string, phone?:string}} p
 * @returns {Promise<{source, found:boolean, noiDungBaoHang:string, noiDungBaoShip:string}>}
 */
async function getOrderContent({ customerId, dateInventory, phone } = {}) {
  const pick = (row) => ({
    found: !!row,
    noiDungBaoHang: (row && row.content) || '',
    noiDungBaoShip: (row && row.content_ship) || '',
  });
  const matches = (r) =>
    String(r.customer_id) === String(customerId) &&
    String(r.date_inventory) === String(dateInventory);

  if (config.basso.useMock) {
    return { source: 'mock', ...pick(loadMock().find(matches)) };
  }
  // key = SĐT -> Basso trả về ít dòng; KHÔNG qua swrFetch nên luôn lấy bản mới nhất.
  const raw = await apiFetch('/partner/getArrivedVnList', {
    query: { page: 1, page_size: 100, key: phone || undefined },
  });
  const rows = raw.rows || [];
  // Khớp chính xác theo (customer_id + date_inventory); nếu lệch kiểu date mà chỉ có đúng 1
  // dòng trả về (đã lọc theo SĐT) thì lấy dòng đó làm fallback.
  const row = rows.find(matches) || (rows.length === 1 ? rows[0] : null);
  return { source: 'api', ...pick(row) };
}

/**
 * DEBUG (read-only): lấy raw rows THẬT từ /partner/getArrivedVnList, BỎ QUA cache SWR,
 * để soi đúng field thô Basso trả về (có `content`/`content_ship` không, rỗng hay tên khác).
 * Dùng chẩn đoán "ND báo hàng có ở web nhưng mi không hiện": xem API list có kèm nội dung không.
 * @param {{q?:string, from?:string, to?:string, status?:string, limit?:number}} p
 */
async function debugRawRows({ q, from, to, status, limit = 5 } = {}) {
  if (config.basso.useMock) {
    const rows = loadMock();
    return { source: 'mock', total: rows.length, sampleKeys: Object.keys(rows[0] || {}), rows: rows.slice(0, limit) };
  }
  const query = {
    page: 1,
    page_size: Math.min(limit || 5, 100),
    status: status && status !== 'all' ? status : undefined,
    from: toApiDate(from),
    to: toApiDate(to),
    key: q || undefined,
  };
  const raw = await apiFetch('/partner/getArrivedVnList', { query }); // KHÔNG qua swrFetch
  const rows = raw.rows || [];
  // Lộ khóa định danh của TỪNG dòng để chẩn đoán "trùng khóa": nếu nhiều đơn cùng khách trả về
  // cùng `_key` (do Basso thiếu/trùng `id` -> mi rơi về c<customer_id>-<date_inventory>), mi sẽ
  // GỘP thành 1 dòng và chỉ giữ dòng ĐẦU (có thể là dòng content rỗng) -> nội dung ở dòng anh em
  // bị che. `_key` là đúng khóa mi dùng (normalizeOrder.id).
  const keyCount = new Map();
  rows.forEach((r) => { const k = normalizeOrder(r).id; keyCount.set(k, (keyCount.get(k) || 0) + 1); });
  const slim = rows.slice(0, limit).map((r) => {
    const norm = normalizeOrder(r);
    return {
      _key: norm.id,                 // ← khóa mi dùng để phân biệt dòng
      _keyDup: keyCount.get(norm.id), // ← >1 nghĩa là TRÙNG khóa (bị gộp trên mi)
      id: r.id,                       // id thô Basso (null/0/'' -> sinh trùng khóa)
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      date_inventory: r.date_inventory,
      warehouseDate: norm.warehouseDate,
      status: r.status,
      _hasContent: !!(r.content && String(r.content).trim()),
      content_preview: r.content ? String(r.content).slice(0, 45) : null,
    };
  });
  return { source: 'api', total: raw.total ?? rows.length, sampleKeys: Object.keys(rows[0] || {}), rows: slim };
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
  // Đánh dấu stale + patch đúng dòng vừa đổi -> lần load sau hiện NGAY (không cold), đã đúng trạng thái.
  invalidateOrdersCache({ customerId, dateInventory, status, note });
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
  const { q } = filters;
  const { from, to } = resolveDateWindow(filters); // cùng cửa sổ ngày với getOrders -> số đếm khớp danh sách
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
  // Số đếm đổi chậm -> cache lâu hơn danh sách (tối thiểu 90s). SWR: quay lại tức thì, làm mới nền.
  const countsTtl = Math.max(config.basso.listCacheTtlMs, 90000);
  const cacheKey = 'counts:' + JSON.stringify(base);
  const { data } = await swrFetch(cacheKey, countsTtl, async () => {
    // Login MỘT LẦN trước khi bắn loạt -> 4 request bên dưới chỉ tái dùng token, không tự login.
    await getToken();
    // 4 call song song, mỗi call lọc theo 1 status (page_size=1 -> rất nhẹ).
    // Bỏ call "tất cả" vì tab_users đã có từ /api/orders và total = tổng 4 nhóm.
    const statusData = await Promise.all(
      GROUP_STATUS.map(([, code]) => apiFetch('/partner/getArrivedVnList', { query: { ...base, status: code } })),
    );
    const counts = { todo: 0, arrival: 0, ship: 0, failed: 0 };
    GROUP_STATUS.forEach(([group], i) => { counts[group] = statusData[i].total ?? 0; });
    counts.total = counts.todo + counts.arrival + counts.ship + counts.failed;
    return { counts };
  });
  return data;
}

/**
 * Lấy danh sách nhân viên (tab_users) không lọc theo status — để tab staff luôn đầy đủ.
 * Cache lâu (5 phút) vì danh sách NV ít thay đổi.
 */
async function getTabUsers() {
  if (config.basso.useMock) {
    const rows = loadMock();
    return { tabUsers: uniqueStaff(rows) };
  }
  const cacheKey = 'tabUsers';
  const ttl = Math.max(config.basso.listCacheTtlMs, 300000); // tối thiểu 5 phút
  const { data } = await swrFetch(cacheKey, ttl, async () => {
    const raw = await apiFetch('/partner/getArrivedVnList', { query: { page: 1, page_size: 1 } });
    const tabUsers = (raw.tab_users || []).map((u) => ({ user_id: u.user_id, name: u.name }));
    return { tabUsers };
  });
  return data;
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

module.exports = { getOrders, getAllOrders, getStatusCounts, getTabUsers, fetchAllOrders, getArrivedItems, getOrderContent, updateOrderStatus, invalidateOrdersCache, debugRawRows, normalizeOrder, normalizeItem, STATUS_LABELS };
