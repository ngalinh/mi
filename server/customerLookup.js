'use strict';

// Resolve every available order code before choosing a destination. Never guess
// the purchaser from the recipient name or from only the first matching item.
async function findOrderCustomer(codes, lookup) {
  const unique = [...new Set(codes.map(code => String(code || '').trim()).filter(Boolean))];
  if (!unique.length) throw new Error('Không có mã đơn để tra khách đặt hàng.');
  let owner;
  const phoneKey = phone => String(phone || '').replace(/\D/g, '').replace(/^84(?=\d{9}$)/, '0') || String(phone || '').trim();
  for (const code of unique) {
    const hit = await lookup(code);
    if (!hit || !String(hit.phone || '').trim()) {
      throw new Error(`Không tra được thông tin khách đặt hàng từ mã đơn ${code}.`);
    }
    if (owner && ((owner.customerId != null && hit.customerId != null && String(owner.customerId) !== String(hit.customerId))
      || phoneKey(owner.phone) !== phoneKey(hit.phone))) {
      throw new Error('Các mã đơn thuộc nhiều khách đặt hàng khác nhau — chưa thể chọn người nhận thông báo.');
    }
    owner = hit;
  }
  return owner;
}

// A failed explicitly selected Zalo sender must not force the purchaser's
// Facebook notification back through that Zalo account.
function facebookFallbackOptions(opts) {
  const { account, profile, channel, ...rest } = opts;
  return { ...rest, channel: 'facebook' };
}

module.exports = { findOrderCustomer, facebookFallbackOptions };
