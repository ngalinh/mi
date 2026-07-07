'use strict';
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { createJob, getJob } = require('./jobQueue');
const { sendBaoHang } = require('./salework');
const { sendBaoHangFb } = require('./facebook');
const { profileExists, profilePath, openForLogin } = require('./browser');
const accountsStore = require('./accountsStore');
const testModeStore = require('./testModeStore');
const loginHistory = require('./loginHistory');
const { checkLoggedIn } = require('./salework');
const { checkLoggedInFb } = require('./facebook');

// Trang mở khi đăng nhập theo kênh: Facebook -> facebook.com, còn lại -> Zalo Basso.
const loginUrlFor = (platform) => (platform === 'facebook' ? config.facebookLoginUrl : config.saleworkLoginUrl);

const app = express();
app.use(express.json({ limit: '5mb' }));

// So sánh secret theo thời gian hằng định (chống dò timing). Khác độ dài -> false.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// --- Xác thực bằng x-api-key (trừ /health) ---
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!config.apiKey) return next(); // chưa đặt key => bỏ qua (dev)
  if (!safeEqual(req.get('x-api-key'), config.apiKey)) {
    return res.status(401).json({ ok: false, error: 'Sai hoặc thiếu x-api-key' });
  }
  next();
});

app.get('/health', (req, res) => {
  const tm = testModeStore.get();
  res.json({
    ok: true,
    service: 'doraemi-local-runner',
    testMode: tm.testMode,
    testPhones: tm.testPhones,
    time: new Date().toISOString(),
  });
});

/** GET /api/test-mode — trạng thái chặn an toàn hiện tại (testMode + testPhones). */
app.get('/api/test-mode', (req, res) => {
  res.json({ ok: true, ...testModeStore.get() });
});

/**
 * PUT /api/test-mode — bật/tắt chặn an toàn và/hoặc đổi danh sách SĐT được gửi.
 * body: { testMode?: boolean, testPhones?: string|string[] }. Ghi ra file -> hiệu lực NGAY.
 */
