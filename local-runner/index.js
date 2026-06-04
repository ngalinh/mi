'use strict';
const express = require('express');
const config = require('./config');
const { createJob, getJob } = require('./jobQueue');
const { sendBaoHang } = require('./salework');
const { profileExists } = require('./browser');

const app = express();
app.use(express.json({ limit: '5mb' }));

// --- Xác thực bằng x-api-key (trừ /health) ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!config.apiKey) return next(); // chưa đặt key => bỏ qua (dev)
  if (req.get('x-api-key') !== config.apiKey) {
    return res.status(401).json({ ok: false, error: 'Sai hoặc thiếu x-api-key' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'doraemi-local-runner', time: new Date().toISOString() });
});

app.get('/api/profile/:name', (req, res) => {
  res.json({ ok: true, profile: req.params.name, exists: profileExists(req.params.name) });
});

/**
 * POST /api/zalo/send
 * body: { profile, account?, keyword, message }
 * => trả { ok, jobId } ngay; poll /api/job/:id để lấy kết quả.
 */
app.post('/api/zalo/send', (req, res) => {
  const { profile, account, keyword, message } = req.body || {};
  if (!keyword || !message) {
    return res.status(400).json({ ok: false, error: 'Thiếu keyword hoặc message' });
  }
  const jobId = createJob({ profile, account, keyword, message }, sendBaoHang);
  res.json({ ok: true, jobId });
});

app.get('/api/job/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Không tìm thấy job' });
  res.json({ ok: true, job });
});

app.listen(config.port, () => {
  console.log(`[local-runner] listening on http://localhost:${config.port}`);
  console.log(`[local-runner] Salework URL: ${config.saleworkUrl} | headless=${config.headless}`);
  if (!config.apiKey) console.warn('[local-runner] CẢNH BÁO: chưa đặt API_KEY — endpoint không được bảo vệ.');
});
