'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  port: parseInt(process.env.LOCAL_PORT || '8090', 10),
  apiKey: process.env.API_KEY || '',
  saleworkUrl: process.env.SALEWORK_URL || 'https://zalo.salework.net',
  // Tài khoản Zalo (trong Salework) chọn trước khi gửi, khi 1 login có nhiều Zalo.
  // Để trống = dùng account đang active. Điền đúng TÊN như hiện trong dropdown Salework.
  defaultZaloAccount: process.env.DEFAULT_ZALO_ACCOUNT || '',
  // URL trang đăng nhập (có thể khác trang chat). Mặc định dùng luôn saleworkUrl.
  saleworkLoginUrl: process.env.SALEWORK_LOGIN_URL || process.env.SALEWORK_URL || 'https://zalo.salework.net',
  headless: String(process.env.HEADLESS || 'false').toLowerCase() === 'true',
  slowMo: parseInt(process.env.SLOW_MO || '300', 10),
  // CHẾ ĐỘ TEST: chỉ gửi thật tới các số trong TEST_PHONES; số khác bị chặn (không gửi)
  testMode: String(process.env.TEST_MODE || 'false').toLowerCase() === 'true',
  testPhones: (process.env.TEST_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Nơi lưu session đăng nhập Salework theo từng "profile" (account zalo)
  dataDir: path.join(__dirname, '..', 'playwright-data'),
  screenshotDir: path.join(__dirname, '..', 'screenshots'),
};
