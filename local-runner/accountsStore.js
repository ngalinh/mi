'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Lưu/đọc danh sách tài khoản Zalo (port từ flow quản lý tài khoản của Xeko).
 *
 * Mỗi tài khoản: { key, name, saleworkName, proxy }
 *   - key         : định danh duy nhất + cũng là tên "profile" browser (playwright-data/salework-<key>)
 *   - name        : tên hiển thị cho người dùng
 *   - saleworkName: TÊN account như hiện trong dropdown zalo.basso.vn (dùng để chọn account khi gửi)
 *   - proxy       : (tuỳ chọn) lưu để tương thích Xeko. mi chạy trên máy nhân viên (IP thật) nên
 *                   CHƯA áp dụng proxy khi launch — chỉ lưu lại, không brick nếu để trống.
 *
 * Lưu ở file JSON (config.zaloAccountsFile) — đơn giản, không cần DB.
 */

function load() {
  try {
    if (fs.existsSync(config.zaloAccountsFile)) {
      const arr = JSON.parse(fs.readFileSync(config.zaloAccountsFile, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch {
    /* file hỏng -> coi như rỗng, tránh crash */
  }
  return [];
}

function save(accounts) {
  const dir = path.dirname(config.zaloAccountsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.zaloAccountsFile, JSON.stringify(accounts, null, 2));
}

function list() {
  return load();
}

function get(key) {
  return load().find((a) => a.key === key) || null;
}

/**
 * Thêm tài khoản mới. Ném lỗi nếu thiếu trường bắt buộc hoặc key đã tồn tại.
 * @returns {object} account vừa thêm
 */
function add({ key, name, saleworkName, proxy }) {
  if (!key || !name) throw new Error('Thiếu key hoặc tên hiển thị');
  if (!saleworkName) throw new Error('Thiếu saleworkName (tên account trong dropdown Zalo Basso)');
  const accounts = load();
  if (accounts.find((a) => a.key === key)) throw new Error(`Key "${key}" đã tồn tại`);
  const account = { key, name, saleworkName, proxy: (proxy || '').trim() };
  accounts.push(account);
  save(accounts);
  return account;
}

/** Xoá tài khoản theo key. @returns {boolean} có xoá được không */
function remove(key) {
  const accounts = load();
  const next = accounts.filter((a) => a.key !== key);
  if (next.length === accounts.length) return false;
  save(next);
  return true;
}

module.exports = { list, get, add, remove, load, save };
