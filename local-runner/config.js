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
};
