'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Lịch sử đăng nhập / kết nối của từng profile Zalo (port từ login-history của Xeko).
 * Ghi nối tiếp vào 1 file JSON (mảng), giữ tối đa MAX_ENTRIES bản ghi gần nhất.
 *
 * type gợi ý: 'login' | 'logout' | 'session_ok' | 'session_expired' | 'delete'
 */

const HISTORY_FILE = path.join(path.dirname(config.zaloAccountsFile), 'login-history.json');
const MAX_ENTRIES = 500;

function load() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch {
    /* hỏng -> rỗng */
  }
  return [];
}

function save(entries) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2));
}

function add(key, name, type, note) {
  const entries = load();
  entries.push({ key, name: name || key, type, note: note || '', at: new Date().toISOString() });
  save(entries);
}

/** Lấy lịch sử (mới nhất trước). Truyền key để lọc theo 1 profile. */
function list(key) {
  const entries = load().reverse();
  return key ? entries.filter((e) => e.key === key) : entries;
}

/** Lần ghi nhận gần nhất của 1 profile (để suy ra trạng thái kết nối). */
function latest(key) {
  return list(key)[0] || null;
}

module.exports = { add, list, latest };
