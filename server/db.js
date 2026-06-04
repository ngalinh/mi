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

const insertStmt = db.prepare(`
  INSERT INTO reports (order_id, customer_name, phone, staff, message, status, error, job_id, created_at)
  VALUES (@order_id, @customer_name, @phone, @staff, @message, @status, @error, @job_id, @created_at)
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
    created_at: new Date().toISOString(),
  };
  const info = insertStmt.run(data);
  return { id: info.lastInsertRowid, ...data };
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
  return db.prepare(sql).all(params);
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

module.exports = { db, addReport, listReports, stats };
