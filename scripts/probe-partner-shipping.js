'use strict';
/**
 * DÒ xem Partner API (api.basso.vn) có sẵn endpoint GIAO HÀNG không — để KHỎI phải dùng cookie
 * web (basso.vn). Dùng ĐÚNG credentials mi đã cấu hình (BASSO_API_KEY/EMAIL/PASS trong .env),
 * đăng nhập Partner API rồi thử một loạt tên endpoint khả dĩ, in ra cái nào trả về dữ liệu.
 *
 * Chạy TRÊN MÁY chạy mi (nơi gọi được api.basso.vn):  node scripts/probe-partner-shipping.js
 * CHỈ ĐỌC (page_size=1), không đổi dữ liệu.
 *
 * Nếu thấy dòng "<-- CÓ DỮ LIỆU" -> báo tôi tên endpoint đó, mình chuyển shippingApi.js sang gọi
 * Partner API (khỏi cookie). Nếu KHÔNG cái nào ra -> Partner API chưa mở giao hàng, phải hỏi Basso
 * hoặc dùng cookie như hiện tại.
 */
const fetch = require('node-fetch');
const config = require('../server/config');

const B = config.basso;

async function login() {
  const form = new URLSearchParams();
  form.set('email', B.email);
  form.set('pass', B.pass);
  const res = await fetch(`${B.baseUrl}/partner/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'X-Partner-Api-Key': B.partnerApiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.data || !j.data.access_token) throw new Error(`Login thất bại: ${j.message || res.status}`);
  return j.data.access_token;
}

// Các tên endpoint giao hàng khả dĩ (đoán theo phong cách getArrivedVnList + tên web shipping_order).
const CANDIDATES = [
  'getShippingList', 'getShipList', 'getShippingOrders', 'getShipOrders',
  'getDeliveryList', 'getDelivery', 'getShipping', 'getVnShipping',
  'shippingList', 'shipping_order', 'shipping', 'getShipVnList',
  'getArrivedVnShipping', 'getVnShippingList', 'getGiaoHang', 'getShippingVnList',
];

(async () => {
  console.log('=== Dò Partner API cho endpoint GIAO HÀNG ===\n');
  if (B.useMock || !B.baseUrl) {
    console.log('❌ Chưa cấu hình Partner API trong .env (BASSO_API_BASE_URL). Không dò được.');
    process.exit(1);
  }
  console.log(`Base: ${B.baseUrl}\n`);
  let token;
  try {
    token = await login();
    console.log('✅ Login Partner API OK — bắt đầu dò...\n');
  } catch (e) {
    console.log('❌ ' + e.message);
    process.exit(2);
  }
  const headers = {
    Accept: 'application/json',
    'X-Partner-Api-Key': B.partnerApiKey,
    Authorization: `Bearer ${token}`,
  };
  let found = 0;
  for (const name of CANDIDATES) {
    const url = `${B.baseUrl}/partner/${name}?page=1&page_size=1`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, { headers });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { j = null; }
      const isJson = !!j;
      const ok = res.ok && isJson && j.success !== false && j.error !== true;
      const data = j && (j.data || j.rows || (j.data && j.data.rows));
      const hasData = Array.isArray(data) ? data.length >= 0 : !!data;
      const mark = ok && hasData ? '  <-- CÓ DỮ LIỆU ✅' : '';
      if (ok && hasData) found += 1;
      console.log(`  [${res.status}] /partner/${name}${ok ? ' (ok)' : ''}${mark}`);
    } catch (e) {
      console.log(`  [ERR] /partner/${name}: ${e.message}`);
    }
  }
  console.log(found
    ? `\n🎉 Tìm thấy ${found} endpoint có dữ liệu — gửi tên đó cho tôi để chuyển sang Partner API (khỏi cookie).`
    : '\n😕 Không endpoint nào trả dữ liệu — Partner API có lẽ CHƯA mở giao hàng. Hỏi Basso, hoặc dùng cookie (BASSO_WEB_COOKIE) như hiện tại.');
})();