app.put('/api/test-mode', (req, res) => {
  const { testMode, testPhones } = req.body || {};
  try {
    const next = testModeStore.set({ testMode, testPhones });
    res.json({ ok: true, ...next });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/profile/:name', (req, res) => {
  res.json({ ok: true, profile: req.params.name, exists: profileExists(req.params.name) });
});

/**
 * POST /api/zalo/send
 * body: { profile, account?, keyword, name?, message, strictMatch?, imagePaths?, notifyTarget?, keepContext? }
 * => trả { ok, jobId } ngay; poll /api/job/:id để lấy kết quả.
 */
app.post('/api/zalo/send', (req, res) => {
  // notifyTarget ('group'|'personal') + keepContext PHẢI đọc ra + chuyển tiếp — thiếu là
  // salework.sendBaoHang nhận undefined -> mặc định 'group' -> luôn bấm tab Nhóm dù NV để Cá nhân.
  const { profile, account, keyword, name, message, strictMatch, imagePaths, notifyTarget, keepContext } = req.body || {};
  if ((!keyword && !name) || (!message && !(Array.isArray(imagePaths) && imagePaths.length))) {
    return res.status(400).json({ ok: false, error: 'Thiếu (keyword/name) hoặc (message/imagePaths)' });
  }
  const jobId = createJob({ profile, account, keyword, name, message, strictMatch, imagePaths, notifyTarget, keepContext }, sendBaoHang);
  res.json({ ok: true, jobId });
});

/**
 * POST /api/facebook/send — báo hàng qua Facebook Messenger cho khách không dùng Zalo.
 * body: { profile, keyword, name?, message, strictMatch?, imagePaths? } => { ok, jobId }.
 */
app.post('/api/facebook/send', (req, res) => {
  const { profile, keyword, name, message, strictMatch, imagePaths } = req.body || {};
  if ((!keyword && !name) || (!message && !(Array.isArray(imagePaths) && imagePaths.length))) {
    return res.status(400).json({ ok: false, error: 'Thiếu (keyword/name) hoặc (message/imagePaths)' });
  }
  const jobId = createJob({ profile, keyword, name, message, strictMatch, imagePaths }, sendBaoHangFb);
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

// Trạng thái kết nối suy ra: chưa có session -> 'never'; có session + lần ghi gần nhất là
// session_expired -> 'expired'; ngược lại 'connected' (đã từng login/được xác nhận).
function connectionStatus(key) {
  if (!profileExists(key)) return 'never';
  const last = loginHistory.latest(key);
  if (last && last.type === 'session_expired') return 'expired';
  return 'connected';
}

function decorate(a) {
  return { ...a, loggedIn: profileExists(a.key), connection: connectionStatus(a.key) };
}

/** GET /api/accounts — liệt kê tài khoản (Zalo + Facebook) + cờ đăng nhập + trạng thái kết nối.
 * Trả kèm `accounts` (gộp cả 2 kênh) để server resolve đơn -> account theo platform. */
app.get('/api/accounts', (req, res) => {
  const all = accountsStore.list().map(decorate);
  res.json({
    accounts: all,
    zalo: all.filter((a) => a.platform !== 'facebook'),
    facebook: all.filter((a) => a.platform === 'facebook'),
  });
});

/**
 * POST /api/accounts — thêm tài khoản (Zalo hoặc Facebook) rồi mở Chromium để đăng nhập.
 * body: { type|platform:'zalo'|'facebook', key, name, saleworkName?, fbName?, phone?, staffId?,
 *         brand?, autoEnabled?, proxy?, notifyTarget? }
 */
app.post('/api/accounts', (req, res) => {
  const { type, platform: platformIn, key, name, saleworkName, fbName, phone, staffId, brand, autoEnabled, proxy, notifyTarget } = req.body || {};
  const platform = (platformIn || type) === 'facebook' ? 'facebook' : 'zalo';
  const label = platform === 'facebook' ? 'Facebook' : 'Zalo';
  let account;
  try {
    account = accountsStore.add({ platform, key, name, saleworkName, fbName, phone, staffId, brand, autoEnabled, proxy, notifyTarget });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  const already = profileExists(account.key);
  const loginMsg = platform === 'facebook'
    ? `Đang mở Chromium để đăng nhập Facebook cho "${account.name}". Đăng nhập xong thì đóng cửa sổ.`
    : `Đang mở Chromium để đăng nhập Zalo Basso và chọn tài khoản "${account.name}". Chọn xong thì đóng cửa sổ.`;
  res.json({
    ok: true,
    account: decorate(account),
    message: already
      ? `Đã thêm tài khoản ${label} "${account.name}". Profile đã có session — xoá rồi thêm lại nếu muốn setup lại.`
      : loginMsg,
  });

  // Chưa có session -> mở Chromium cho nhân viên đăng nhập thủ công (không chặn response).
  if (!already) {
    openForLogin(account.key, loginUrlFor(platform), (ev) => {
      if (ev === 'opened') loginHistory.add(account.key, account.name, 'login', `Mở Chromium để đăng nhập ${label}`);
      else loginHistory.add(account.key, account.name, 'login', 'Đã đóng cửa sổ — session đã lưu');
    }).catch((e) => console.error(`[accounts] mở Chromium lỗi: ${e.message}`));
  }
});

/** PUT /api/accounts/:key — sửa thông tin account (không đổi key/platform). */
app.put('/api/accounts/:key', (req, res) => {
  const { key } = req.params;
  const { name, saleworkName, fbName, phone, staffId, brand, autoEnabled, proxy, notifyTarget } = req.body || {};
  const patch = {};
  for (const [k, v] of Object.entries({ name, saleworkName, fbName, phone, staffId, brand, autoEnabled, proxy, notifyTarget })) {
    if (v !== undefined) patch[k] = v;
  }
  const updated = accountsStore.update(key, patch);
  if (!updated) return res.status(404).json({ ok: false, error: `Không tìm thấy tài khoản "${key}"` });
  res.json({ ok: true, account: decorate(updated) });
});

/** POST /api/accounts/:key/login — mở lại Chromium cho profile có sẵn để đăng nhập lại. */
app.post('/api/accounts/:key/login', (req, res) => {
  const { key } = req.params;
  const account = accountsStore.get(key);
  if (!account) return res.status(404).json({ ok: false, error: `Không tìm thấy tài khoản "${key}"` });

  res.json({ ok: true, message: `Đang mở Chromium cho "${account.name}". Đăng nhập xong thì đóng cửa sổ.` });
  openForLogin(key, loginUrlFor(account.platform), (ev) =>
    loginHistory.add(key, account.name, 'login', ev === 'opened' ? 'Mở lại để đăng nhập' : 'Đã đóng — session đã lưu'))
    .catch((e) => console.error(`[accounts] re-login lỗi: ${e.message}`));
});

/** POST /api/accounts/:key/check — kiểm tra profile còn đăng nhập không (mở browser). */
app.post('/api/accounts/:key/check', async (req, res) => {
  const { key } = req.params;
  const account = accountsStore.get(key);
  if (!account) return res.status(404).json({ ok: false, error: `Không tìm thấy tài khoản "${key}"` });
  if (!profileExists(key)) {
    return res.json({ ok: true, loggedIn: false, connection: 'never', error: 'Chưa từng đăng nhập' });
  }
  try {
    // Kiểm tra theo đúng kênh của account (Facebook mở facebook.com, Zalo mở Zalo Basso).
    const r = account.platform === 'facebook' ? await checkLoggedInFb(key) : await checkLoggedIn(key);
    loginHistory.add(key, account.name, r.loggedIn ? 'session_ok' : 'session_expired', r.error || '');
    res.json({ ok: true, loggedIn: r.loggedIn, connection: r.loggedIn ? 'connected' : 'expired', error: r.error || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/accounts/:key/history — lịch sử đăng nhập của 1 profile. */
app.get('/api/accounts/:key/history', (req, res) => {
  res.json({ ok: true, history: loginHistory.list(req.params.key) });
});

/** DELETE /api/accounts/:type/:key — xoá tài khoản (Zalo/Facebook) kèm xoá thư mục profile session. */
app.delete('/api/accounts/:type/:key', (req, res) => {
  const { type, key } = req.params;
  if (type !== 'zalo' && type !== 'facebook') {
    return res.status(400).json({ ok: false, error: 'Chỉ hỗ trợ type="zalo" hoặc "facebook"' });
  }

  const account = accountsStore.get(key);
  // Lấy platform TRƯỚC khi xoá để tính đúng thư mục profile (store rỗng sau remove -> mặc định zalo).
  const platform = account ? account.platform : (type === 'facebook' ? 'facebook' : 'zalo');
  const removed = accountsStore.remove(key);
  if (!removed) return res.status(404).json({ ok: false, error: `Không tìm thấy tài khoản "${key}"` });

  // Xoá luôn thư mục session (an toàn: chỉ xoá trong dataDir). Để bỏ qua, gửi ?keepProfile=1.
  if (req.query.keepProfile !== '1') {
    try {
      const dir = profilePath(key, platform);
      if (dir.startsWith(config.dataDir) && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`[accounts] xoá profile dir lỗi: ${e.message}`);
    }
  }
  loginHistory.add(key, account ? account.name : key, 'delete', 'Đã xoá tài khoản');
  res.json({ ok: true, message: `Đã xoá tài khoản ${platform === 'facebook' ? 'Facebook' : 'Zalo'} "${key}"` });
});

// Fail-closed: production / REQUIRE_API_KEY bắt buộc phải có API_KEY (nếu không, mọi endpoint
// điều khiển browser sẽ mở toang). Dừng hẳn thay vì chạy không bảo vệ.
if (config.requireApiKey && !config.apiKey) {
  console.error('[local-runner] FATAL: REQUIRE_API_KEY/production nhưng chưa đặt API_KEY. Đặt API_KEY rồi chạy lại.');
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`[local-runner] listening on http://localhost:${config.port}`);
  console.log(`[local-runner] Salework URL: ${config.saleworkUrl} | headless=${config.headless}`);
  if (!config.apiKey) console.warn('[local-runner] CẢNH BÁO: chưa đặt API_KEY — endpoint không được bảo vệ.');
  const tm = testModeStore.get();
  if (tm.testMode) {
    console.warn(`[local-runner] 🧪 TEST_MODE BẬT — chỉ gửi tới: ${tm.testPhones.join(', ') || '(trống!)'}`);
  } else {
    console.warn('[local-runner] ⚠️  TEST_MODE TẮT — sẽ gửi tới TẤT CẢ số được yêu cầu (khách thật).');
  }
});
