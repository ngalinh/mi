'use strict';
// Legacy safety-net timing only; normal automatic shipping has no time cutoff.
const SCHEDULE_TIME = '17:30';
// Use explicit carrier metadata, never guess from customer/message text.
function isAhamove(order) {
  return Number(order.shippingId ?? order.shipping_id) === 3;
}
function isShippingTime(order, date = new Date(), timezone = 'Asia/Ho_Chi_Minh') {
  if (isAhamove(order)) return true;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return Number(values.hour) * 60 + Number(values.minute) >= 17 * 60 + 30;
}
module.exports = { SCHEDULE_TIME, isAhamove, isShippingTime };
