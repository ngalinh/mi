'use strict';
const { getPage, closeContext } = require('./browser');
const retryable = error => /timeout|timed out|net::|Target.*closed|browser.*closed|page.*closed|KHONG_THAY_O_TIM_KIEM/i.test(error.message || '');

// Only preparation is retried. Once send starts its result may be ambiguous.
async function prepareWithRetry(profile, prepare) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const page = await getPage(profile);
      const value = await prepare(page);
      return { page, value };
    } catch (err) {
      if (!retryable(err)) throw err;
      if (attempt === 1) throw new Error(`ACCOUNT_UNAVAILABLE: ${err.message}`);
      if (/closed|crash/i.test(err.message)) await closeContext(profile);
      else {
        const page = await getPage(profile);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    }
  }
}
module.exports = { prepareWithRetry };
