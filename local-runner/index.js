'use strict';
const fs = require('fs');
const express = require('express');
const config = require('./config');
const { createJob, getJob } = require('./jobQueue');
const { sendBaoHang } = require('./salework');
const { profileExists, profilePath, openForLogin } = require('./browser');
const accountsStore = require('./accountsStore');

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
  res.json({
    ok: true,
    service: 'doraemi-local-runner',
    testMode: config.testMode,
    testPhones: config.testPhones,
    time: new Date().toISOString(),
  });
});

app.get('/api/profile/:name', (req, res) => {
  res.json({ ok: true, profile: req.params.name, exists: profileExists(req.params.name) });
});

/**
 * POST /api/zalo/send
 * body: { profile, account?, keyword, name?, message, strictMatch?, imagePaths? }
 * => trả { ok, jobId } ngay; poll /api/job/:id để lấy kết quả.
 */
app.post('/api/zalo/send', (req, res) => {
  const { profile, account, keyword, name, message, strictMatch, imagePaths } = req.body || {};
  if ((!keyword && !name) || (!message && !(Array.isArray(imagePaths) && imagePaths.length))) {
    return res.status(400).json({ ok: false, error: 'Thiếu (keyword/name) hoặc (message/imagePaths)' });
  }
  const jobId = createJob({ profile, account, keyword, name, message, strictMatch, imagePaths }, sendBaoHang);
  res.json({ ok: true, jobId });
});

app.get('/api/job/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Không tìm thấy job' });
  res.json({ ok: true, job });
});

// ============================================================================
// QUẢN LÝ TÀI KHOẢN ZALO (port từ flow /api/accounts của Xeko).
// mi local-runner CHÍNH là máy có Chrome nên xử lý trực tiếp (không forward như Xeko).
// "key" của account cũng là tên profile browser (playwright-data/salework-<key>).
// ============================================================================

/** GET /api/accounts — liệt kê tài khoản Zalo + cờ đã đăng nhập (có thư mục profile chưa). */
app.get('/api/accounts', (req, res) => {
  const zalo = accountsStore.list().map((a) => ({
    ...a,
    loggedIn: profileExists(a.key),
  }));
  res.json({ zalo });
});

/**
 * POST /api/accounts — thêm tài khoản Zalo mới rồi mở Chromium để đăng nhập + chọn account.
 * body: { type:'zalo', key, name, saleworkName, proxy? }
 */
app.post('/api/accounts', (req, res) => {
  const { type, key, name, saleworkName, proxy } = req.body || {};
  if (type && type !== 'zalo') {
    return res.status(400).json({ ok: false, error: 'Chỉ hỗ trợ type="zalo"' });
  }
  let account;
  try {
    account = accountsStore.add({ key, name, saleworkName, proxy });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  const already = profileExists(account.key);
  res.json({
    ok: true,
    account: { ...account, loggedIn: already },
    message: already
      ? `Đã thêm tài khoản Zalo "${account.name}". Profile đã có session — xoá rồi thêm lại nếu muốn setup lại.`
      : `Đang mở Chromium để đăng nhập Zalo Basso và chọn tài khoản "${account.name}". Chọn xong thì đóng cửa sổ.`,
  });

  // Chưa có session -> mở Chromium cho nhân viên đăng nhập thủ công (không chặn response).
  if (!already) {
    openForLogin(account.key, config.saleworkLoginUrl, (ev) =>
      console.log(`[accounts] profile "${account.key}" ${ev === 'opened' ? 'đã mở Chromium đăng nhập' : 'đã đóng — session đã lưu'}`))
      .catch((e) => console.error(`[accounts] mở Chromium lỗi: ${e.message}`));
  }
});

/** POST /api/accounts/:key/login — mở lại Chromium cho profile có sẵn để đăng nhập lại. */
app.post('/api/accounts/:key/login', (req, res) => {
  const { key } = req.params;
  const account = accountsStore.get(key);
  if (!account) return res.status(404).json({ ok: false, error: `Không tìm thấy tài khoản "${key}"` });

  res.json({ ok: true, message: `Đang mở Chromium cho "${account.name}". Đăng nhập xong thì đóng cửa sổ.` });
  openForLogin(key, config.saleworkLoginUrl, (ev) =>
    console.log(`[accounts] re-login profile "${key}" ${ev === 'opened' ? 'đã mở' : 'đã đóng'}`))
    .catch((e) => console.error(`[accounts] re-login lỗi: ${e.message}`));
});

/** DELETE /api/accounts/:type/:key — xoá tài khoản Zalo (kèm xoá thư mục profile session). */
app.delete('/api/accounts/:type/:key', (req, res) => {
  const { type, key } = req.params;
  if (type !== 'zalo') return res.status(400).json({ ok: false, error: 'Chỉ hỗ trợ type="zalo"' });

  const removed = accountsStore.remove(key);
  if (!removed) return res.status(404).json({ ok: false, error: `Không tìm thấy tài khoản "${key}"` });

  // Xoá luôn thư mục session (an toàn: chỉ xoá trong dataDir). Để bỏ qua, gửi ?keepProfile=1.
  if (req.query.keepProfile !== '1') {
    try {
      const dir = profilePath(key);
      if (dir.startsWith(config.dataDir) && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`[accounts] xoá profile dir lỗi: ${e.message}`);
    }
  }
  res.json({ ok: true, message: `Đã xoá tài khoản Zalo "${key}"` });
});

app.listen(config.port, () => {
  console.log(`[local-runner] listening on http://localhost:${config.port}`);
  console.log(`[local-runner] Salework URL: ${config.saleworkUrl} | headless=${config.headless}`);
  if (!config.apiKey) console.warn('[local-runner] CẢNH BÁO: chưa đặt API_KEY — endpoint không được bảo vệ.');
  if (config.testMode) {
    console.warn(`[local-runner] 🧪 TEST_MODE BẬT — chỉ gửi tới: ${config.testPhones.join(', ') || '(trống!)'}`);
  } else {
    console.warn('[local-runner] ⚠️  TEST_MODE TẮT — sẽ gửi tới TẤT CẢ số được yêu cầu (khách thật).');
  }
});
