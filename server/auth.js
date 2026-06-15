'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { createBassoClient } = require('./bassoApi');

/**
 * Đăng nhập nhân viên — MỖI NGƯỜI 1 TÀI KHOẢN BASSO RIÊNG.
 *
 * - Danh sách người được cấp quyền nằm ở file `data/accounts.json` (gitignore).
 *   Mỗi phần tử: { "email": "...", "name": "..." }  (KHÔNG lưu mật khẩu ở đây).
 *   Thêm/xóa nhân viên = sửa file; đọc lại mỗi lần đăng nhập nên không cần restart.
 * - Khi login: kiểm tra email có trong danh sách -> dùng email + mật khẩu nhân viên nhập
 *   để login Basso (validate trực tiếp). Đúng thì tạo session giữ 1 bassoClient riêng cho
 *   người đó (token cache độc lập) -> mọi request dữ liệu chạy dưới tài khoản của họ.
 * - Session lưu trong RAM (mất khi restart server, người dùng đăng nhập lại). Mật khẩu chỉ
 *   nằm trong closure của bassoClient ở RAM, KHÔNG ghi ra đĩa.
 */

const COOKIE = 'doraemi_sid';
const sessions = new Map(); // sid -> { email, name, client, createdAt, lastSeen }

// ---- Roster (danh sách tài khoản) ----
function loadAccounts() {
  try {
    const raw = fs.readFileSync(config.auth.accountsPath, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function findAccount(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return loadAccounts().find((a) => String(a.email || '').trim().toLowerCase() === e) || null;
}

/**
 * Tạo file accounts.json nếu chưa có. Nếu .env có BASSO_EMAIL thì seed sẵn tài khoản đó
 * (giữ tương thích với cấu hình 1-tài-khoản hiện tại). Nếu không, tạo mảng rỗng + log hướng dẫn.
 */
function ensureAccountsFile() {
  const p = config.auth.accountsPath;
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const seed = config.basso.email
    ? [{ email: config.basso.email, name: 'Tài khoản hệ thống' }]
    : [];
  fs.writeFileSync(p, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  console.log(`[auth] Đã tạo ${p} (${seed.length} tài khoản). Thêm/xóa nhân viên bằng cách sửa file này.`);
}

// ---- Cookie helpers (không cần thêm dependency) ----
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSession(req) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.lastSeen > config.auth.sessionTtlMs) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = Date.now();
  s.sid = sid;
  return s;
}

// ---- Đăng nhập / đăng xuất ----
/**
 * @returns {Promise<{sid, user:{email,name}}>}
 * @throws nếu email không được cấp quyền hoặc sai mật khẩu Basso.
 */
async function login(email, pass) {
  const acc = findAccount(email);
  if (!acc) {
    throw new Error('Tài khoản chưa được cấp quyền truy cập. Liên hệ quản trị để được thêm.');
  }
  if (!pass) throw new Error('Vui lòng nhập mật khẩu.');

  const client = createBassoClient({ email: acc.email, pass });

  if (config.basso.useMock) {
    // Chế độ MOCK: không có Basso thật để validate. Cho phép đăng nhập để test giao diện
    // (nếu roster có field `pass` thì so khớp, không thì chấp nhận mọi mật khẩu khác rỗng).
    if (acc.pass != null && String(acc.pass) !== String(pass)) {
      throw new Error('Sai mật khẩu (chế độ MOCK).');
    }
  } else {
    // Validate trực tiếp với Basso: login thành công nghĩa là email/pass đúng.
    await client.login();
  }

  const sid = crypto.randomBytes(24).toString('hex');
  const user = { email: acc.email, name: acc.name || acc.email };
  sessions.set(sid, { ...user, client, createdAt: Date.now(), lastSeen: Date.now() });
  return { sid, user };
}

function logout(req) {
  const sid = parseCookies(req)[COOKIE];
  if (sid) sessions.delete(sid);
}

function setSessionCookie(res, sid) {
  res.cookie(COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: config.auth.sessionTtlMs,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// ---- Middleware gác cửa ----
/**
 * Yêu cầu đăng nhập. Request /api/* chưa đăng nhập -> 401 JSON; còn lại -> redirect /login.html.
 * Gắn req.session và req.basso (bassoClient của người dùng) cho các handler phía sau.
 */
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, auth: false, error: 'Chưa đăng nhập' });
    }
    return res.redirect('/login.html');
  }
  req.session = s;
  req.basso = s.client;
  next();
}

module.exports = {
  COOKIE,
  ensureAccountsFile,
  loadAccounts,
  login,
  logout,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
};
