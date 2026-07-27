'use strict';
/**
 * Test kết nối "Quản lý giao hàng" (web admin Basso) — CHỈ ĐỌC.
 * Chạy: node scripts/test-shipping.js
 *
 * Đọc cấu hình từ .env: BASSO_WEB_BASE_URL, BASSO_WEB_COOKIE.
 * KHÔNG thao tác đổi trạng thái đơn (chỉ gọi getShippingOrders) -> an toàn chạy trên dữ liệu thật.
 */
const config = require('../server/config');
const { getShippingOrders } = require('../server/shippingApi');

const ok = (s) => console.log(`✅ ${s}`);
const bad = (s) => console.log(`❌ ${s}`);
const info = (s) => console.log(`   ${s}`);

function diagnose(err) {
  const m = String((err && err.message) || err);
  if (/cookie|html|đăng nhập|login/i.test(m)) return 'Cookie ci_session sai/hết hạn -> lấy lại BASSO_WEB_COOKIE từ trình duyệt đã đăng nhập.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Không phân giải được tên miền -> kiểm tra BASSO_WEB_BASE_URL.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout|fetch failed/i.test(m)) return 'Không kết nối được -> URL/firewall/Basso chặn IP.';
  return m;
}

(async () => {
  console.log('=== Test Quản lý giao hàng (Basso web) ===\n');
  console.log(`BASSO_WEB_BASE_URL = ${config.bassoWeb.baseUrl}`);
  info(`Có cookie: ${config.bassoWeb.cookie ? 'có' : 'KHÔNG'}\n`);

  if (config.bassoWeb.useMock) {
    bad('Chưa cấu hình BASSO_WEB_COOKIE -> đang ở chế độ MOCK (không đọc web thật).');
    info('Điền BASSO_WEB_COOKIE trong .env rồi chạy lại.');
    process.exit(1);
  }

  try {
    const t0 = Date.now();
    const { orders, pagination, hasInventoryManagerRole } = await getShippingOrders({ page: 1, status: 'all' });
    ok(`getShippingOrders OK (${Date.now() - t0}ms) — trang này ${orders.length} đơn, tổng ${pagination ? pagination.total_item : '?'} đơn / ${pagination ? pagination.total_page : '?'} trang.`);
    info(`Quyền quản lý kho: ${hasInventoryManagerRole ? 'có' : 'không'}`);
    if (orders.length) {
      const o = orders[0];
      info(`Đơn mẫu: #${o.id} · ${o.recipient} · ${o.phone} · MVĐ ${o.trackingCode || '(chưa có)'} · ${o.shipping} · ${o.status} · ${o.items.length} SP`);
    }
    console.log('\n🎉 Kết nối "Quản lý giao hàng" hoạt động.');
  } catch (err) {
    bad('getShippingOrders lỗi.');
    info('Gợi ý: ' + diagnose(err));
    info('Lỗi gốc: ' + String((err && err.message) || err));
    process.exit(2);
  }
})();
