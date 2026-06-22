'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built-in, không cần compile (Node >= 22.5)
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      TEXT,
    customer_name TEXT,
    phone         TEXT,
    staff         TEXT,
    message       TEXT,
    status        TEXT NOT NULL,           -- 'success' | 'failed'
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

db.exec(`  -- Chống gửi trùng cho luồng TỰ ĐỘNG báo hàng: mỗi đơn (order_id) chỉ tự gửi 1 lần thành công.
  -- Khi lỗi, tăng attempts; quá maxRetries thì thôi (tránh spam khi local-runner offline).
  CREATE TABLE IF NOT EXISTS auto_notified (
    order_id    TEXT PRIMARY KEY,
    status      TEXT NOT NULL,           -- 'success' | 'failed'
    attempts    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL            -- ISO string
  );
`);

const insertStmt = db.prepare(`
  INSERT INTO reports (order_id, customer_name, phone, staff, message, status, error, job_id, images, sent_by, created_at)
  VALUES (@order_id, @customer_name, @phone, @staff, @message, @status, @error, @job_id, @images, @sent_by, @created_at)
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
    created_at: new Date().toISOString(),
  };
  const info = insertStmt.run(data);
  return { id: info.lastInsertRowid, ...data };
}

// Đổi cột images (JSON string) -> mảng URL cho client. Lỗi parse -> [].
function parseImages(row) {
  let images = [];
  if (row.images) { try { images = JSON.parse(row.images) || []; } catch (_) { images = []; } }
  return { ...row, images };
}

function listReports({ limit = 200, status, q } = {}) {
  let sql = 'SELECT * FROM reports';
  const where = [];
  const params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  if (q) {
    where.push('(customer_name LIKE @q OR phone LIKE @q OR order_id LIKE @q)');
    params.q = `%${q}%`;
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT @limit';
  params.limit = Math.min(limit, 1000);
  return db.prepare(sql).all(params).map(parseImages);
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

/** Ghi/cập nhật trạng thái tự động báo của 1 đơn. */
function recordAutoNotified(orderId, status, attempts) {
  upsertAutoStmt.run({
    order_id: String(orderId),
    status,
    attempts: attempts ?? 0,
    updated_at: new Date().toISOString(),
  });
}

function stats() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed
    FROM reports
  `).get();
  return { total: row.total || 0, success: row.success || 0, failed: row.failed || 0 };
}

module.exports = { db, addReport, listReports, stats, getAutoRecord, recordAutoNotified, autoKey };
