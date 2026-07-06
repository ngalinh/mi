'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Mở SQLite linh hoạt theo Node:
//   - Node >= 22.5: dùng node:sqlite (built-in, KHÔNG cần compile).
//   - Node cũ hơn / không có node:sqlite: fallback better-sqlite3 (optionalDependency).
// API hai driver gần như giống hệt (prepare/run/all/get, named param @name) nên phần
// còn lại của file dùng chung không cần đổi.
function openDb(dbPath) {
  try {
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    if (DatabaseSync) return new DatabaseSync(dbPath);
  } catch (_) {
    /* Node < 22.5 hoặc node:sqlite cần cờ --experimental-sqlite -> thử better-sqlite3 */
  }
  try {
    // eslint-disable-next-line global-require
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch (e) {
    throw new Error(
      'Không mở được SQLite. Cần Node >= 22.5 (node:sqlite) HOẶC cài better-sqlite3 '
      + `(npm i better-sqlite3). Chi tiết: ${e.message}`,
    );
  }
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = openDb(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      TEXT,
    customer_name TEXT,
    phone         TEXT,
    staff         TEXT,
    message       TEXT,
    status        TEXT NOT NULL,           -- 'pending' | 'success' | 'failed'
    error         TEXT,
    job_id        TEXT,
    created_at    TEXT NOT NULL            -- ISO string
  );
  CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_reports_status  ON reports(status);
`);

// Migration: thêm cột ảnh SP (JSON mảng URL) cho report cũ. SQLite không có
// "ADD COLUMN IF NOT EXISTS" -> bọc try/catch, chạy lại không sao.
try { db.exec('ALTER TABLE reports ADD COLUMN images TEXT'); } catch (_) { /* đã có cột */ }

// Migration: ghi NGƯỜI GỬI (audit). 'bot' = luồng tự động; còn lại là danh tính nhân
// viên do gateway ai.basso.vn forward (xem config.auth.userHeaders). null = không rõ.
try { db.exec('ALTER TABLE reports ADD COLUMN sent_by TEXT'); } catch (_) { /* đã có cột */ }

// Migration: TÀI KHOẢN ZALO đã dùng để gửi (saleworkName, hoặc key/profile nếu không có).
// Giúp đối chiếu "đơn này gửi bằng account nào" trên Lịch sử báo. null = không rõ/cũ.
try { db.exec('ALTER TABLE reports ADD COLUMN zalo_account TEXT'); } catch (_) { /* đã có cột */ }

// Migration: KHÓA ĐƠN + NV phụ trách của lượt báo — để "Thử lại" 1 lượt THẤT BẠI có thể
// tái tạo đơn (customerId+dateInventory) và resolve đúng account theo NV (userId). Report cũ
// thiếu các cột này -> nút Thử lại sẽ báo "thiếu dữ liệu, vui lòng báo tay".
try { db.exec('ALTER TABLE reports ADD COLUMN customer_id TEXT'); } catch (_) { /* đã có cột */ }
try { db.exec('ALTER TABLE reports ADD COLUMN date_inventory TEXT'); } catch (_) { /* đã có cột */ }
try { db.exec('ALTER TABLE reports ADD COLUMN user_id TEXT'); } catch (_) { /* đã có cột */ }

// Migration: LOẠI tin đã gửi — 'hang' (báo hàng) | 'ship' (báo ship). Dùng để hiển thị
// riêng "thời gian đã gửi báo hàng" và "thời gian đã gửi báo ship" trên dashboard. Report cũ
// thiếu cột này (null) -> coi như 'hang' vì báo hàng là luồng chính.
try { db.exec('ALTER TABLE reports ADD COLUMN kind TEXT'); } catch (_) { /* đã có cột */ }

// Dọn dòng "đang báo" MỒ CÔI lúc khởi động. notifyOne ghi 1 dòng status='pending' TRƯỚC khi
// gửi rồi poll local-runner tới khi xong; nếu server restart/crash giữa chừng thì KHÔNG còn
// ai poll tiếp -> dòng pending kẹt mãi. mi-server chạy 1 instance (ecosystem.config.js:
// exec_mode 'fork', instances 1) nên mọi dòng pending còn sót lúc boot CHẮC CHẮN mồ côi ->
// đánh dấu 'failed' luôn, không cần phán đoán theo tuổi.
// ⚠️ NẾU sau này scale mi-server lên NHIỀU instance, câu này sẽ xoá nhầm job instance khác
// đang gửi dở -> lúc đó đổi sang lọc theo tuổi (vd created_at < now - 15 phút, lớn hơn timeout
// 10 phút của sendBaoHang).
db.prepare(
  `UPDATE reports SET status = 'failed',
     error = COALESCE(error, 'Mất theo dõi (server khởi động lại khi đang gửi)')
   WHERE status = 'pending'`,
).run();

db.exec(`  -- Chống gửi trùng cho luồng TỰ ĐỘNG báo hàng: mỗi đơn (order_id) chỉ tự gửi 1 lần thành công.
  -- Khi lỗi, tăng attempts; quá maxRetries thì thôi (tránh spam khi local-runner offline).
  CREATE TABLE IF NOT EXISTS auto_notified (
    order_id    TEXT PRIMARY KEY,
    status      TEXT NOT NULL,           -- 'success' | 'failed'
    attempts    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL            -- ISO string
  );
`);

db.exec(`  -- Cờ "Delay / Loại trừ": đánh dấu đơn tạm hoãn để bỏ khỏi "Báo hàng loạt".
  -- Lưu ở mi (KHÔNG đồng bộ về Basso) nên giữ được sau khi reload trang.
  CREATE TABLE IF NOT EXISTS delayed_orders (
    order_key   TEXT PRIMARY KEY,        -- dùng autoKey(order) làm khoá ổn định
    updated_at  TEXT NOT NULL            -- ISO string
  );
`);

// Migration: thêm lý do delay (vd "Đợi bank", "Đợi hàng về thêm"). Chạy lại không sao.
try { db.exec('ALTER TABLE delayed_orders ADD COLUMN reason TEXT'); } catch (_) { /* đã có cột */ }

db.exec(`  -- Danh sách NHÂN VIÊN được phép vào dashboard Mi. KHÔNG lưu mật khẩu: việc đăng
  -- nhập do gateway ai.basso.vn lo (xem config.auth.userHeaders) — bảng này chỉ map
  -- EMAIL đăng nhập -> vai trò + trạng thái để Mi quản lý phân quyền/hiển thị.
  CREATE TABLE IF NOT EXISTS staff (
    email       TEXT PRIMARY KEY,        -- khớp x-user-email gateway forward (đã hạ chữ thường)
    name        TEXT NOT NULL,
    role        TEXT NOT NULL,           -- 'Admin' | 'Quản lý' | 'Nhân viên'
    status      TEXT NOT NULL,           -- 'Hoạt động' | 'Tạm khoá'
    created_at  TEXT NOT NULL,           -- ISO string
    updated_at  TEXT NOT NULL            -- ISO string
  );
`);

// Migration: ánh xạ NV -> user_id Basso (để dashboard tự lọc đơn của người đang đăng nhập).
// null = chưa gán -> không tự lọc (thấy tất cả). Chạy lại không sao.
try { db.exec('ALTER TABLE staff ADD COLUMN user_id TEXT'); } catch (_) { /* đã có cột */ }

db.exec(`  -- Cấu hình hệ thống chỉnh được trên web (key-value). Dùng để LƯU BỀN các thiết lập
  -- admin đổi trên trang Cài đặt mà không phải sửa .env + restart. Vd 'autoNotify.scheduleTime'
  -- = giờ gửi tin cố định. Giá trị ở đây GHI ĐÈ mặc định env tương ứng lúc khởi động.
  CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT NOT NULL            -- ISO string
  );
`);

const insertStmt = db.prepare(`
  INSERT INTO reports (order_id, customer_name, phone, staff, message, status, error, job_id, images, sent_by, zalo_account, customer_id, date_inventory, user_id, kind, created_at)
  VALUES (@order_id, @customer_name, @phone, @staff, @message, @status, @error, @job_id, @images, @sent_by, @zalo_account, @customer_id, @date_inventory, @user_id, @kind, @created_at)
`);

function addReport(row) {
  const data = {
    order_id: row.orderId ?? null,
    customer_name: row.customerName ?? null,
    phone: row.phone ?? null,
    staff: row.staff ?? null,
    message: row.message ?? null,
    status: row.status,
    error: row.error ?? null,
    job_id: row.jobId ?? null,
    images: Array.isArray(row.images) && row.images.length ? JSON.stringify(row.images) : null,
    sent_by: row.sentBy ?? null,
    zalo_account: row.zaloAccount ?? null,
    // Khóa đơn + NV phụ trách (để "Thử lại"). Ép chuỗi cho khớp kiểu cột TEXT.
    customer_id: row.customerId != null ? String(row.customerId) : null,
    date_inventory: row.dateInventory != null ? String(row.dateInventory) : null,
    user_id: row.userId != null ? String(row.userId) : null,
    // Loại tin: 'ship' cho báo ship, còn lại (mặc định) là 'hang'.
    kind: row.kind === 'ship' ? 'ship' : 'hang',
    created_at: new Date().toISOString(),
  };
  const info = insertStmt.run(data);
  return { id: info.lastInsertRowid, ...data };
}

const updateStmt = db.prepare(`
  UPDATE reports
     SET status = @status, error = @error, job_id = @job_id, images = @images, order_id = @order_id
   WHERE id = @id
`);
const getReportStmt = db.prepare('SELECT * FROM reports WHERE id = @id');

/**
 * Cập nhật 1 report đã có (dùng để chuyển dòng 'pending' -> 'success'/'failed' sau khi job
 * gửi xong). Chỉ đổi các field truyền vào; field bỏ trống giữ nguyên giá trị cũ.
 * Trả về dòng mới nhất (đã parse images) hoặc null nếu không tìm thấy id.
 */
function updateReport(id, fields = {}) {
  const cur = getReportStmt.get({ id });
  if (!cur) return null;
  const next = {
    id,
    status: fields.status ?? cur.status,
    error: fields.error !== undefined ? fields.error : cur.error,
    job_id: fields.jobId !== undefined ? fields.jobId : cur.job_id,
    images: fields.images !== undefined
      ? (Array.isArray(fields.images) && fields.images.length ? JSON.stringify(fields.images) : null)
      : cur.images,
    order_id: fields.orderId !== undefined ? fields.orderId : cur.order_id,
  };
  updateStmt.run(next);
  return parseImages(getReportStmt.get({ id }));
}

/** Lấy 1 report theo id (đã parse images), null nếu không có. Dùng cho "Thử lại". */
function getReportById(id) {
  const row = getReportStmt.get({ id });
  return row ? parseImages(row) : null;
}

// Đổi cột images (JSON string) -> mảng URL cho client. Lỗi parse -> [].
function parseImages(row) {
  let images = [];
  if (row.images) { try { images = JSON.parse(row.images) || []; } catch (_) { images = []; } }
  return { ...row, images };
}

// Gom điều kiện WHERE dùng chung cho listReports + stats để 2 nơi lọc y hệt nhau.
// staff/sender/account là bộ lọc mở rộng: khớp CHÍNH XÁC giá trị đã chọn từ dropdown.
function reportsWhere({ status, q, from, to, staff, sender, account } = {}) {
  const where = [];
  const params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  if (q) {
    where.push('(customer_name LIKE @q OR phone LIKE @q OR order_id LIKE @q)');
    params.q = `%${q}%`;
  }
  // from/to là mốc ISO (UTC) do client tính từ ngày local; so sánh chuỗi ISO đúng thứ tự.
  if (from) { where.push('created_at >= @from'); params.from = from; }
  if (to) { where.push('created_at < @to'); params.to = to; }
  if (staff) { where.push('staff = @staff'); params.staff = staff; }
  if (sender) { where.push('sent_by = @sender'); params.sender = sender; }
  if (account) { where.push('zalo_account = @account'); params.account = account; }
  return { whereSql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

function listReports({ limit = 200, ...filters } = {}) {
  const { whereSql, params } = reportsWhere(filters);
  params.limit = Math.min(limit, 1000);
  const sql = `SELECT * FROM reports${whereSql} ORDER BY id DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(parseImages);
}

