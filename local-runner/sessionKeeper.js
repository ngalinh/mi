'use strict';
const config = require('./config');
const accountsStore = require('./accountsStore');
const loginHistory = require('./loginHistory');
const { profileExists } = require('./browser');
const { checkLoggedIn, loginCredsFor } = require('./salework');

/**
 * GIỮ ẤM SESSION ZALO BASSO — tự đăng nhập lại TRƯỚC khi session hết hạn.
 *
 * Zalo Basso chỉ giữ session ~1 tuần cho mỗi profile. Nếu để tới lúc gửi mới phát hiện hết hạn
 * thì tuy đã có tự-đăng-nhập-khi-gửi (salework.ensureLoggedIn), vẫn tốn 1 lượt gửi để login.
 * Module này định kỳ mở TỪNG profile Zalo CÓ lưu tài khoản/mật khẩu, gọi checkLoggedIn — hàm này
 * tự đăng nhập lại nếu thấy form login — nên session luôn tươi. Chỉ chạy khi SESSION_KEEPALIVE=true
 * (mặc định tắt để không tự mở trình duyệt ngoài ý muốn).
 *
 * Chạy tuần tự từng account (dựa withProfileLock trong checkLoggedIn nên an toàn với luồng gửi).
 */

let timer = null;

// Account Zalo đủ điều kiện giữ ấm: đã có session (profile tồn tại) + có credential để tự login.
function keepableAccounts() {
  return accountsStore
    .list()
    .filter((a) => a.platform !== 'facebook' && profileExists(a.key) && loginCredsFor(a.key));
}

async function runOnce() {
  const accounts = keepableAccounts();
  if (!accounts.length) return;
  console.log(`[keepalive] Kiểm tra ${accounts.length} profile Zalo (tự đăng nhập lại nếu hết hạn)…`);
  for (const a of accounts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await checkLoggedIn(a.key);
      if (r.autoLoggedIn) {
        loginHistory.add(a.key, a.name, 'login', 'Giữ ấm session: tự đăng nhập lại thành công');
        console.log(`[keepalive] "${a.name}" (${a.key}) đã hết hạn -> tự đăng nhập lại OK.`);
      } else if (!r.loggedIn) {
        loginHistory.add(a.key, a.name, 'session_expired', r.error || 'Giữ ấm: chưa đăng nhập lại được');
        console.warn(`[keepalive] "${a.name}" (${a.key}) chưa vào lại được: ${r.error || ''}`);
      }
    } catch (e) {
      console.warn(`[keepalive] Lỗi kiểm tra "${a.key}": ${e.message}`);
    }
  }
}

/** Khởi động vòng lặp giữ ấm (no-op nếu SESSION_KEEPALIVE tắt). */
function start() {
  if (!config.sessionKeepalive) return;
  const ms = Math.max(60 * 1000, config.sessionKeepaliveMs || 0);
  console.log(`[keepalive] BẬT giữ ấm session Zalo mỗi ${Math.round(ms / 60000)} phút.`);
  // Chạy 1 lượt sau 30s (đợi runner ổn định) rồi lặp theo chu kỳ.
  setTimeout(() => { runOnce().catch(() => {}); }, 30 * 1000);
  timer = setInterval(() => { runOnce().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
