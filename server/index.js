'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { getOrders, updateOrderStatus } = require('./bassoApi');
const { listReports, stats } = require('./db');
const { notifyMany } = require('./notifyService');
const { getLocalHealth } = require('./playwrightProxy');

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
  });
});

// ---- Dashboard: danh sách hàng về ----
app.get('/api/orders', async (req, res) => {
  try {
    const { from, to, status, staff, q } = req.query;
    const data = await getOrders({ from, to, status, staff, q });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Báo hàng: gửi tin cho 1 hoặc nhiều đơn ----
// body: { orderIds: string[], profile?, account?, messageOverride? }
app.post('/api/notify', async (req, res) => {
  try {
    const { orderIds, profile, account, messageOverride, kind } = req.body || {};
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'Cần orderIds (mảng không rỗng)' });
    }
    const result = await notifyMany(orderIds, { profile, account, messageOverride, kind });
    res.json({ ok: true, ...result });
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
});