// Giá trị phân biệt cho các dropdown lọc mở rộng (Nhân viên / Người gửi / Tài khoản).
// Lấy từ toàn bộ bảng (không theo bộ lọc hiện tại) để danh sách chọn luôn ổn định.
function reportFacets() {
  const distinct = (col) => db
    .prepare(`SELECT DISTINCT ${col} AS v FROM reports WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col} COLLATE NOCASE`)
    .all().map((r) => r.v);
  return { staff: distinct('staff'), senders: distinct('sent_by'), accounts: distinct('zalo_account') };
}

// ---- Dedup cho báo hàng (tự động + tay) ----
/**
 * Khóa chống trùng ỔN ĐỊNH cho 1 dòng hàng về. Ưu tiên customerId:dateInventory
 * (khóa thật của updateArrivedVnRow) vì API thật có thể KHÔNG trả field `id`.
 * Dùng chung ở autoNotify, notifyService và index.js để mọi nơi tra cùng 1 khóa.
 */
function autoKey(order) {
  if (order.customerId != null && order.dateInventory != null) {
    return `c${order.customerId}:d${order.dateInventory}`;
  }
  return `id:${order.id}`;
}

const getAutoStmt = db.prepare('SELECT * FROM auto_notified WHERE order_id = @order_id');
const upsertAutoStmt = db.prepare(`
  INSERT INTO auto_notified (order_id, status, attempts, updated_at)
  VALUES (@order_id, @status, @attempts, @updated_at)
  ON CONFLICT(order_id) DO UPDATE SET
    status = @status, attempts = @attempts, updated_at = @updated_at
`);

