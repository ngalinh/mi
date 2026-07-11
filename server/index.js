'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { getOrders, getAllOrders, getStatusCounts, getTabUsers, fetchAllOrders, getArrivedItems, getOrderContent, updateOrderStatus, debugRawRows } = require('./bassoApi');
const { listReports, reportFacets, stats, getReportById, getAutoRecord, getAutoMap, getSentTimesMap, getLastReportMap, getDelayedMap, setDelayed,
  getFbRouting, setFbRouting,
  listStaff, getStaffByEmail, upsertStaff, deleteStaff, staffCount, activeAdminCount, normEmail,
  listZaloContacts, zaloContactsCount, upsertZaloContact, importZaloContacts, deleteZaloContact, getZaloMap, normPhone } = require('./db');
const { notifyMany, notifyOrders } = require('./notifyService');
const { getLocalHealth, effectiveBaseUrl, forwardAccounts, invalidateAccountsCache, getAccountsCached } = require('./playwrightProxy');
const localRegistry = require('./localRegistry');
const autoNotify = require('./autoNotify');
const cacheWarmer = require('./cacheWarmer');

const app = express();
// GZIP mọi response JSON. Payload nặng nhất là /api/orders/all (toàn bộ đơn all-time, có thể
// vài MB) — nén giảm mạnh thời gian truyền qua gateway, lợi cả cold load lẫn mỗi lần auto-sync.
// Guard require: nếu môi trường chưa cài `compression` thì bỏ qua (không chặn server chạy).
try {
  // eslint-disable-next-line global-require
  const compression = require('compression');
  app.use(compression());
} catch (_) {
  console.warn('[perf] gzip TẮT (chưa cài `compression` — chạy `npm install` để bật)');
}
// CORS: mặc định mở (gateway ai.basso.vn là lối vào duy nhất). Đặt CORS_ORIGIN để siết.
app.use(config.corsOrigins.length ? cors({ origin: config.corsOrigins }) : cors());
app.use(express.json({ limit: '5mb' }));

// Đọc email từ cookie platform_token do ai.basso.vn set (base64 JSON: {u, exp, sig, r}).
function getEmailFromPlatformCookie(req) {
  const cookieHeader = req.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)platform_token=([^;]+)/);
  if (!match) return null;
  try {
    const obj = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (obj.exp && obj.exp < Date.now()) return null; // hết hạn
    return (obj.u && String(obj.u).trim()) || null;
  } catch (_) { return null; }
}

