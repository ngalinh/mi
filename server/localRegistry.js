'use strict';

/**
 * Sổ đăng ký local-runner — lưu URL runner trong RAM (giống Xeko).
 *
 * Vì sao trong RAM? Nền tảng cloud (ai.basso.vn) có thể restart/reload bất cứ lúc nào,
 * khi đó URL bị xóa. Runner tự gọi POST /api/register-local theo nhịp heartbeat (mặc định
 * 30s/lần) nên server luôn có URL mới nhất, kể cả sau khi cloud khởi động lại.
 *
 * Lợi ích so với PLAYWRIGHT_LOCAL_URL tĩnh: đổi IP/tunnel không cần sửa .env của server —
 * runner tự đẩy địa chỉ mới lên.
 */

// Coi runner là "còn sống" nếu heartbeat gần nhất trong khoảng này (gấp ~3 lần chu kỳ 30s).
const FRESH_MS = 90 * 1000;

let state = { url: '', lastSeen: 0 };

/**
 * Runner gọi để khai báo URL của mình. CHỈ nhận URL http/https hợp lệ — chặn các scheme lạ
 * (file:, javascript:, gopher:…) để giảm rủi ro SSRF: server sẽ forward request KÈM x-api-key
 * và dữ liệu khách tới URL này. (Việc xác thực apiKey nằm ở tầng route /api/register-local.)
 */
function register(url) {
  const clean = String(url || '').trim().replace(/\/$/, '');
  if (!clean) return false;
  let parsed;
  try { parsed = new URL(clean); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  state = { url: clean, lastSeen: Date.now() };
  return true;
}

/** URL còn "tươi" (heartbeat gần đây) hay đã cũ. */
function isFresh() {
  return !!state.url && Date.now() - state.lastSeen < FRESH_MS;
}

/** URL đã đăng ký nếu còn tươi, ngược lại trả '' để bên gọi fallback sang config tĩnh. */
function getFreshUrl() {
  return isFresh() ? state.url : '';
}

/** Thông tin hiển thị cho /api/health. */
function getInfo() {
  return {
    url: state.url || '',
    lastSeen: state.lastSeen || 0,
    fresh: isFresh(),
    ageMs: state.lastSeen ? Date.now() - state.lastSeen : null,
  };
}

module.exports = { register, getFreshUrl, isFresh, getInfo, FRESH_MS };
