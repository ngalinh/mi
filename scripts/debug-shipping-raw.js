'use strict';
/**
 * DEBUG (chỉ đọc): in RAW field mà Partner API trả về cho getShippingOrderList — để soi
 * đơn AhaMove/Grab có kèm `shipper_link` (link theo dõi) trong danh sách không, và tên field đúng.
 * Chạy trên máy có Partner API:  node scripts/debug-shipping-raw.js
 */
const config = require('../server/config');
const { partnerApiFetch } = require('../server/bassoApi');

(async () => {
  if (config.basso.useMock) { console.log('❌ Đang MOCK — cần Partner API thật (.env).'); process.exit(1); }
  // Lọc AhaMove (shipping_id=3) trước; nếu rỗng thử Grab (7); cuối cùng tất cả.
  for (const sid of [3, 7, 0]) {
    // eslint-disable-next-line no-await-in-loop
    const data = await partnerApiFetch('/partner/getShippingOrderList', { query: { page: 1, shipping_id: sid, status: 'all' } });
    const items = data.items || data.rows || [];
    console.log(`\n== shipping_id=${sid} — total ${data.total}, trang này ${items.length} dòng ==`);
    if (!items.length) continue;
    console.log('Các field 1 dòng:', Object.keys(items[0]).join(', '));
    items.slice(0, 6).forEach((r) => {
      // dò mọi field có "link" trong tên
      const linkFields = Object.keys(r).filter((k) => /link/i.test(k)).map((k) => `${k}=${r[k]}`);
      console.log(` - #${r.id} ${r.shipping} [${r.status}] code=${r.code} | ${linkFields.join(' , ') || '(không field link)'}`);
    });
    if (items.some((r) => Object.keys(r).some((k) => /link/i.test(k)))) break;
  }
  console.log('\n👉 Gửi tôi output này — nhất là tên field chứa link (shipper_link? tracking_url?...).');
})();
