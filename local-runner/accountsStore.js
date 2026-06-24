'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Lưu/đọc danh sách tài khoản Zalo (port từ flow quản lý tài khoản của Xeko — Hướng B:
 * MỖI tài khoản 1 profile browser riêng).
 *
 * Mỗi tài khoản:
 *   - key         : định danh duy nhất + cũng là tên "profile" browser (playwright-data/salework-<key>)
 *   - name        : tên NHÂN VIÊN / nhãn hiển thị (cột "Nhân viên")
 *   - saleworkName: TÊN account như hiện trong dropdown zalo.basso.vn (dùng để chọn account khi gửi)
 *   - phone       : (tuỳ chọn) SĐT Zalo — chỉ để hiển thị
 *   - staffId     : (tuỳ chọn) user_id của NV phụ trách — để khớp đơn → account (ưu tiên hơn tên)
 *   - autoEnabled : có cho luồng TỰ ĐỘNG gửi bằng account này không (mặc định true)
 *   - proxy       : (tuỳ chọn) "host:port" hoặc "user:pass@host:port" — ÁP DỤNG khi mở Chromium cho profile này
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

// Chuẩn hoá 1 bản ghi account: chỉ giữ field hợp lệ, ép kiểu an toàn.
function normalize(a) {
  return {
    key: String(a.key || '').trim(),
    name: String(a.name || '').trim(),
    saleworkName: String(a.saleworkName || '').trim(),
    phone: String(a.phone || '').trim(),
    staffId: a.staffId != null ? String(a.staffId).trim() : '',
    autoEnabled: a.autoEnabled === undefined ? true : !!a.autoEnabled,
    proxy: String(a.proxy || '').trim(),
    createdAt: a.createdAt || new Date().toISOString(),
    updatedAt: a.updatedAt || undefined,
  };
}

function list() {
  return load().map(normalize);
}

function get(key) {
  const a = load().find((x) => x.key === key);
  return a ? normalize(a) : null;
}

/**
 * Thêm tài khoản mới. Ném lỗi nếu thiếu trường bắt buộc hoặc key đã tồn tại.
 * @returns {object} account vừa thêm
 */
function add(input) {
  const account = normalize(input);
  if (!account.key || !account.name) throw new Error('Thiếu key hoặc tên hiển thị');
  if (!account.saleworkName) throw new Error('Thiếu saleworkName (tên account trong dropdown Zalo Basso)');
  const accounts = load();
  if (accounts.find((a) => a.key === account.key)) throw new Error(`Key "${account.key}" đã tồn tại`);
  account.createdAt = new Date().toISOString();
  accounts.push(account);
  save(accounts);
  return account;
}

/**
 * Cập nhật 1 phần thông tin account (không đổi được key). @returns {object|null} account sau cập nhật.
 */
function update(key, patch) {
  const accounts = load();
  const idx = accounts.findIndex((a) => a.key === key);
  if (idx === -1) return null;
  const merged = normalize({ ...accounts[idx], ...patch, key }); // key bất biến
  merged.createdAt = accounts[idx].createdAt || merged.createdAt;
  merged.updatedAt = new Date().toISOString();
  accounts[idx] = merged;
  save(accounts);
  return merged;
}

/** Xoá tài khoản theo key. @returns {boolean} có xoá được không */
function remove(key) {
  const accounts = load();
  const next = accounts.filter((a) => a.key !== key);
  if (next.length === accounts.length) return false;
  save(next);
  return true;
}

module.exports = { list, get, add, update, remove, load, save };
