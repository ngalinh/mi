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
  dbPath: path.join(__dirname, '..', 'data', 'doraemi.sqlite'),
};
