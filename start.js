'use strict';
/**
 * start.js — Launcher cho LOCAL-RUNNER theo pattern Xeko.
 *
 * Chạy trên MÁY CÓ CHROME (máy bạn / VPS có trình duyệt). Nó:
 *   1. Spawn local-runner (local-runner/index.js) như tiến trình con.
 *   2. Tự xác định URL công khai của runner (tunnel/IP public).
 *   3. POST URL đó lên server trên cloud (ai.basso.vn) qua /api/register-local.
 *   4. Heartbeat: đăng ký lại định kỳ (mặc định 30s) — vì cloud lưu URL trong RAM,
 *      cứ restart/reload là mất, nên phải nhắc lại đều đặn.
 *
 * Nhờ vậy KHÔNG cần hardcode PLAYWRIGHT_LOCAL_URL trong .env của server: runner tự
 * đẩy địa chỉ lên, đổi IP/tunnel vẫn chạy.
 *
 * Dùng: `node start.js`  (hoặc `npm run runner`)
 */
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const REMOTE_BOT_URL = (process.env.REMOTE_BOT_URL || '').trim().replace(/\/$/, '');
const API_KEY = process.env.API_KEY || '';
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT || '8090', 10);
const REGISTER_INTERVAL_MS = Math.max(
  parseInt(process.env.REGISTER_INTERVAL_MS || '30000', 10) || 30000,
  5000
);

function isLocalhost(u) {
  return /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(u || '');
}

/** Xác định URL công khai của runner để khai báo lên cloud. */
async function resolveLocalUrl() {
  // 1) Ưu tiên URL công khai chỉ định rõ (tunnel ngrok/cloudflared).
  const explicit = (process.env.PLAYWRIGHT_PUBLIC_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  // 2) PLAYWRIGHT_LOCAL_URL nếu không phải localhost (đã là URL truy cập được từ ngoài).
  const local = (process.env.PLAYWRIGHT_LOCAL_URL || '').trim();
  if (local && !isLocalhost(local)) return local.replace(/\/$/, '');

  // 3) Tự dò IP public rồi ghép cổng (cần mở/forward cổng thì cloud mới gọi vào được).
  try {
    const res = await fetch('https://api.ipify.org', { timeout: 5000 });
    const ip = (await res.text()).trim();
    if (ip) return `http://${ip}:${LOCAL_PORT}`;
  } catch {
    /* bỏ qua, xử lý ở dưới */
  }
  return '';
}

async function registerUrl(url, { silent = false } = {}) {
  if (!REMOTE_BOT_URL) {
    if (!silent) console.warn('[start] Chưa đặt REMOTE_BOT_URL — bỏ qua đăng ký (runner vẫn chạy).');
    return false;
  }
  if (!url) {
    if (!silent) console.warn('[start] Không xác định được URL runner để đăng ký.');
    return false;
  }
  try {
    const res = await fetch(`${REMOTE_BOT_URL}/api/register-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, apiKey: API_KEY }),
      timeout: 8000,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (!silent) console.warn(`[start] Đăng ký thất bại (${res.status}): ${t}`);
      return false;
    }
    if (!silent) console.log(`[start] Đã đăng ký runner: ${url} -> ${REMOTE_BOT_URL}`);
    return true;
  } catch (e) {
    if (!silent) console.warn(`[start] Lỗi đăng ký: ${e.message}`);
    return false;
  }
}

// ---- Spawn local-runner ----
// detached:true -> local-runner (và Chrome do Playwright đẻ ra) nằm trong 1 NHÓM TIẾN TRÌNH
// riêng. Nhờ vậy lúc tắt ta kill được CẢ NHÓM bằng process.kill(-pid) — kể cả Chrome "cháu".
// Nếu không, khi restart Chrome hay bị mồ côi: giữ cổng 8090 + SingletonLock + ống stdio,
// khiến instance mới EADDRINUSE, pm2 restart treo và tiến trình cứ "đang chạy" mãi.
const child = spawn('node', [path.join(__dirname, 'local-runner', 'index.js')], {
  stdio: 'inherit',
  env: process.env,
  detached: true,
});
let shuttingDown = false;
child.on('exit', (code) => {
  if (shuttingDown) return; // shutdown() đang lo việc thoát -> đừng thoát hai lần
  console.log(`[start] local-runner thoát (code=${code}). Dừng launcher.`);
  process.exit(code == null ? 0 : code);
});

// ---- Đăng ký lần đầu + heartbeat ----
(async () => {
  const url = await resolveLocalUrl();
  await registerUrl(url);
})();

const timer = setInterval(async () => {
  const url = await resolveLocalUrl();
  if (url) await registerUrl(url, { silent: true });
}, REGISTER_INTERVAL_MS);

// ---- Tắt mượt ----
// Gửi tín hiệu cho CẢ NHÓM tiến trình con (local-runner + Chrome). process.kill(-pid) chỉ
// dùng được khi con là group-leader (spawn detached ở trên). Lỗi (nhóm đã chết) -> bỏ qua.
function killGroup(signal) {
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* đã chết */ } }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);

  // 1) Xin local-runner tự đóng Chrome + HTTP server cho sạch (SIGTERM).
  killGroup('SIGTERM');

  // 2) Con chết hẳn -> mới thoát, nhờ vậy cổng 8090 + ống stdio đã được giải phóng
  //    trước khi pm2 dựng instance mới (không còn EADDRINUSE / restart loop).
  const force = setTimeout(() => {
    console.warn('[start] local-runner không chịu thoát trong 8s — SIGKILL cả nhóm.');
    killGroup('SIGKILL');
    process.exit(1);
  }, 8000);
  if (typeof force.unref === 'function') force.unref();

  child.once('exit', (code) => {
    clearTimeout(force);
    process.exit(code == null ? 0 : code);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
