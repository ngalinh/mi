'use strict';
const { resolveForOrder } = require('./accountResolver');
const { getContactReportTarget } = require('./db');

// Read-only: use the same resolver and contact override as notifyOne.
async function previewOrders(orders) {
  const results = [];
  for (const order of orders) {
    try {
      const resolved = await resolveForOrder(order, {
        profile: order.profile, account: order.account,
      });
      results.push({ id: String(order.id), channel: resolved.channel || 'zalo',
        account: resolved.account || '', profile: resolved.profile,
        target: getContactReportTarget(order.phone) || resolved.notifyTarget || 'group',
        error: resolved.skip ? (resolved.skipReason || 'Chưa có tài khoản') : null });
    } catch (error) {
      results.push({ id: String(order.id), error: error.message });
    }
  }
  return results;
}
module.exports = { previewOrders };