/** Lấy bản ghi tự-động-đã-gửi của 1 đơn (null nếu chưa có). */
function getAutoRecord(orderId) {
  return getAutoStmt.get({ order_id: String(orderId) }) || null;
}

const getAllAutoStmt = db.prepare('SELECT order_id, status, attempts, updated_at FROM auto_notified');
/**
 * Nạp TẤT CẢ bản ghi tự-động-đã-gửi vào 1 Map (order_id -> record) trong MỘT truy vấn.
 * Dùng cho enrichOrders khi gắn dấu cho cả tập all-time: 1 query thay vì N query/đơn.
 */
function getAutoMap() {
  const m = new Map();
  for (const r of getAllAutoStmt.all()) m.set(String(r.order_id), r);
  return m;
}

// Thời điểm ĐÃ GỬI THÀNH CÔNG gần nhất cho từng đơn, tách theo loại tin (hàng/ship).
// Nguồn chuẩn là bảng reports (mỗi lượt gửi 1 dòng) — khớp đơn qua customer_id+date_inventory
// (đúng công thức autoKey). Report cũ thiếu cột kind (null) coi như 'hang'.
const getSentTimesStmt = db.prepare(`
  SELECT customer_id, date_inventory,
         CASE WHEN kind = 'ship' THEN 'ship' ELSE 'hang' END AS k,
         MAX(created_at) AS at
    FROM reports
   WHERE status = 'success' AND customer_id IS NOT NULL AND date_inventory IS NOT NULL
   GROUP BY customer_id, date_inventory, k
`);

