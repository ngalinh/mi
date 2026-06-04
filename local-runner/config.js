'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  port: parseInt(process.env.LOCAL_PORT || '8090', 10),
  apiKey: process.env.API_KEY || '',
  saleworkUrl: process.env.SALEWORK_URL || 'https://zalo.salework.net',
  headless: String(process.env.HEADLESS || 'false').toLowerCase() === 'true',
  slowMo: parseInt(process.env.SLOW_MO || '300', 10),
  // Nơi lưu session đăng nhập Salework theo từng "profile" (account zalo)
  dataDir: path.join(__dirname, '..', 'playwright-data'),
  screenshotDir: path.join(__dirname, '..', 'screenshots'),
};
