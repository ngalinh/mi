'use strict';
/**
 * Test "Quản lý giao hàng" qua Partner API (mục 8.10) — CHỈ ĐỌC.
 * Chạy: node scripts/test-shipping.js   (dùng chung credentials Partner API trong .env)
 * Không thao tác đổi trạng thái -> an toàn chạy trên dữ liệu thật.
 */
const config = require('../server/config');
const { getShippingMeta, getShippingOrders } = require('../server/shippingApi');

const ok = (s) => console.log(`✅ ${s}`);
const bad = (s) => console.log(`❌ ${s}`);
const info = (s) => console.log(`   ${s}`);

(async () => {
  console.log('=== Test Quản lý giao hàng (Partner API) ===\n');
  if (config.basso.useMock) {
    bad('Chưa cấu hình Partner API (BASSO_API_BASE_URL) -> đang MOCK.');
    info('Điền BASSO_API_BASE_URL/BASSO_API_KEY/BASSO_EMAIL/BASSO_PASS trong .env rồi chạy lại.');
    process.exit(1);
  }
  try {
    const t0 = Date.now();
    const meta = await getShippingMeta();
    ok(`getShippingOrderMeta OK (${Date.now() - t0}ms) — ${(meta.shipping_agencies || []).length} ĐVVC, ${(meta.statuses || []).length} trạng thái, quyền kho: ${meta.has_inventory_manager_role ? 'có' : 'không'}`);
  } catch (e) {
    bad('getShippingOrderMeta lỗi: ' + e.message);
  }
  try {
    const t0 = Date.now();
    const { orders, total, source } = await getShippingOrders({ page: 1, status: 'all' });
    ok(`getShippingOrderList OK (${Date.now() - t0}ms) — nguồn=${source}, tổng ${total} đơn, trang này ${orders.length}.`);
    if (orders.length) {
      const o = orders[0];
      info(`Đơn mẫu: #${o.id} · ${o.recipient} · ${o.phone} · MVĐ ${o.trackingCode || '(chưa có)'} · ${o.shipping} · ${o.status} · ${o.items.length} SP`);
    }
    console.log('\n🎉 Partner API "Quản lý giao hàng" hoạt động.');
  } catch (e) {
    bad('getShippingOrderList lỗi: ' + e.message);
    process.exit(2);
  }
})();
