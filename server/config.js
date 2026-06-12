'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bassoBase = process.env.BASSO_API_BASE_URL || '';
const useMockEnv = (process.env.USE_MOCK || '').toLowerCase();
const useMock = useMockEnv === 'true' ? true : useMockEnv === 'false' ? false : !bassoBase;

module.exports = {
  port: parseInt(process.env.SERVER_PORT || '8080', 10),
  apiKey: process.env.API_KEY || '',
  playwrightLocalUrl: process.env.PLAYWRIGHT_LOCAL_URL || 'http://localhost:8090',
  basso: {
    baseUrl: bassoBase.replace(/\/$/, ''),
    partnerApiKey: process.env.BASSO_API_KEY || '',
    email: process.env.BASSO_EMAIL || '',
    pass: process.env.BASSO_PASS || '',
    useMock,
    autoUpdateStatus: String(process.env.AUTO_UPDATE_STATUS || 'true').toLowerCase() === 'true',
  },
  // Tự động báo hàng: cứ có đơn "Chưa báo" (đã về kho) là tự gửi tin, không cần bấm tay.
  autoNotify: {
    enabled: String(process.env.AUTO_NOTIFY || 'false').toLowerCase() === 'true',
    intervalMs: Math.max(parseInt(process.env.AUTO_NOTIFY_INTERVAL_MS || '120000', 10) || 120000, 10000),
    profile: process.env.AUTO_NOTIFY_PROFILE || 'default',
    account: process.env.AUTO_NOTIFY_ACCOUNT || undefined,
    // Số lần thử lại tối đa cho 1 đơn nếu gửi lỗi (tránh spam khi local-runner offline)
    maxRetries: Math.max(parseInt(process.env.AUTO_NOTIFY_MAX_RETRIES || '3', 10) || 3, 1),
    // Bí mật bảo vệ webhook /api/webhook/arrived (so khớp header x-webhook-secret). Trống = không kiểm tra.
    webhookSecret: process.env.AUTO_NOTIFY_WEBHOOK_SECRET || '',
  },
  dbPath: path.join(__dirname, '..', 'data', 'doraemi.sqlite'),
};
