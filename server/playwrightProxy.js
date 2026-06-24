'use strict';
const fetch = require('node-fetch');
const config = require('./config');
const localRegistry = require('./localRegistry');

/**
 * Forward lệnh automation xuống local-runner (qua tunnel / localhost).
 * Theo pattern Xeko: POST trả jobId -> poll cho tới khi done/error.
 */

/**
 * URL runner hiệu lực: ưu tiên URL runner tự đăng ký qua /api/register-local (heartbeat),
 * nếu chưa có/đã cũ thì fallback PLAYWRIGHT_LOCAL_URL tĩnh trong .env (chạy chung máy/local).
 */
function effectiveBaseUrl() {
  return localRegistry.getFreshUrl() || config.playwrightLocalUrl;
}

function localUrl(path) {
  return `${effectiveBaseUrl().replace(/\/$/, '')}${path}`;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
  };
}

async function checkLocalHealth() {
  try {
    const res = await fetch(localUrl('/health'), { timeout: 5000 });
    return res.ok;
  } catch {
    return false;
  }
}

/** Lấy chi tiết health của runner (online, testMode, testPhones) */
async function getLocalHealth() {
  try {
    const res = await fetch(localUrl('/health'), { timeout: 5000 });
    if (!res.ok) return { online: false };
    const j = await res.json();
    return { online: true, testMode: !!j.testMode, testPhones: j.testPhones || [] };
  } catch {
    return { online: false };
  }
}

/**
 * Gửi 1 tin nhắn báo hàng và chờ kết quả.
 * @param {{profile?:string, account?:string, keyword:string, message:string}} payload
 * @returns {Promise<{ok:boolean, jobId:string, result?:object, error?:string}>}
 */
async function sendBaoHang(payload, { pollIntervalMs = 1500, timeoutMs = 10 * 60 * 1000 } = {}) {
  const res = await fetch(localUrl('/api/zalo/send'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Local-runner từ chối (${res.status}): ${text}`);
  }
  const { jobId } = await res.json();
  if (!jobId) throw new Error('Local-runner không trả jobId');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    let job;
    try {
      const jr = await fetch(localUrl(`/api/job/${jobId}`), { headers: headers() });
      if (!jr.ok) continue; // glitch mạng tạm thời -> thử lại
      const data = await jr.json();
      job = data.job;
    } catch {
      continue;
    }
    if (!job) continue;
    if (job.status === 'done') return { ok: true, jobId, result: job.result };
    if (job.status === 'error') return { ok: false, jobId, error: job.error };
  }
  return { ok: false, jobId, error: 'Hết thời gian chờ local-runner (timeout)' };
}

/**
 * Forward chung 1 request quản lý tài khoản xuống local-runner. Trả { status, data }.
 * Dùng cho các route /api/accounts của dashboard (server cloud không giữ account — runner giữ).
 */
async function forwardAccounts(method, path, { body, query } = {}) {
  // Chỉ lấy các query value kiểu nguyên thuỷ (string/number/bool) — tránh URLSearchParams
  // serialize sai khi Express parse query thành mảng/object (vd ?x[]=1).
  const sp = new URLSearchParams();
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') sp.append(k, String(v));
    }
  }
  const qs = sp.toString() ? `?${sp.toString()}` : '';
  const res = await fetch(localUrl(`${path}${qs}`), {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
    timeout: 20000,
  });
  const text = await res.text().catch(() => '');
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${res.status}` }; }
  return { status: res.status, data };
}

// Cache danh sách account (để resolve đơn -> account mà không gọi runner mỗi lần).
let _accountsCache = { at: 0, list: [] };
const ACCOUNTS_TTL_MS = 60_000;

/** Lấy danh sách account Zalo từ runner (cache 60s). [] nếu runner offline. */
async function getAccountsCached() {
  if (Date.now() - _accountsCache.at < ACCOUNTS_TTL_MS) return _accountsCache.list;
  try {
    const { status, data } = await forwardAccounts('GET', '/api/accounts');
    if (status >= 200 && status < 300 && Array.isArray(data.zalo)) {
      _accountsCache = { at: Date.now(), list: data.zalo };
    }
  } catch {
    /* runner offline -> giữ cache cũ */
  }
  return _accountsCache.list;
}

/** Xoá cache (gọi sau khi thêm/sửa/xoá account để lần resolve kế tiếp lấy bản mới). */
function invalidateAccountsCache() {
  _accountsCache = { at: 0, list: [] };
}

module.exports = {
  sendBaoHang, checkLocalHealth, getLocalHealth, effectiveBaseUrl,
  forwardAccounts, getAccountsCached, invalidateAccountsCache,
};
