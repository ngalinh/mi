'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Lưu/đọc danh sách tài khoản báo hàng (port từ flow quản lý tài khoản của Xeko — Hướng B:
 * MỖI tài khoản 1 profile browser riêng). Từ nay chứa CẢ Zalo lẫn Facebook (phân biệt qua
 * `platform`) để 1 nhân viên có thể gán cả 2 loại — gom chung 1 chỗ cấu hình.
 *
 * Mỗi tài khoản:
 *   - platform    : 'zalo' (mặc định) | 'facebook'. Quyết định kênh gửi + prefix thư mục profile
 *                   (salework-<key> cho Zalo, fb-<key> cho Facebook).
 *   - key         : định danh duy nhất + cũng là tên "profile" browser
 *   - name        : tên NHÂN VIÊN / nhãn hiển thị (cột "Nhân viên")
 *   - saleworkName: (Zalo) TÊN account như hiện trong dropdown zalo.basso.vn (chọn account khi gửi).
 *                   KHÔNG bắt buộc với Facebook.
 *   - fbName      : (Facebook, tuỳ chọn) tên/nhãn tài khoản FB để hiển thị.
 *   - phone       : (tuỳ chọn) SĐT của tài khoản — chỉ để hiển thị
 *   - staffId     : (tuỳ chọn) user_id của NV phụ trách — để khớp đơn → account (ưu tiên hơn tên).
 *                   Cũng là khoá GOM tài khoản Zalo + Facebook về cùng 1 nhân viên trên UI.
 *   - brand       : (Zalo, tuỳ chọn) prefix mã đơn của brand account này phụ trách (vd "BS", "SU", "CO").
 *                   1 NV có thể có NHIỀU account, mỗi account 1 brand → đơn được gửi bằng account
 *                   khớp prefix mã đơn. Để trống = account "chung", nhận mọi brand của NV đó.
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
  const platform = a.platform === 'facebook' ? 'facebook' : 'zalo';
  return {
    // Kênh gửi. Bản ghi cũ không có field này -> mặc định 'zalo' (giữ nguyên hành vi).
    platform,
    key: String(a.key || '').trim(),
    name: String(a.name || '').trim(),
    saleworkName: String(a.saleworkName || '').trim(),
    // Nhãn tài khoản Facebook (tuỳ chọn) — chỉ dùng để hiển thị.
    fbName: String(a.fbName || '').trim(),
    phone: String(a.phone || '').trim(),
    staffId: a.staffId != null ? String(a.staffId).trim() : '',
    // Prefix mã đơn (brand) — chuẩn hoá UPPERCASE để so khớp không phân biệt hoa/thường.
    brand: a.brand != null ? String(a.brand).trim().toUpperCase() : '',
    autoEnabled: a.autoEnabled === undefined ? true : !!a.autoEnabled,
    // Mốc ISO khi account được BẬT "Tự động báo" (dùng để bot chỉ gửi đơn về từ đây trở đi,
    // bỏ qua tồn đọng cũ). Trống = chưa từng đóng dấu -> không lọc theo ngày (hành vi cũ).
    autoEnabledAt: a.autoEnabledAt || undefined,
    // KIỂU BÁO của NV này: 'group' = báo vào NHÓM (bấm tab "Nhóm", chỉ chọn hội thoại nhóm),
    // 'personal' = nhắn TIN CÁ NHÂN (không bấm tab Nhóm; tìm chat 1-1 trong "Trò chuyện", không
    // ra thì mở từ "Người dùng Zalo"). Mặc định 'group' để giữ nguyên hành vi cũ.
    notifyTarget: a.notifyTarget === 'personal' ? 'personal' : 'group',
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
  // saleworkName chỉ bắt buộc với Zalo (để chọn đúng account trong dropdown zalo.basso.vn).
  // Facebook không có dropdown account nên bỏ qua.
  if (account.platform !== 'facebook' && !account.saleworkName) {
    throw new Error('Thiếu saleworkName (tên account trong dropdown Zalo Basso)');
  }
  const accounts = load();
  if (accounts.find((a) => a.key === account.key)) throw new Error(`Key "${account.key}" đã tồn tại`);
  account.createdAt = new Date().toISOString();
  // Account mới bật auto -> đóng dấu mốc NGAY để bot chỉ báo đơn về từ nay, không blast tồn đọng.
  if (account.autoEnabled) account.autoEnabledAt = account.createdAt;
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
  const prev = normalize(accounts[idx]);
  // key & platform bất biến khi sửa (đổi platform = xoá thêm lại).
  const merged = normalize({ ...accounts[idx], ...patch, key, platform: prev.platform });
  merged.createdAt = accounts[idx].createdAt || merged.createdAt;
  merged.updatedAt = new Date().toISOString();
  // Chuyển TẮT -> BẬT "Tự động báo": đóng dấu mốc mới = giờ hiện tại -> bot chỉ báo đơn về từ
  // đây trở đi (bỏ qua tồn đọng cũ, tránh nhắn trùng khách đã xử lý tay). Các sửa khác (proxy,
  // tên...) hoặc bật->bật không đổi mốc. Tắt thì bỏ mốc để lần bật sau luôn tính lại từ đầu.
  if (merged.autoEnabled && !prev.autoEnabled) merged.autoEnabledAt = merged.updatedAt;
  else if (!merged.autoEnabled) merged.autoEnabledAt = undefined;
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