/**
 * Map khoá đơn (autoKey) -> { hang?: ISO, ship?: ISO } = lần gửi THÀNH CÔNG gần nhất mỗi loại.
 * Dùng cho enrichOrders để dashboard hiện "thời gian đã gửi báo hàng / báo ship". 1 query.
 */
function getSentTimesMap() {
  const m = new Map();
  for (const r of getSentTimesStmt.all()) {
    const key = `c${r.customer_id}:d${r.date_inventory}`;
    const entry = m.get(key) || {};
    entry[r.k] = r.at;
    m.set(key, entry);
  }
  return m;
}

/** Ghi/cập nhật trạng thái tự động báo của 1 đơn. */
function recordAutoNotified(orderId, status, attempts) {
  upsertAutoStmt.run({
    order_id: String(orderId),
    status,
    attempts: attempts ?? 0,
    updated_at: new Date().toISOString(),
  });
}

// ---- Cờ Delay / Loại trừ (lưu cục bộ ở mi) ----
const getDelayedStmt = db.prepare('SELECT order_key, reason FROM delayed_orders');
const setDelayedStmt = db.prepare(`
  INSERT INTO delayed_orders (order_key, reason, updated_at) VALUES (@order_key, @reason, @updated_at)
  ON CONFLICT(order_key) DO UPDATE SET reason = @reason, updated_at = @updated_at
`);
const delDelayedStmt = db.prepare('DELETE FROM delayed_orders WHERE order_key = @order_key');

