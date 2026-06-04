'use strict';
const fetch = require('node-fetch');
const config = require('./config');

/**
 * Forward lệnh automation xuống local-runner (qua tunnel / localhost).
 * Theo pattern Xeko: POST trả jobId -> poll cho tới khi done/error.
 */

function localUrl(path) {
  return `${config.playwrightLocalUrl.replace(/\/$/, '')}${path}`;
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

module.exports = { sendBaoHang, checkLocalHealth, getLocalHealth };
