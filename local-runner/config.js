'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  port: parseInt(process.env.LOCAL_PORT || '8090', 10),
  apiKey: process.env.API_KEY || '',
  // Bắt buộc có API_KEY (fail-closed) khi production / REQUIRE_API_KEY=true. Dev vẫn chạy được khi trống.
  requireApiKey: String(process.env.REQUIRE_API_KEY || '').toLowerCase() === 'true'
    || process.env.NODE_ENV === 'production',
  // Trang quản lý Zalo. Trước đây dùng Salework (zalo.salework.net), nay chuyển sang
  // Zalo Basso (self-hosted, giao diện Vuetify giống Salework) — giống hệt Xeko. Vẫn cho
  // override qua SALEWORK_URL nếu muốn quay lại salework.net.
  saleworkUrl: process.env.SALEWORK_URL || 'https://zalo.basso.vn',
  // Trang chat (nơi có dropdown chọn tài khoản + danh sách hội thoại). Mở mỗi lần gửi tin.
  // Ưu tiên SALEWORK_CHAT_URL; nếu không có thì suy ra từ SALEWORK_URL (+ "/chat").
  saleworkChatUrl: process.env.SALEWORK_CHAT_URL
    || `${(process.env.SALEWORK_URL || 'https://zalo.basso.vn').replace(/\/+$/, '')}/chat`,
  // Tài khoản Zalo (trong Salework/Basso) chọn trước khi gửi, khi 1 login có nhiều Zalo.
  // Để trống = dùng account đang active. Điền đúng TÊN như hiện trong dropdown.
  defaultZaloAccount: process.env.DEFAULT_ZALO_ACCOUNT || '',
  // URL trang đăng nhập (có thể khác trang chat). Mặc định dùng luôn saleworkUrl.
  saleworkLoginUrl: process.env.SALEWORK_LOGIN_URL || process.env.SALEWORK_URL || 'https://zalo.basso.vn',
  // Thông tin ĐĂNG NHẬP TỰ ĐỘNG vào Zalo Basso, DÙNG CHUNG cho MỌI profile (tất cả profile Zalo
  // của nhân viên đăng nhập qua CÙNG 1 tài khoản ZaloCRM). Áp dụng khi account trong store chưa
  // gán tài khoản/mật khẩu riêng — tức là fallback cho mọi profile, không riêng "default".
  // Zalo Basso chỉ giữ session ~1 tuần nên khi phát hiện form đăng nhập, runner tự điền tài khoản
  // + mật khẩu này rồi bấm "Đăng nhập". Để trống = KHÔNG tự đăng nhập (chạy `npm run login` tay).
  saleworkLoginUser: process.env.SALEWORK_LOGIN_USER || '',
  saleworkLoginPass: process.env.SALEWORK_LOGIN_PASS || '',
  // Giữ ấm session (tự đăng nhập lại trước khi hết hạn). Định kỳ mở từng profile Zalo CÓ lưu tài
  // khoản/mật khẩu, kiểm tra + tự đăng nhập lại nếu session đã hết -> session luôn tươi, hiếm khi
  // gặp form login (kể cả OTP) đúng lúc gửi. Mặc định BẬT. An toàn: chỉ đụng account có credential
  // (không có creds -> no-op), chạy tuần tự có khóa profile nên không đụng luồng gửi. Đặt
  // SESSION_KEEPALIVE=false để tắt (khi đó chỉ tự đăng nhập ngay lúc gửi). SESSION_KEEPALIVE_MS = chu kỳ (mặc định 12h).
  sessionKeepalive: String(process.env.SESSION_KEEPALIVE || 'true').toLowerCase() === 'true',
  sessionKeepaliveMs: parseInt(process.env.SESSION_KEEPALIVE_MS || String(12 * 60 * 60 * 1000), 10),
  // --- Facebook (báo hàng qua Messenger khi khách không dùng Zalo) ---
  // Trang mở khi ĐĂNG NHẬP Facebook (giống Xeko: mở facebook.com rồi NV đăng nhập tay, lưu session).
  facebookLoginUrl: process.env.FACEBOOK_LOGIN_URL || 'https://www.facebook.com/',
  // Trang mở khi GỬI tin / KIỂM TRA đăng nhập (Messenger inbox — có sẵn ô "Search Messenger").
  facebookChatUrl: process.env.FACEBOOK_CHAT_URL || 'https://www.facebook.com/messages/',
  headless: String(process.env.HEADLESS || 'false').toLowerCase() === 'true',
  // Làm chậm mỗi thao tác (ms) — chỉ để dễ nhìn khi debug. Đặt 0 khi chạy thật cho nhanh.
  slowMo: parseInt(process.env.SLOW_MO || '0', 10),
  // Gửi xong thì đóng trình duyệt (giải phóng tài nguyên). Đặt false để giữ context sống
  // giữa các lần gửi cho nhanh hơn khi gửi hàng loạt.
  closeAfterSend: String(process.env.CLOSE_AFTER_SEND || 'true').toLowerCase() === 'true',
  // CHẾ ĐỘ TEST: chỉ gửi thật tới các số trong TEST_PHONES; số khác bị chặn (không gửi)
  testMode: String(process.env.TEST_MODE || 'false').toLowerCase() === 'true',
  testPhones: (process.env.TEST_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Nơi lưu session đăng nhập Salework theo từng "profile" (account zalo)
  dataDir: path.join(__dirname, '..', 'playwright-data'),
  screenshotDir: path.join(__dirname, '..', 'screenshots'),
  // File lưu danh sách tài khoản Zalo (key, name, saleworkName, proxy) — quản lý qua /api/accounts.
  zaloAccountsFile: path.join(__dirname, '..', 'config', 'zalo-accounts.json'),
  // File override chế độ TEST an toàn (testMode + testPhones) — chỉnh qua UI /api/test-mode,
  // có hiệu lực NGAY không cần restart. Chưa có file -> dùng TEST_MODE/TEST_PHONES trong .env.
  testModeFile: path.join(__dirname, '..', 'config', 'test-mode.json'),
};