/** Map khoá đơn -> lý do delay (chuỗi, có thể rỗng) cho các đơn đang bị Delay. */
function getDelayedMap() {
  const m = new Map();
  for (const r of getDelayedStmt.all()) m.set(r.order_key, r.reason || '');
  return m;
}

/** Bật/tắt cờ Delay cho 1 đơn (key = autoKey(order)), kèm lý do tuỳ chọn. */
function setDelayed(orderKey, delayed, reason) {
  const order_key = String(orderKey);
  if (delayed) setDelayedStmt.run({ order_key, reason: reason || null, updated_at: new Date().toISOString() });
  else delDelayedStmt.run({ order_key });
  return !!delayed;
}

// ---- Cấu hình hệ thống (key-value, chỉnh trên web) ----
const getSettingStmt = db.prepare('SELECT value FROM app_settings WHERE key = @key');
const setSettingStmt = db.prepare(`
  INSERT INTO app_settings (key, value, updated_at) VALUES (@key, @value, @now)
  ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now
`);

/** Đọc 1 thiết lập (chuỗi) đã lưu, null nếu chưa có. */
function getSetting(key) {
  const r = getSettingStmt.get({ key: String(key) });
  return r ? r.value : null;
}

/** Ghi/cập nhật 1 thiết lập. value=null lưu NULL. Trả lại value đã ghi. */
function setSetting(key, value) {
  setSettingStmt.run({
    key: String(key),
    value: value == null ? null : String(value),
    now: new Date().toISOString(),
  });
  return value;
}

// ---- Định tuyến báo qua Facebook ----
// Mặc định mọi đơn báo qua Zalo. "Định tuyến FB" chỉ định RIÊNG khách/nhân viên cần báo qua
// Facebook thay vì Zalo. Lưu 1 bản ghi JSON trong app_settings:
//   { phones: ["0912..."],   // SĐT khách -> đơn của khách này báo qua FB
//     staffIds: ["123"] }    // user_id NV/kênh -> mọi đơn của NV này báo qua FB
const FB_ROUTING_KEY = 'fb_routing';
const normFbPhone = (p) => String(p == null ? '' : p).replace(/\D/g, '').replace(/^84/, '').replace(/^0/, '');

/** Đọc cấu hình định tuyến FB (luôn trả { phones:[], staffIds:[] } — không bao giờ null). */
function getFbRouting() {
  try {
    const raw = getSetting(FB_ROUTING_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return {
      phones: Array.isArray(obj.phones) ? obj.phones.map((s) => String(s).trim()).filter(Boolean) : [],
      staffIds: Array.isArray(obj.staffIds) ? obj.staffIds.map((s) => String(s).trim()).filter(Boolean) : [],
    };
  } catch {
    return { phones: [], staffIds: [] };
  }
}

/** Ghi cấu hình định tuyến FB (chuẩn hoá + khử trùng). Trả bản đã lưu. */
function setFbRouting({ phones, staffIds } = {}) {
  const cur = getFbRouting();
  const next = {
    phones: [...new Set((phones !== undefined ? phones : cur.phones).map((s) => String(s).trim()).filter(Boolean))],
    staffIds: [...new Set((staffIds !== undefined ? staffIds : cur.staffIds).map((s) => String(s).trim()).filter(Boolean))],
  };
  setSetting(FB_ROUTING_KEY, JSON.stringify(next));
  return next;
}

/** Đơn này có thuộc diện báo qua Facebook không? (SĐT khách trong danh sách, hoặc NV được gắn FB). */
function isFacebookOrder(order) {
  if (!order) return false;
  const { phones, staffIds } = getFbRouting();
  if (staffIds.length && order.userId != null && staffIds.includes(String(order.userId).trim())) return true;
  if (phones.length && order.phone) {
    const t = normFbPhone(order.phone);
    if (t && phones.some((p) => normFbPhone(p) === t)) return true;
  }
  return false;
}

// ---- Nhân viên (tài khoản dashboard Mi) ----
const ROLES = ['Admin', 'Quản lý', 'Nhân viên'];
const STATUSES = ['Hoạt động', 'Tạm khoá'];

/** Chuẩn hoá email về khoá ổn định (trim + chữ thường) để khớp header gateway. */
function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const listStaffStmt = db.prepare('SELECT email, name, role, status, user_id FROM staff ORDER BY created_at ASC');
const getStaffStmt = db.prepare('SELECT email, name, role, status, user_id FROM staff WHERE email = @email');
const upsertStaffStmt = db.prepare(`
  INSERT INTO staff (email, name, role, status, user_id, created_at, updated_at)
  VALUES (@email, @name, @role, @status, @user_id, @now, @now)
  ON CONFLICT(email) DO UPDATE SET name = @name, role = @role, status = @status, user_id = @user_id, updated_at = @now
`);
const delStaffStmt = db.prepare('DELETE FROM staff WHERE email = @email');
const countStaffStmt = db.prepare('SELECT COUNT(*) AS n FROM staff');
const countActiveAdminStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM staff WHERE role = 'Admin' AND status = 'Hoạt động'"
);

