'use strict';
/**
 * Device fingerprint (userAgent + viewport) theo từng profile — PORT TỪ XEKO
 * (server/src/utils/device-fingerprint.js) để mi báo hàng bằng ĐÚNG "thiết bị"
 * mà Xeko dùng khi đăng bài trên CÙNG một tài khoản Facebook.
 *
 * Vì sao cần: cùng 1 account FB nếu 2 app khai báo 2 UA/viewport khác nhau, FB dễ
 * nghi "tài khoản bị chia sẻ" -> checkpoint/đăng xuất. Cho mi dùng cùng fingerprint
 * với Xeko => FB thấy 1 thiết bị nhất quán.
 *
 * Cơ chế khớp:
 *   - UA_POOL / VIEWPORT_POOL / hashIndex GIỐNG HỆT Xeko (byte-for-byte) => cùng key
 *     luôn suy ra CÙNG cặp UA+viewport ở cả 2 app (fallback tất định).
 *   - Nếu import mang sẵn userAgent/viewport lưu trong profiles-meta.json của Xeko
 *     thì ưu tiên giá trị đó (khớp tuyệt đối, kể cả khi Xeko từng đổi tay).
 *
 * Khác Xeko: KHÔNG đọc/ghi file ở đây. mi lưu fingerprint trên chính bản ghi account
 * (config/zalo-accounts.json) — 1 nguồn sự thật, tránh thêm profiles-meta.json.
 */

const crypto = require('crypto');

// Pool UA: PHẢI trùng y hệt Xeko (cùng thứ tự) để hashIndex chọn ra cùng phần tử.
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

// Pool viewport: PHẢI trùng y hệt Xeko (cùng thứ tự).
const VIEWPORT_POOL = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

function hashIndex(key, modulo) {
  if (!key) return 0;
  const h = crypto.createHash('md5').update(String(key)).digest();
  return h.readUInt32BE(0) % modulo;
}

/** Cặp UA+viewport suy ra tất định theo key (khớp pickDefault của Xeko). */
function pickDefault(key) {
  return {
    userAgent: UA_POOL[hashIndex(`${key}:ua`, UA_POOL.length)],
    viewport: VIEWPORT_POOL[hashIndex(`${key}:vp`, VIEWPORT_POOL.length)],
  };
}

const isValidViewport = (v) => v && typeof v.width === 'number' && typeof v.height === 'number';

/**
 * Lấy fingerprint cho 1 profile.
 * @param {string} key    key của account (PHẢI là chuỗi Xeko dùng để hash — chính là key gốc).
 * @param {{userAgent?:string, viewport?:{width:number,height:number}}} [stored] giá trị đã lưu (từ import).
 * @returns {{userAgent:string, viewport:{width:number,height:number}}}
 */
function getFingerprint(key, stored) {
  const def = pickDefault(key);
  const s = stored || {};
  return {
    userAgent: (typeof s.userAgent === 'string' && s.userAgent) ? s.userAgent : def.userAgent,
    viewport: isValidViewport(s.viewport) ? { width: s.viewport.width, height: s.viewport.height } : def.viewport,
  };
}

module.exports = { getFingerprint, pickDefault, UA_POOL, VIEWPORT_POOL };
