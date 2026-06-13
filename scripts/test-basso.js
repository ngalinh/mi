'use strict';
/**
 * Test kết nối Basso ↔ mi (chỉ ĐỌC: login + getArrivedVnList + getArrivedVnItems).
 * Chạy: npm run test:basso
 *
 * Đọc cấu hình từ .env (BASSO_API_BASE_URL, BASSO_API_KEY, BASSO_EMAIL, BASSO_PASS).
 * Không gửi Zalo, không đụng tới local-runner — chỉ kiểm tra phần API website.
 */
const config = require('../server/config');
const { getOrders, getArrivedItems } = require('../server/bassoApi');

const ok = (s) => console.log(`✅ ${s}`);
const bad = (s) => console.log(`❌ ${s}`);
const info = (s) => console.log(`   ${s}`);

function diagnose(err) {
  const m = String(err && err.message || err);
  if (/login/i.test(m)) return 'Sai BASSO_EMAIL/BASSO_PASS hoặc BASSO_API_KEY (login thất bại).';
  if (/401|403/.test(m)) return 'Bị từ chối (401/403): kiểm tra X-Partner-Api-Key / quyền tài khoản.';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'Không phân giải được tên miền: kiểm tra BASSO_API_BASE_URL.';
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|fetch failed/i.test(m)) return 'Không kết nối được: sai URL, firewall, hoặc Basso chặn IP máy này.';
  return m;
}

(async () => {
  console.log('=== Test kết nối Basso ↔ mi ===\n');

  console.log(`BASSO_API_BASE_URL = ${config.basso.baseUrl || '(trống)'}`);
  if (config.basso.useMock) {
    bad('Đang ở chế độ MOCK (chưa đọc Basso thật).');
    info('Điền BASSO_API_BASE_URL trong .env và đặt USE_MOCK=false rồi chạy lại.');
    process.exit(1);
  }
  info(`Tài khoản login: ${config.basso.email || '(trống)'}`);
  info(`Có Partner API key: ${config.basso.partnerApiKey ? 'có' : 'KHÔNG'}\n`);

  // 1) Login + lấy danh sách (getOrders tự login bên trong)
  let orders = [];
  try {
    const t0 = Date.now();
    const res = await getOrders({ pageSize: 5 });
    orders = res.orders || [];
    ok(`Login + getArrivedVnList OK (${Date.now() - t0}ms) — nguồn=${res.source}, tổng=${res.total}, nhân viên=${(res.tabUsers || []).length}`);
    if (orders.length) {
      const o = orders[0];
      info(`Đơn mẫu: #${o.id} · ${o.customerName} · ${o.phone} · ${o.warehouseDate} · ${o.status}`);
    } else {
      info('Kết nối OK nhưng danh sách rỗng (có thể do bộ lọc/ngày — thử dashboard với khoảng ngày rộng hơn).');
    }
  } catch (err) {
    bad('getArrivedVnList lỗi.');
    info(diagnose(err));
    process.exit(2);
  }

  // 2) Lấy chi tiết SP của đơn đầu tiên
  if (orders.length) {
    const o = orders[0];
    try {
      const r = await getArrivedItems({ id: o.id, customerId: o.customerId, dateInventory: o.dateInventory });
      ok(`getArrivedVnItems OK — ${(r.items || []).length} sản phẩm cho đơn #${o.id}`);
    } catch (err) {
      bad('getArrivedVnItems lỗi (danh sách vẫn OK, chỉ lỗi phần chi tiết).');
      info(diagnose(err));
    }
  }

  console.log('\n🎉 Kết nối Basso ↔ mi hoạt động.');
})();