// Audit: lấy danh tính nhân viên — thử cookie platform_token trước, rồi mới header gateway.
// null = không rõ (vd gọi thẳng app, bỏ qua gateway).
function getActor(req) {
  const fromCookie = getEmailFromPlatformCookie(req);
  if (fromCookie) return fromCookie;
  for (const h of config.auth.userHeaders) {
    const v = req.get(h);
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

// So sánh chuỗi bí mật theo thời gian hằng định (chống dò theo timing). Khác độ dài -> false.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
// Tắt cache asset tĩnh (dev): tránh trình duyệt giữ JS/CSS cũ sau khi sửa code.
// Riêng file .html (nhất là trang "/" = index.html): dùng BỘ header chống cache đầy đủ
// (no-store + no-cache + must-revalidate + Pragma + Expires) vì một số proxy/CDN (vd gateway
// ai.basso.vn đứng trước server) chỉ tôn trọng no-store cho tài liệu HTML khi có đủ bộ này —
// nếu không, chúng cache trang gốc và giữ header bảng cũ trong khi js/ vẫn được tải mới, làm
// các cột mới không có tiêu đề.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// ---- Secret gateway↔app (tuỳ chọn) ----
// Nếu đặt GATEWAY_SECRET: chỉ chấp nhận request /api/* có header X-Gateway-Secret khớp
// (gateway ai.basso.vn gắn vào khi forward) -> chặn gọi thẳng app, giả mạo danh tính.
// MIỄN TRỪ: /api/health (probe), /api/register-local (runner gọi, dùng x-api-key riêng),
// /api/webhook/arrived (Basso gọi, dùng x-webhook-secret riêng).
const GATEWAY_EXEMPT = new Set(['/api/health', '/api/register-local', '/api/webhook/arrived']);
app.use((req, res, next) => {
  if (!config.gatewaySecret) return next();
  if (!req.path.startsWith('/api/') || GATEWAY_EXEMPT.has(req.path)) return next();
  if (!safeEqual(req.get('x-gateway-secret'), config.gatewaySecret)) {
    return res.status(401).json({ ok: false, error: 'Thiếu/sai X-Gateway-Secret' });
  }
  return next();
});

// ---- Health & cấu hình hiển thị ----
app.get('/api/health', async (req, res) => {
  const h = await getLocalHealth();
  res.json({
    ok: true,
    mock: config.basso.useMock,
    localRunner: {
      url: effectiveBaseUrl(),
      online: h.online,
      testMode: h.testMode || false,
      testPhones: h.testPhones || [],
      // Thông tin runner tự đăng ký (Xeko pattern). registered.url='' nghĩa là đang dùng
      // PLAYWRIGHT_LOCAL_URL tĩnh trong .env.
      registered: localRegistry.getInfo(),
    },
    autoNotify: autoNotify.getStatus(),
    preload: cacheWarmer.getStatus(),
    // Số nhân viên đã ánh xạ sang tài khoản Zalo (ZALO_ACCOUNT_MAP) — để kiểm tra cấu hình.
    zaloAccountMapped: Object.keys(config.zaloAccountMap).length,
  });
});

// ---- Local-runner tự đăng ký URL (Xeko pattern) ----
// Runner (start.js) gọi định kỳ để báo "tôi đang ở URL này". Server lưu trong RAM rồi
// forward lệnh automation tới đó, khỏi cần hardcode PLAYWRIGHT_LOCAL_URL trong .env server.
app.post('/api/register-local', (req, res) => {
  const { url, apiKey } = req.body || {};
  // Bảo vệ bằng API_KEY dùng chung (nếu server có đặt). Trống = bỏ qua kiểm tra (dev).
  if (config.apiKey && !safeEqual(apiKey, config.apiKey)) {
    return res.status(401).json({ ok: false, error: 'Sai hoặc thiếu apiKey' });
  }
  if (!localRegistry.register(url)) {
    return res.status(400).json({ ok: false, error: 'Thiếu url hợp lệ' });
  }
  res.json({ ok: true, url: localRegistry.getInfo().url });
});

// ---- Quản lý tài khoản Zalo (dashboard → forward xuống local-runner) ----
// Server cloud KHÔNG giữ account; runner (máy có Chrome) là nơi lưu + mở Chromium đăng nhập.
// Mỗi route chỉ chuyển tiếp request và trả nguyên kết quả của runner.
async function proxyAccounts(req, res, method, pathName, useBody) {
  try {
    const { status, data } = await forwardAccounts(method, pathName, {
      body: useBody ? req.body : undefined,
      query: req.query,
    });
    if (method !== 'GET') invalidateAccountsCache(); // thay đổi -> resolve lần sau lấy bản mới
    res.status(status).json(data);
  } catch (e) {
    res.status(504).json({ ok: false, error: `Không kết nối được local-runner: ${e.message}` });
  }
}

app.get('/api/accounts', (req, res) => proxyAccounts(req, res, 'GET', '/api/accounts', false));
app.post('/api/accounts', (req, res) => proxyAccounts(req, res, 'POST', '/api/accounts', true));
app.put('/api/accounts/:key', (req, res) =>
  proxyAccounts(req, res, 'PUT', `/api/accounts/${encodeURIComponent(req.params.key)}`, true));
app.post('/api/accounts/:key/login', (req, res) =>
  proxyAccounts(req, res, 'POST', `/api/accounts/${encodeURIComponent(req.params.key)}/login`, false));
app.post('/api/accounts/:key/check', (req, res) =>
  proxyAccounts(req, res, 'POST', `/api/accounts/${encodeURIComponent(req.params.key)}/check`, false));
app.get('/api/accounts/:key/history', (req, res) =>
  proxyAccounts(req, res, 'GET', `/api/accounts/${encodeURIComponent(req.params.key)}/history`, false));
app.delete('/api/accounts/:type/:key', (req, res) =>
  proxyAccounts(req, res, 'DELETE', `/api/accounts/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.key)}`, false));

// ---- Chế độ TEST an toàn (whitelist SĐT) — forward xuống runner (nơi thực thi chặn) ----
// Server cloud không giữ cấu hình này; runner là nơi enforce nên cũng là nơi lưu.
async function proxyTestMode(req, res, method, useBody) {
  try {
    const { status, data } = await forwardAccounts(method, '/api/test-mode', {
      body: useBody ? req.body : undefined,
    });
    res.status(status).json(data);
  } catch (e) {
    res.status(504).json({ ok: false, error: `Không kết nối được local-runner: ${e.message}` });
  }
}
app.get('/api/test-mode', (req, res) => proxyTestMode(req, res, 'GET', false));
app.put('/api/test-mode', (req, res) => proxyTestMode(req, res, 'PUT', true));

// ---- Nhân viên (tài khoản dashboard Mi) ----
// Lưu Ở SERVER (SQLite, volume bền) — KHÔNG lưu mật khẩu: login do gateway ai.basso.vn lo,
// bảng này chỉ map email đăng nhập -> vai trò + trạng thái. Khác với tài khoản Zalo (ở runner).

// Ai đang đăng nhập (email do gateway forward) + bản ghi NV tương ứng (nếu có).
// defaultUserId = user_id Basso để dashboard tự lọc theo người này:
//   1) ưu tiên user_id đã gán trong Cài đặt;
//   2) nếu chưa gán -> tự KHỚP THEO TÊN với danh sách NV Basso (khớp duy nhất mới lấy).
// Nhờ (2), thường không cần cấu hình gì mà vẫn mở lên đúng đơn của mình.
app.get('/api/me', async (req, res) => {
  const email = getActor(req);
  const staff = email ? getStaffByEmail(email) : null;
  // Admin quản trị toàn bộ -> mở lên mặc định "Tất cả nhân viên" (không tự lọc theo 1 người),
  // kể cả khi có gán user_id hoặc trùng tên với NV Basso.
  if (staff && staff.role === 'Admin') {
    return res.json({ ok: true, email, staff, defaultUserId: null });
  }
  let defaultUserId = staff && staff.user_id != null && String(staff.user_id) !== '' ? String(staff.user_id) : null;
  if (!defaultUserId && staff && staff.name) {
    try {
      const { tabUsers } = await getTabUsers();
      const norm = (s) => String(s || '').trim().toLowerCase();
      const hit = (tabUsers || []).filter((u) => norm(u.name) === norm(staff.name));
      if (hit.length === 1) defaultUserId = String(hit[0].user_id);
    } catch (_) { /* Basso lỗi -> bỏ qua, để Tất cả */ }
  }
  res.json({ ok: true, email, staff, defaultUserId });
});



// Chỉ Admin (đang Hoạt động) được sửa danh sách NV. Miễn trừ an toàn để không tự khoá mình:
//  - chưa có NV nào -> cho tạo (bootstrap admin đầu tiên);
//  - không có danh tính gateway (actor null, vd chạy local/dev) -> cho qua.
// Trả null nếu được phép; ngược lại trả object lỗi để route dừng.
function denyStaffEdit(req) {
  if (staffCount() === 0) return null;            // bootstrap
  const actor = getActor(req);
  if (!actor) return null;                        // không có gateway (dev/standalone)
  const me = getStaffByEmail(actor);
  if (me && me.role === 'Admin' && me.status === 'Hoạt động') return null;
  return { status: 403, error: 'Chỉ Admin (đang hoạt động) mới được sửa danh sách nhân viên' };
}

app.get('/api/staff', (req, res) => res.json({ ok: true, staff: listStaff() }));

// ---- Định tuyến báo qua Facebook (khách/NV cần báo FB thay vì Zalo) ----
app.get('/api/fb-routing', (req, res) => res.json({ ok: true, ...getFbRouting() }));

/** PUT /api/fb-routing — body { customers?: {phone,link}[], staffIds?: string[] } (thiếu field nào giữ nguyên). */
app.put('/api/fb-routing', (req, res) => {
  const deny = denyStaffEdit(req); // dùng chung quyền quản trị với danh sách nhân viên
  if (deny) return res.status(deny.status).json({ ok: false, error: deny.error });
  const body = req.body || {};
  if (body.customers !== undefined && !Array.isArray(body.customers)) return res.status(400).json({ ok: false, error: 'customers phải là mảng' });
  if (body.staffIds !== undefined && !Array.isArray(body.staffIds)) return res.status(400).json({ ok: false, error: 'staffIds phải là mảng' });
  try {
    const saved = setFbRouting({ customers: body.customers, staffIds: body.staffIds });
    res.json({ ok: true, ...saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function saveStaff(req, res) {
  const deny = denyStaffEdit(req);
  if (deny) return res.status(deny.status).json({ ok: false, error: deny.error });
  try {
    const body = req.body || {};
    const email = req.params.email != null ? req.params.email : body.email;
    const staff = upsertStaff({ email, name: body.name, role: body.role, status: body.status, user_id: body.user_id });
    res.json({ ok: true, staff });
  } catch (e) {
    if (e.code === 'BAD_INPUT') return res.status(400).json({ ok: false, error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
}
app.post('/api/staff', saveStaff);
app.put('/api/staff/:email', saveStaff);

app.delete('/api/staff/:email', (req, res) => {
  const deny = denyStaffEdit(req);
  if (deny) return res.status(deny.status).json({ ok: false, error: deny.error });
  const target = getStaffByEmail(req.params.email);
  // Chặn xoá Admin hoạt động cuối cùng -> tránh mất quyền quản trị (lockout).
  if (target && target.role === 'Admin' && target.status === 'Hoạt động' && activeAdminCount() <= 1) {
    return res.status(409).json({ ok: false, error: 'Không thể xoá Admin hoạt động cuối cùng' });
  }
  const removed = deleteStaff(req.params.email);
  res.json({ ok: removed, removed });
});

// ---- Danh bạ Zalo (SĐT -> tên hội thoại Zalo/FB) ----
// Nguồn cho bước tìm hội thoại: khớp SĐT vẫn ưu tiên, tên Zalo dùng làm fallback khi SĐT
// không ra hội thoại / khách Facebook. Là dữ liệu VẬN HÀNH (rủi ro thấp) nên mọi NV đã đăng
// nhập đều sửa được — vẫn nằm sau gateway secret như mọi API; thao tác xoá/thay có xác nhận ở UI.
app.get('/api/zalo-contacts', (req, res) => {
  res.json({ ok: true, contacts: listZaloContacts(), count: zaloContactsCount() });
});

app.post('/api/zalo-contacts', (req, res) => {
  try {
    const b = req.body || {};
    const contact = upsertZaloContact({
      phone: b.phone, zalo_name: b.zalo_name, note: b.note, source: 'manual',
      fb_report: b.fb_report, fb_link: b.fb_link, staff_id: b.staff_id,
    });
    res.json({ ok: true, contact });
  } catch (e) {
    if (e.code === 'BAD_INPUT') return res.status(400).json({ ok: false, error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Import hàng loạt: client parse file .xlsx (SheetJS) -> gửi mảng { phone, zalo_name, note? }.
app.post('/api/zalo-contacts/import', (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows : null;
  if (!rows) return res.status(400).json({ ok: false, error: 'Thiếu danh sách rows để nhập' });
  if (rows.length > 100000) return res.status(400).json({ ok: false, error: 'File quá lớn (>100.000 dòng)' });
  const mode = b.mode === 'replace' ? 'replace' : 'merge';
  try {
    const stat = importZaloContacts(rows, mode);
    res.json({ ok: true, ...stat, mode, count: zaloContactsCount() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/zalo-contacts/:phone', (req, res) => {
  const removed = deleteZaloContact(req.params.phone);
  res.json({ ok: removed, removed });
});

// ---- Test kết nối Basso (chỉ đọc): dùng cho nút "Test Basso" trên dashboard ----
// Luôn trả HTTP 200 + cờ `connected` để frontend hiển thị được cả khi lỗi.
app.get('/api/basso/ping', async (req, res) => {
  if (config.basso.useMock) {
    return res.json({ ok: true, connected: false, mock: true, error: 'Đang ở chế độ MOCK — chưa nối Basso thật.' });
  }
  const t0 = Date.now();
  try {
    const r = await getOrders({ pageSize: 1 });
    const o = (r.orders || [])[0] || null;
    res.json({
      ok: true,
      connected: true,
      mock: false,
      baseUrl: config.basso.baseUrl,
      source: r.source,
      total: r.total,
      ms: Date.now() - t0,
      sample: o ? { id: o.id, customerName: o.customerName, warehouseDate: o.warehouseDate, status: o.status } : null,
    });
  } catch (err) {
    res.json({ ok: true, connected: false, mock: false, baseUrl: config.basso.baseUrl, ms: Date.now() - t0, error: err.message });
  }
});

// ---- DEBUG (read-only): soi raw response THẬT của getArrivedVnList, bỏ qua cache ----
// Dùng chẩn đoán "ND báo hàng có ở web Basso nhưng mi không hiện": mở
//   /api/basso/debug-list?q=<tên hoặc SĐT khách>
// rồi xem `content` trong từng dòng có nội dung không (hoặc nội dung nằm ở field tên khác
// trong `_allKeys`). Không đổi dữ liệu, chỉ đọc.
app.get('/api/basso/debug-list', async (req, res) => {
  try {
    const { q, from, to, status, limit } = req.query;
    const data = await debugRawRows({
      q, from, to, status,
      limit: limit ? Math.min(parseInt(limit, 10) || 5, 50) : 5,
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Gắn dấu local (mi) lên danh sách đơn: "bot đã tự gửi"/"đã báo tay" (autoNotified) + cờ
// Delay/Loại trừ — để dashboard phân biệt kể cả khi không cập nhật trạng thái về web Basso.
function enrichOrders(orders) {
  if (!Array.isArray(orders)) return orders;
  // Nạp cả 2 bảng dấu-cục-bộ trong 2 truy vấn (thay vì 1 query/đơn) — với tập all-time hàng
  // nghìn đơn thì đây là khác biệt rõ giữa vài nghìn query và 2 query.
  const delayedMap = getDelayedMap();
  const autoMap = getAutoMap();
  // Thời điểm đã gửi báo hàng/ship (từ Lịch sử báo) để dashboard hiện mốc thời gian từng loại.
  const sentTimesMap = getSentTimesMap();
  // Lượt báo đại diện của mỗi đơn (Người gửi + Tài khoản) — gộp Lịch sử báo lên thẳng danh sách.
  const lastReportMap = getLastReportMap();
  // Danh bạ Zalo (SĐT-chuẩn-hoá -> tên group) để hiện cột "Tên Zalo/FB" + cho biết đơn nào
  // sẽ gửi theo tên group. Nạp 1 lần cho cả tập.
  const zaloMap = getZaloMap();
  return orders.map((o) => {
    const key = autoNotify.autoKey(o);
    const a = autoMap.get(String(key));
    const withAuto = a ? { ...o, autoNotified: { status: a.status, attempts: a.attempts, at: a.updated_at } } : o;
    const sent = sentTimesMap.get(String(key));
    const withSent = sent ? { ...withAuto, sentAt: sent } : withAuto;
    const last = lastReportMap.get(String(key));
    const withLast = last ? { ...withSent, lastReport: last } : withSent;
    const withDelay = delayedMap.has(key)
      ? { ...withLast, delayed: true, delayReason: delayedMap.get(key) }
      : withLast;
    const zaloName = o.phone ? zaloMap.get(normPhone(o.phone)) : '';
    return zaloName ? { ...withDelay, zaloName } : withDelay;
  });
}

// ---- Dashboard: danh sách hàng về (phân trang server-side) ----
app.get('/api/orders', async (req, res) => {
  try {
    const { from, to, status, staff, q, page, pageSize, days } = req.query;
    const data = await getOrders({
      from, to, status, staff, q, days,
      page: page ? parseInt(page, 10) || 1 : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) || undefined : undefined,
    });
    data.orders = enrichOrders(data.orders);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Dashboard: TOÀN BỘ đơn 1 khoảng ngày (để client lọc NV/trạng thái/trang tức thì) ----
// Trả truncated=true khi tập quá lớn -> client tự fallback về /api/orders phân trang server.
app.get('/api/orders/all', async (req, res) => {
  try {
    const { from, to, days } = req.query;
    const data = await getAllOrders({ from, to, days });
    data.orders = enrichOrders(data.orders);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Danh sách nhân viên (không lọc status) — để tab staff luôn đầy đủ ----
app.get('/api/tab-users', async (req, res) => {
  try {
    const data = await getTabUsers();
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Đếm số đơn theo 4 nhóm trạng thái (tổng thật, phục vụ thẻ trạng thái) ----
app.get('/api/order-counts', async (req, res) => {
  try {
    const { from, to, staff, q, days } = req.query;
    const data = await getStatusCounts({ from, to, staff, q, days });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Báo hàng loạt: kéo HẾT đơn "Chưa báo" qua mọi trang rồi gửi ----
// (không bị giới hạn ở trang đang xem). Tự bỏ qua đơn đã Delay và đơn bot/đã báo tay.
// body: { from?, to?, staff?, q?, kind? }
app.post('/api/notify-all', async (req, res) => {
  try {
    const { orders, from, to, staff, q, kind } = req.body || {};
    const actor = getActor(req);
    // Ưu tiên danh sách client gửi lên (dashboard client-mode đã có sẵn cả tập) -> KHÔNG kéo
    // lại từ Basso, tránh timeout khi Basso chậm. Không có thì fallback kéo toàn bộ như cũ.
    const all = (Array.isArray(orders) && orders.length)
      ? orders
      : await fetchAllOrders({ status: 'not_sent', from, to, staff, q });
    const delayed = getDelayedMap();
    const targets = all.filter((o) => {
      const key = autoNotify.autoKey(o);
      if (delayed.has(key)) return false;             // đã Delay -> loại
      const a = getAutoRecord(key);
      if (a && (a.status === 'success' || a.status === 'manual')) return false; // đã báo -> loại
      return true;
    });
    if (!targets.length) {
      return res.json({ ok: true, total: 0, sent: 0, failed: 0, results: [] });
    }
    const result = await notifyOrders(targets, { kind, actor });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Chi tiết sản phẩm đã về của 1 dòng (load lazy khi mở rộng) ----
app.get('/api/arrived-items', async (req, res) => {
  try {
    const { id, customerId, dateInventory } = req.query;
    if (id == null && (customerId == null || dateInventory == null)) {
      return res.status(400).json({ ok: false, error: 'Cần id hoặc (customerId + dateInventory)' });
    }
    const data = await getArrivedItems({ id, customerId, dateInventory });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Lấy RIÊNG nội dung báo hàng/ship của 1 đơn (fresh) — cho nút "Xem/Tải nội dung" ----
// Khi danh sách (đã cache) chưa có ND của đơn, gọi trực tiếp Basso lấy đúng đơn. Read-only.
app.get('/api/order-content', async (req, res) => {
  try {
    const { customerId, dateInventory, phone } = req.query;
    if (customerId == null || dateInventory == null) {
      return res.status(400).json({ ok: false, error: 'Cần customerId + dateInventory' });
    }
    const data = await getOrderContent({ customerId, dateInventory, phone });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Báo hàng: gửi tin cho 1 hoặc nhiều đơn ----
// body: { orders: object[] (ưu tiên, client gửi đơn đầy đủ) | orderIds: string[] (legacy),
//         profile?, account?, messageOverride?, kind? }
app.post('/api/notify', async (req, res) => {
  try {
    const { orders, orderIds, profile, account, messageOverride, kind } = req.body || {};
    const opts = { profile, account, messageOverride, kind, actor: getActor(req) };
    if (Array.isArray(orders) && orders.length) {
      const result = await notifyOrders(orders, opts);
      return res.json({ ok: true, ...result });
    }
    if (Array.isArray(orderIds) && orderIds.length) {
      const result = await notifyMany(orderIds, opts);
      return res.json({ ok: true, ...result });
    }
    return res.status(400).json({ ok: false, error: 'Cần orders hoặc orderIds (mảng không rỗng)' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Cập nhật trạng thái / ghi chú 1 dòng (inline edit, sync về web) ----
// body: { customerId, dateInventory, status?, note? }
app.post('/api/update-row', async (req, res) => {
  try {
    const { customerId, dateInventory, status, note } = req.body || {};
    if (customerId == null) return res.status(400).json({ ok: false, error: 'Thiếu customerId' });
    const result = await updateOrderStatus({ customerId, dateInventory, status, note });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Cờ Delay / Loại trừ (lưu cục bộ ở mi, không sync về Basso) ----
// body: { customerId, dateInventory, id?, delayed: boolean, reason?: string }
app.post('/api/delay', (req, res) => {
  try {
    const { customerId, dateInventory, id, delayed, reason } = req.body || {};
    if (customerId == null && id == null) {
      return res.status(400).json({ ok: false, error: 'Cần id hoặc customerId' });
    }
    const key = autoNotify.autoKey({ customerId, dateInventory, id });
    const result = setDelayed(key, !!delayed, reason);
    res.json({ ok: true, delayed: result, reason: reason || '' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Tự động báo hàng: trạng thái + bật/tắt + chạy thủ công ----
app.get('/api/auto-notify', (req, res) => {
  res.json({ ok: true, ...autoNotify.getStatus() });
});

// Bật/tắt poller tự động lúc runtime. body: { enabled: boolean }
app.post('/api/auto-notify/toggle', (req, res) => {
  const { enabled } = req.body || {};
  const status = autoNotify.setEnabled(!!enabled);
  res.json({ ok: true, ...status });
});

// Chạy 1 lượt quét + gửi ngay (không phụ thuộc interval). Dùng cho nút "Quét & gửi ngay".
app.post('/api/auto-notify/run', async (req, res) => {
  try {
    const result = await autoNotify.runAutoNotify({ trigger: 'manual' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Đặt GIỜ GỬI CỐ ĐỊNH + nhắc soạn ND. body: { time?: 'HH:MM' | '', precheckMinutes?: number }.
// time trống = gửi ngay theo interval; precheckMinutes=0 = tắt nhắc. Chỉ đổi field được gửi lên.
app.post('/api/auto-notify/schedule', (req, res) => {
  try {
    const { time, precheckMinutes } = req.body || {};
    if (time !== undefined) autoNotify.setScheduleTime(time);
    if (precheckMinutes !== undefined) autoNotify.setPrecheckMinutes(precheckMinutes);
    res.json({ ok: true, ...autoNotify.getStatus() });
  } catch (err) {
    if (err.code === 'BAD_TIME' || err.code === 'BAD_PRECHECK') return res.status(400).json({ ok: false, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Xem trước (không gửi): đếm đơn "Chưa báo" đã đủ ND vs chưa có ND -> nút "Kiểm tra" trên Cài đặt.
app.get('/api/auto-notify/preview', async (req, res) => {
  try {
    const result = await autoNotify.previewAutoNotify();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cấu hình NHẮC RA ZALO (nội bộ). body: { enabled?, account?, phone?, name? } — chỉ đổi field gửi lên.
app.post('/api/auto-notify/alert', (req, res) => {
  try {
    const { enabled, account, phone, name } = req.body || {};
    const status = autoNotify.setAlertConfig({ enabled, account, phone, name });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GỬI THỬ 1 tin nhắc ra Zalo ngay (nút "Gửi thử"). body: { account?, phone?, name? } (tuỳ chọn).
app.post('/api/auto-notify/alert-test', async (req, res) => {
  try {
    const { account, phone, name } = req.body || {};
    const r = await autoNotify.sendAlertTest({ account, phone, name });
    res.json({ ok: !!r.ok, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Webhook: website Basso gọi sang khi CÓ HÀNG VỀ -> gửi ngay (real-time) ----
// Bảo vệ tùy chọn bằng header `x-webhook-secret` khớp AUTO_NOTIFY_WEBHOOK_SECRET.
app.post('/api/webhook/arrived', async (req, res) => {
  const secret = config.autoNotify.webhookSecret;
  // Fail-closed ở production: webhook được MIỄN TRỪ gateway-secret (Basso gọi thẳng, không qua
  // gateway) nên nếu KHÔNG có secret riêng thì bất kỳ ai gọi được cũng kích hoạt 1 lượt gửi.
  // Khi REQUIRE_API_KEY/production mà chưa đặt AUTO_NOTIFY_WEBHOOK_SECRET -> KHÓA endpoint thay
  // vì để hở (dev vẫn mở như cũ). Poller định kỳ không bị ảnh hưởng — chỉ chặn kích hoạt qua HTTP.
  if (config.requireApiKey && !secret) {
    return res.status(503).json({ ok: false, error: 'Webhook chưa cấu hình AUTO_NOTIFY_WEBHOOK_SECRET (bắt buộc ở production)' });
  }
  if (secret && !safeEqual(req.get('x-webhook-secret'), secret)) {
    return res.status(401).json({ ok: false, error: 'Sai webhook secret' });
  }
  try {
    const result = await autoNotify.runAutoNotify({ trigger: 'webhook' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Lịch sử report ----
app.get('/api/reports', async (req, res) => {
  try {
    const { limit, status, q, from, to, staff, sender, account } = req.query;
    const filters = { status, q, from, to, staff, sender, account };
    const items = listReports({ limit: limit ? parseInt(limit, 10) : 200, ...filters });
    // Kênh hiển thị bám theo NỀN TẢNG tài khoản đã gửi (chuẩn hơn cột channel đã lưu — đúng cả
    // report cũ chưa có channel): report gửi bằng 1 tài khoản Facebook -> chip 'facebook'.
    let fbIds = null;
    try {
      const accts = await getAccountsCached();
      const s = new Set();
      for (const a of (accts || [])) {
        if (a && a.platform === 'facebook') {
          [a.fbName, a.key, a.name].forEach((v) => { if (v) s.add(String(v).trim()); });
        }
      }
      fbIds = s;
    } catch { fbIds = null; }
    const items2 = fbIds
      ? items.map((r) => ({
        ...r,
        channel: (r.zalo_account && fbIds.has(String(r.zalo_account).trim())) ? 'facebook' : (r.channel || 'zalo'),
      }))
      : items;
    res.json({ ok: true, stats: stats(filters), items: items2, facets: reportFacets() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Thử gửi LẠI 1 lượt báo THẤT BẠI (từ Lịch sử báo) ----
// Tái tạo đơn từ khóa đã lưu (customerId+dateInventory+userId) rồi đi qua notifyOrders như báo
// tay: có khóa chung với bot (không đua), resolve đúng account theo NV, dùng lại NGUYÊN VĂN nội
// dung đã gửi (messageOverride) để khớp lần trước. Chỉ cho thử lại dòng 'failed'.
app.post('/api/reports/:id/retry', async (req, res) => {
  try {
    const rep = getReportById(req.params.id);
    if (!rep) return res.status(404).json({ ok: false, error: 'Không tìm thấy lượt báo' });
    if (rep.status !== 'failed') {
      return res.status(400).json({ ok: false, error: 'Chỉ thử lại được lượt THẤT BẠI' });
    }
    // Report cũ (trước khi có 3 cột khóa đơn) không đủ dữ liệu tái tạo -> hướng người dùng báo tay.
    if (rep.customer_id == null && !rep.phone) {
      return res.status(400).json({
        ok: false,
        error: 'Lượt báo cũ thiếu dữ liệu đơn — hãy báo lại từ Dashboard.',
      });
    }
    const order = {
      customerId: rep.customer_id,
      dateInventory: rep.date_inventory,
      customerName: rep.customer_name,
      phone: rep.phone,
      staff: rep.staff,
      userId: rep.user_id,
      orderCode: rep.order_id,
    };
    // messageOverride = nội dung đã lưu -> gửi lại y hệt (không dựng lại từ template).
    const result = await notifyOrders([order], {
      kind: rep.kind === 'ship' ? 'ship' : 'hang', // giữ đúng loại tin của lượt cũ
      messageOverride: rep.message || undefined,
      actor: getActor(req),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Fail-closed: production (hoặc REQUIRE_API_KEY=true) bắt buộc phải có API_KEY — nếu không,
// register-local/forward sẽ không được bảo vệ. Dừng hẳn thay vì chạy hớ.
if (config.requireApiKey && !config.apiKey) {
  console.error('[server] FATAL: REQUIRE_API_KEY/production nhưng chưa đặt API_KEY. Đặt API_KEY rồi chạy lại.');
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  console.log(`[server] mock=${config.basso.useMock} | local-runner=${config.playwrightLocalUrl}`);
  console.log(`[server] DB: ${config.dbPath}`);
  if (config.gatewaySecret) console.log('[server] Gateway secret: BẬT (yêu cầu X-Gateway-Secret cho /api/*)');
  if (config.registerAllowedHosts.length) console.log(`[server] register-local allowlist: ${config.registerAllowedHosts.join(', ')}`);
  if (config.requireApiKey && !config.autoNotify.webhookSecret) {
    console.warn('[server] ⚠️  Webhook /api/webhook/arrived BỊ KHÓA (production nhưng chưa đặt AUTO_NOTIFY_WEBHOOK_SECRET). Đặt secret để bật, hoặc chỉ dùng poller AUTO_NOTIFY.');
  }
  autoNotify.startAutoNotify();
  cacheWarmer.start();
});