function listStaff() { return listStaffStmt.all(); }

/** Lấy bản ghi NV theo email (null nếu chưa có). Dùng để kiểm tra vai trò/khoá. */
function getStaffByEmail(email) {
  const e = normEmail(email);
  if (!e) return null;
  return getStaffStmt.get({ email: e }) || null;
}

function staffCount() { return countStaffStmt.get().n || 0; }
function activeAdminCount() { return countActiveAdminStmt.get().n || 0; }

/**
 * Thêm/sửa 1 nhân viên (khoá theo email). Ném lỗi có .code='BAD_INPUT' nếu dữ liệu sai
 * để route trả 400. Vai trò/trạng thái phải nằm trong danh sách cho phép.
 */
function upsertStaff({ email, name, role, status, user_id }) {
  const e = normEmail(email);
  const nm = String(name || '').trim();
  const rl = String(role || '').trim();
  const st = String(status || '').trim();
  // user_id Basso (tuỳ chọn): chuỗi số; rỗng -> null (chưa gán).
  const uid = user_id != null && String(user_id).trim() !== '' ? String(user_id).trim() : null;
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { const err = new Error('Email không hợp lệ'); err.code = 'BAD_INPUT'; throw err; }
  if (!nm) { const err = new Error('Thiếu họ tên'); err.code = 'BAD_INPUT'; throw err; }
  if (!ROLES.includes(rl)) { const err = new Error('Vai trò không hợp lệ'); err.code = 'BAD_INPUT'; throw err; }
  if (!STATUSES.includes(st)) { const err = new Error('Trạng thái không hợp lệ'); err.code = 'BAD_INPUT'; throw err; }
  upsertStaffStmt.run({ email: e, name: nm, role: rl, status: st, user_id: uid, now: new Date().toISOString() });
  return getStaffStmt.get({ email: e });
}

/** Xoá 1 NV theo email. Trả true nếu có xoá. */
function deleteStaff(email) {
  const e = normEmail(email);
  if (!e) return false;
  return delStaffStmt.run({ email: e }).changes > 0;
}

// Thẻ thống kê tôn trọng bộ lọc ngày + tìm kiếm (không lọc theo status vì đếm riêng từng loại).
function stats({ q, from, to, staff, sender, account } = {}) {
  // Không tính 'status' vào WHERE: thẻ thống kê phải hiện đủ 4 trạng thái để bấm lọc.
  const { whereSql, params } = reportsWhere({ q, from, to, staff, sender, account });
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
    FROM reports${whereSql}
  `).get(params);
  return {
    total: row.total || 0, success: row.success || 0, failed: row.failed || 0, pending: row.pending || 0,
  };
}

module.exports = {
  db, addReport, updateReport, getReportById, listReports, reportFacets, stats, getAutoRecord, getAutoMap, getSentTimesMap, recordAutoNotified, autoKey, getDelayedMap, setDelayed,
  getSetting, setSetting,
  getFbRouting, setFbRouting, isFacebookOrder,
  listStaff, getStaffByEmail, upsertStaff, deleteStaff, staffCount, activeAdminCount, normEmail,
};
