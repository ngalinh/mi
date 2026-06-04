'use strict';
/**
 * Kiểm tra nhanh: Playwright mở được zalo.salework.net và render trang (login) hay không.
 * Chạy headless, KHÔNG đụng tới profile "default" (dùng context tạm, đóng ngay sau khi xong).
 *   node local-runner/verify-salework.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

(async () => {
  const url = config.saleworkUrl;
  console.log(`[verify] Mở ${url} (headless) ...`);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 850 } });
  const out = {};
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    out.httpStatus = resp ? resp.status() : null;
    out.finalUrl = page.url();
    out.title = await page.title().catch(() => '');
    out.hasLoginForm = await page
      .locator('input[type="password"], input[placeholder*="mật khẩu" i], button:has-text("Đăng nhập")')
      .first().isVisible().catch(() => false);
    out.hasSearchBox = await page
      .locator('input[placeholder*="Tìm kiếm"], input[placeholder*="Search"]')
      .first().isVisible().catch(() => false);

    if (!fs.existsSync(config.screenshotDir)) fs.mkdirSync(config.screenshotDir, { recursive: true });
    const shot = path.join(config.screenshotDir, 'verify-salework.png');
    await page.screenshot({ path: shot, fullPage: false });
    out.screenshot = shot;
  } catch (err) {
    out.error = err.message;
  } finally {
    await browser.close();
  }
  console.log('[verify] Kết quả:', JSON.stringify(out, null, 2));
})();
