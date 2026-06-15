'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

/**
 * Quản lý 1 persistent context cho mỗi profile (account Salework/Zalo).
 * Giữ context sống giữa các lần gửi để không phải mở/đóng browser liên tục
 * và để giữ trạng thái đăng nhập.
 */

const contexts = new Map(); // profileName -> { context, lastUsed }

function profilePath(profileName) {
  const safe = String(profileName || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(config.dataDir, `salework-${safe}`);
}

async function safeLaunchPersistentContext(userDataDir) {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  return chromium.launchPersistentContext(userDataDir, {
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: { width: 1366, height: 850 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

/**
 * Lấy (hoặc tạo) context cho profile và trả về 1 page sẵn sàng.
 */
async function getContext(profileName) {
  let entry = contexts.get(profileName);
  if (entry && entry.context) {
    // kiểm tra context còn sống
    try {
      entry.context.pages();
      entry.lastUsed = Date.now();
      return entry.context;
    } catch {
      contexts.delete(profileName);
    }
  }
  const context = await safeLaunchPersistentContext(profilePath(profileName));
  context.on('close', () => contexts.delete(profileName));
  entry = { context, lastUsed: Date.now() };
  contexts.set(profileName, entry);
  return context;
}

async function getPage(profileName) {
  const context = await getContext(profileName);
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  return page;
}

/** Kiểm tra profile đã từng đăng nhập (có thư mục data) chưa */
function profileExists(profileName) {
  return fs.existsSync(profilePath(profileName));
}

/** Đóng trình duyệt của 1 profile (session đăng nhập vẫn lưu trong userDataDir nên lần sau mở lại vẫn đăng nhập). */
async function closeContext(profileName) {
  const entry = contexts.get(profileName);
  if (!entry) return;
  try { await entry.context.close(); } catch { /* ignore */ }
  contexts.delete(profileName);
}

async function closeAll() {
  for (const [name, entry] of contexts) {
    try { await entry.context.close(); } catch { /* ignore */ }
    contexts.delete(name);
  }
}

module.exports = { getContext, getPage, profileExists, profilePath, closeContext, closeAll };
