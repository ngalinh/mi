'use strict';

// Wait for the next usable UI state, not networkidle (chat keeps live connections).
// Conditions must remain true for a full second so Vue can finish rendering.
async function waitUntil(page, step, condition, { timeoutMs = 30000, stableMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let readySince = null;
  while (Date.now() < deadline) {
    if (await condition()) {
      if (readySince === null) readySince = Date.now();
      if (Date.now() - readySince >= stableMs) return;
    } else readySince = null;
    await page.waitForTimeout(250);
  }
  throw new Error(`UI_NOT_READY: timeout chờ ${step}; đã dừng trước bước tiếp theo.`);
}

async function notBusy(page) {
  return await page.locator('[aria-busy="true"]:visible, .v-progress-linear--indeterminate:visible, .v-progress-circular--indeterminate:visible').count() === 0;
}

async function waitControl(page, selector, step, { editable = false, ...options } = {}) {
  const control = page.locator(selector).first();
  await waitUntil(page, step, async () =>
    await notBusy(page) && await control.isVisible()
    && (editable ? await control.isEditable() : await control.isEnabled()), options);
  return control;
}

module.exports = { waitUntil, waitControl, notBusy };
