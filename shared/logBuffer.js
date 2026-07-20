'use strict';
const util = require('util');

/**
 * logBuffer.js — Bộ đệm VÒNG (ring buffer) bắt log hệ thống ngay trong RAM.
 *
 * Vì sao có file này? Log lỗi cấp hệ thống (exception, Chrome/Playwright crash, lỗi API…)
 * trước đây chỉ nằm trong console -> PM2 hứng ra file `~/.pm2/logs/*.log`, muốn xem phải SSH
 * vào máy. Đọc thẳng file PM2 lại KHÔNG chắc ăn: server cloud (ai.basso.vn) thường KHÔNG chạy
 * PM2, đường dẫn log mỗi nơi mỗi khác. Nên thay vì đọc file, ta "nghe lén" console NGAY trong
 * tiến trình: mỗi lần code gọi console.log/warn/error, đẩy thêm 1 bản ghi vào mảng vòng này
 * (đồng thời VẪN in ra console như cũ -> PM2 file không mất gì). Dashboard chỉ việc đọc mảng đó
 * qua /api/system-logs — chạy được ở mọi kiểu deploy, không phụ thuộc PM2.
 *
 * Ring buffer = giữ tối đa MAX bản ghi gần nhất; vượt thì bản cũ nhất rớt ra (log hệ thống chỉ
 * cần "gần đây", không cần lưu vĩnh viễn -> khỏi phình RAM/đĩa).
 */

const MAX = Math.max(parseInt(process.env.SYSTEM_LOG_BUFFER || '1000', 10) || 1000, 100);

const buf = [];       // [{ seq, t, level, msg }]
let seq = 0;
let installed = false;

/** Gộp các tham số console (giống cách console tự format) thành 1 chuỗi. Lỗi -> kèm stack. */
function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      // depth:4 đủ nhìn object cấu hình; không màu (log terminal web tự tô màu theo level).
      return util.inspect(a, { depth: 4, breakLength: 120, colors: false });
    })
    .join(' ');
}

/** Đẩy 1 bản ghi vào buffer, cắt bớt khi vượt MAX. */
function record(level, msg) {
  buf.push({ seq: ++seq, t: Date.now(), level, msg });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

/**
 * Cài hook: bọc console.log/info/warn/error/debug để vừa GHI vào buffer vừa gọi hàm gốc
 * (không nuốt log gốc -> PM2 file vẫn đầy đủ). Bắt thêm uncaughtException/unhandledRejection
 * để CRASH cũng hiện trong log web. Gọi 1 lần, càng sớm càng tốt (đầu file index.js).
 */
function install() {
  if (installed) return;
  installed = true;

  const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
  for (const [method, level] of Object.entries(levels)) {
    const orig = console[method] ? console[method].bind(console) : null;
    console[method] = (...args) => {
      try { record(level, formatArgs(args)); } catch (_) { /* không để lỗi log làm sập app */ }
      if (orig) orig(...args);
    };
  }

  // Monitor: chỉ QUAN SÁT, KHÔNG chặn hành vi crash mặc định của Node (an toàn hơn 'uncaughtException').
  process.on('uncaughtExceptionMonitor', (err) => {
    try { record('error', `[uncaughtException] ${err && (err.stack || err.message) || err}`); } catch (_) { /* noop */ }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      const msg = reason instanceof Error ? (reason.stack || reason.message) : util.inspect(reason, { depth: 4 });
      record('error', `[unhandledRejection] ${msg}`);
    } catch (_) { /* noop */ }
  });
}

/**
 * Lấy các bản ghi khớp bộ lọc, MỚI NHẤT Ở ĐẦU mảng (để dashboard hiện giống terminal "mới nhất trên").
 * @param {{ level?: string, q?: string, limit?: number }} opts
 *   - level: 'error' -> chỉ lỗi; 'warn' -> cảnh báo + lỗi; bỏ trống -> tất cả.
 *   - q: lọc chuỗi con (không phân biệt hoa thường) trong nội dung.
 *   - limit: số dòng tối đa trả về (mặc định 300).
 */
function getEntries({ level, q, limit } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 300, 1), MAX);
  const needle = (q || '').trim().toLowerCase();
  // Ngưỡng mức độ: warn gộp cả error; error chỉ error. (info/debug = xem tất cả.)
  const minRank = level === 'error' ? 3 : level === 'warn' ? 2 : 0;
  const rank = (lv) => (lv === 'error' ? 3 : lv === 'warn' ? 2 : lv === 'info' ? 1 : 0);

  const out = [];
  for (let i = buf.length - 1; i >= 0 && out.length < cap; i--) {
    const e = buf[i];
    if (minRank && rank(e.level) < minRank) continue;
    if (needle && !e.msg.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}

module.exports = { install, getEntries, record, MAX };
