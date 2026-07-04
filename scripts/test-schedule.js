'use strict';
/**
 * TEST TỰ ĐỘNG luồng "gửi theo giờ cố định" (giả lập mốc 17h) — KHÔNG gửi thật cho khách.
 *
 * Mục tiêu: chứng minh khi ĐỒNG HỒ chạm giờ hẹn, hệ thống TỰ ĐỘNG:
 *   1) đọc TƯƠI nội dung báo hàng mới nhất (bỏ cache),
 *   2) tự gửi lần lượt cho các đơn ĐÃ đủ nội dung,
 *   3) BỎ QUA đơn còn thiếu nội dung (đếm cảnh báo).
 *
 * Cách chạy:  node scripts/test-schedule.js
 *
 * Cơ chế: chạy ở chế độ MOCK (dữ liệu mẫu server/mock/orders.json, có sẵn 1 đơn thiếu ND) và
 * dựng 1 "local-runner GIẢ" trong tiến trình để nhận lệnh gửi và trả "thành công" — nên không
 * đụng tới Zalo/khách thật. Đặt giờ gửi = phút hiện tại rồi để TIMER thật tự kích hoạt (không
 * gọi tay), đúng như tới 17h sẽ xảy ra.
 */

const http = require('http');
const os = require('os');
const path = require('path');

// --- Cấu hình môi trường TRƯỚC khi require config (config đọc env lúc nạp) ---
const RUNNER_PORT = 8788;
process.env.USE_MOCK = 'true';
process.env.AUTO_NOTIFY = 'true';
process.env.API_KEY = 'test';
process.env.PLAYWRIGHT_LOCAL_URL = `http://localhost:${RUNNER_PORT}`;
process.env.DB_PATH = path.join(os.tmpdir(), `test-schedule-${Date.now()}.sqlite`);
// Giờ VN, không phụ thuộc giờ máy chủ.
process.env.AUTO_NOTIFY_TZ = 'Asia/Ho_Chi_Minh';

// --- Local-runner GIẢ: trả "gửi thành công" cho mọi lệnh, ghi lại đã gửi cho ai ---
const sends = [];
const runner = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, testMode: false, testPhones: [] }));
    if (req.url === '/api/accounts') return res.end(JSON.stringify({ zalo: [] }));
    if (req.url === '/api/zalo/send') {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (_) { /* ignore */ }
      sends.push({ name: p.name, keyword: p.keyword, hasMessage: !!(p.message && p.message.trim()) });
      return res.end(JSON.stringify({ jobId: `job${sends.length}` }));
    }
    if (req.url.startsWith('/api/job/')) return res.end(JSON.stringify({ job: { status: 'done', result: { sent: true } } }));
    res.statusCode = 404; return res.end('{}');
  });
});

function vnNowHHMM() {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())) p[x.type] = x.value;
  return `${p.hour}:${p.minute}`;
}

function waitFor(check, { timeoutMs = 30000, everyMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = check(); } catch (_) { ok = false; }
      if (ok) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('Hết thời gian chờ timer kích hoạt')); }
    }, everyMs);
  });
}

(async () => {
  await new Promise((r) => runner.listen(RUNNER_PORT, r));

  // Nạp module sau khi env đã set.
  const autoNotify = require('../server/autoNotify');
  const db = require('../server/db');

  // 1) Xem trước: mock có bao nhiêu đơn đủ/thiếu ND (đọc tươi).
  const pre = await autoNotify.previewAutoNotify();
  console.log(`\n[1] Kiểm tra ND (đọc tươi): ${pre.ready} đơn đủ nội dung · ${pre.missingContent} đơn THIẾU nội dung (tổng ${pre.scanned} đơn "Chưa báo")`);
  if (pre.missingContent) {
    console.log('    Đơn thiếu ND:', pre.missingList.map((o) => `${o.customerName}${o.staff ? ` (${o.staff})` : ''}`).join(', '));
  }

  // 2) Đặt giờ gửi = phút HIỆN TẠI rồi bật auto -> TIMER thật sẽ tự kích hoạt (không gọi tay).
  const now = vnNowHHMM();
  autoNotify.setScheduleTime(now);
  console.log(`\n[2] Đặt giờ gửi cố định = ${now} (giờ VN) và bật auto. Chờ TIMER tự chạy (mô phỏng tới 17h)...`);
  autoNotify.setEnabled(true);

  // 3) Chờ timer tự kích hoạt lượt 'scheduled' (không hề gọi runAutoNotify bằng tay).
  await waitFor(() => {
    const s = autoNotify.getStatus();
    return s.lastResult && s.lastResult.trigger === 'scheduled';
  }, { timeoutMs: 30000 });

  const res = autoNotify.getStatus().lastResult;
  console.log('\n[3] TIMER đã tự kích hoạt lượt gửi theo lịch (trigger=scheduled):');
  console.log(`    Đã gửi: ${res.sent} ✅ | Lỗi: ${res.failed} ❌ | Bỏ qua vì thiếu ND: ${res.skippedNoContent || 0}`);

  // 4) Đối chiếu: local-runner giả nhận đúng số lệnh gửi, mỗi lệnh đều có nội dung.
  const withMsg = sends.filter((s) => s.hasMessage).length;
  const reports = db.listReports({ limit: 100 });
  const okReports = reports.filter((r) => r.status === 'success').length;
  console.log('\n[4] Đối chiếu:');
  console.log(`    Local-runner (giả) nhận ${sends.length} lệnh gửi, ${withMsg} lệnh có nội dung.`);
  console.log(`    Lịch sử báo ghi ${okReports} lượt "success".`);
  console.log('    Khách đã gửi:', sends.map((s) => s.name).join(', ') || '(không có)');

  // 5) Kết luận PASS/FAIL.
  const expectSent = pre.ready; // số đơn đủ ND = số phải gửi
  const pass =
    res.trigger === 'scheduled' &&
    res.sent === expectSent &&
    (res.skippedNoContent || 0) === pre.missingContent &&
    sends.length === expectSent &&
    withMsg === expectSent &&
    okReports === expectSent;

  console.log(`\n${pass ? '✅ PASS' : '❌ FAIL'} — tới giờ hẹn, hệ thống TỰ ĐỘNG đọc nội dung + gửi ${res.sent}/${expectSent} đơn đủ ND, bỏ qua ${res.skippedNoContent || 0} đơn thiếu ND.\n`);

  runner.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('LỖI TEST:', e);
  runner.close();
  process.exit(1);
});
