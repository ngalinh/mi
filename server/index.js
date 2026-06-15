'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { getOrders, getArrivedItems, updateOrderStatus } = require('./bassoApi');
const { listReports, stats, getAutoRecord } = require('./db');
const { notifyMany, notifyOrders } = require('./notifyService');
const { getLocalHealth } = require('./playwrightProxy');
const autoNotify = require('./autoNotify');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
// Tắt cache asset tĩnh (dev): tránh trình duyệt giữ JS/CSS cũ sau khi sửa code
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

// ---- Health & cấu hình hiển thị ----
app.get('/api/health', async (req, res) => {
  const h = await getLocalHealth();
  res.json({
    ok: true,
    mock: config.basso.useMock,
    localRunner: {
      url: config.playwrightLocalUrl,
      online: h.online,
      testMode: h.testMode || false,
      testPhones: h.testPhones || [],
    },
    autoNotify: autoNotify.getStatus(),
  });
});

// ---- Test kết nối Basso (chỉ đọc): dùng cho nút "Test Basso" trên dashboard ----
// Luôn trả HTTP 200 + cờ `connected` để frontend hiển thị được cả khi lỗi.
app.get('/api/basso/ping', async (req, res) => {
  if (config.basso.useMock) {
    return res.json({ ok: true, connected: false, mock: true, error: 'Đang ở chế độ MOCK — chưa nối Basso thật.' });
  }
  const t0 = Date.now();
  try {
    const r = await getOrders({ pageSize: 1 });
    const o = (r.orders || [])[0] || null;
    res.json({
      ok: true,
      connected: true,
      mock: false,
      baseUrl: config.basso.baseUrl,
      source: r.source,
      total: r.total,
      ms: Date.now() - t0,
      sample: o ? { id: o.id, customerName: o.customerName, warehouseDate: o.warehouseDate, status: o.status } : null,
    });
  } catch (err) {
    res.json({ ok: true, connected: false, mock: false, baseUrl: config.basso.baseUrl, ms: Date.now() - t0, error: err.message });
  }
});

// ---- Dashboard: danh sách hàng về ----
app.get('/api/orders', async (req, res) => {
  try {
    const { from, to, status, staff, q } = req.query;
    const data = await getOrders({ from, to, status, staff, q });
    // Gắn dấu "bot đã tự gửi" (lưu local trong mi) để dashboard phân biệt, kể cả khi
    // không cập nhật trạng thái về web Basso.
    if (Array.isArray(data.orders)) {
      data.orders = data.orders.map((o) => {
        const a = getAutoRecord(autoNotify.autoKey(o));
        return a ? { ...o, autoNotified: { status: a.status, attempts: a.attempts, at: a.updated_at } } : o;
      });
    }
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Chi tiết sản phẩm đã về của 1 dòng (load lazy khi mở rộng) ----
app.get('/api/arrived-items', async (req, res) => {
  try {
    const { id, customerId, dateInventory } = req.query;
    if (id == null && (customerId == null || dateInventory == null)) {
      return res.status(400).json({ ok: false, error: 'Cần id hoặc (customerId + dateInventory)' });
    }
    const data = await getArrivedItems({ id, customerId, dateInventory });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Báo hàng: gửi tin cho 1 hoặc nhiều đơn ----
// body: { orders: object[] (ưu tiên, client gửi đơn đầy đủ) | orderIds: string[] (legacy),
//         profile?, account?, messageOverride?, kind? }
app.post('/api/notify', async (req, res) => {
  try {
    const { orders, orderIds, profile, account, messageOverride, kind } = req.body || {};
    const opts = { profile, account, messageOverride, kind };
    if (Array.isArray(orders) && orders.length) {
      const result = await notifyOrders(orders, opts);
      return res.json({ ok: true, ...result });
    }
    if (Array.isArray(orderIds) && orderIds.length) {
      const result = await notifyMany(orderIds, opts);
      return res.json({ ok: true, ...result });
    }
    return res.status(400).json({ ok: false, error: 'Cần orders hoặc orderIds (mảng không rỗng)' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Cập nhật trạng thái / ghi chú 1 dòng (inline edit, sync về web) ----
// body: { customerId, dateInventory, status?, note? }
app.post('/api/update-row', async (req, res) => {
  try {
    const { customerId, dateInventory, status, note } = req.body || {};
    if (customerId == null) return res.status(400).json({ ok: false, error: 'Thiếu customerId' });
    const result = await updateOrderStatus({ customerId, dateInventory, status, note });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Tự động báo hàng: trạng thái + bật/tắt + chạy thủ công ----
app.get('/api/auto-notify', (req, res) => {
  res.json({ ok: true, ...autoNotify.getStatus() });
});

// Bật/tắt poller tự động lúc runtime. body: { enabled: boolean }
app.post('/api/auto-notify/toggle', (req, res) => {
  const { enabled } = req.body || {};
  const status = autoNotify.setEnabled(!!enabled);
  res.json({ ok: true, ...status });
});

// Chạy 1 lượt quét + gửi ngay (không phụ thuộc interval). Dùng cho nút "Quét & gửi ngay".
app.post('/api/auto-notify/run', async (req, res) => {
  try {
    const result = await autoNotify.runAutoNotify({ trigger: 'manual' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Webhook: website Basso gọi sang khi CÓ HÀNG VỀ -> gửi ngay (real-time) ----
// Bảo vệ tùy chọn bằng header `x-webhook-secret` khớp AUTO_NOTIFY_WEBHOOK_SECRET.
app.post('/api/webhook/arrived', async (req, res) => {
  const secret = config.autoNotify.webhookSecret;
  if (secret && req.get('x-webhook-secret') !== secret) {
    return res.status(401).json({ ok: false, error: 'Sai webhook secret' });
  }
  try {
    const result = await autoNotify.runAutoNotify({ trigger: 'webhook' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Lịch sử report ----
app.get('/api/reports', (req, res) => {
  try {
    const { limit, status, q } = req.query;
    const items = listReports({ limit: limit ? parseInt(limit, 10) : 200, status, q });
    res.json({ ok: true, stats: stats(), items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  console.log(`[server] mock=${config.basso.useMock} | local-runner=${config.playwrightLocalUrl}`);
  autoNotify.startAutoNotify();
});
