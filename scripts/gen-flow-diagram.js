'use strict';
// Sinh sơ đồ luồng Doraemi Bot: viết file SVG tự chứa rồi rasterize sang PNG (@resvg/resvg-js).
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const OUT_DIR = path.join(__dirname, '..', 'docs');
const W = 1280;
const H = 1500;

// ---- helpers vẽ ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parts = [];
const add = (s) => parts.push(s);

function box(x, y, w, h, fill, stroke, rx = 14) {
  add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
}
function text(x, y, s, opts = {}) {
  const { size = 18, weight = 400, fill = '#0f172a', anchor = 'start', mono = false } = opts;
  const ff = mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Inter, Segoe UI, Arial, sans-serif';
  add(`<text x="${x}" y="${y}" font-family="${ff}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`);
}
function lines(x, y, arr, opts = {}) {
  const lh = opts.lh || 24;
  arr.forEach((l, i) => text(x, y + i * lh, l, opts));
}
function arrow(x1, y1, x2, y2, color = '#64748b', label = '') {
  add(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.5" marker-end="url(#ah)"/>`);
  if (label) {
    const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
    add(`<rect x="${mx - label.length * 4.6 - 8}" y="${my - 15}" width="${label.length * 9.2 + 16}" height="22" rx="6" fill="#ffffff" stroke="${color}" stroke-width="1"/>`);
    text(mx, my + 1, label, { size: 13, fill: color, anchor: 'middle', weight: 600 });
  }
}

// ---- màu ----
const C = {
  bg: '#f8fafc', server: '#eef2ff', serverB: '#6366f1',
  runner: '#ecfdf5', runnerB: '#10b981', basso: '#fef3c7', bassoB: '#f59e0b',
  db: '#f1f5f9', dbB: '#94a3b8', auto: '#fdf2f8', autoB: '#ec4899',
  white: '#ffffff', line: '#475569', ok: '#16a34a', warn: '#dc2626',
};

add(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
add(`<defs><marker id="ah" markerWidth="11" markerHeight="11" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.line}"/></marker></defs>`);
add(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

// Tiêu đề
text(40, 52, 'Doraemi Bot — Luồng báo hàng về VN (A → Z)', { size: 30, weight: 800 });
text(40, 80, 'Tự động báo "hàng đã về kho" cho khách qua Zalo (Salework)', { size: 16, fill: '#475569' });

// ===== Hàng 1: Basso  →  server  →  runner =====
const y1 = 110;
// Basso
box(40, y1, 300, 150, C.basso, C.bassoB);
text(60, y1 + 34, 'WEBSITE BASSO', { size: 17, weight: 700, fill: '#92400e' });
lines(60, y1 + 62, [
  'Partner API (nguồn hàng về)',
  '• getArrivedVnList — danh sách',
  '• getArrivedVnItems — chi tiết',
  '• updateArrivedVnRow — cập nhật',
], { size: 13.5, fill: '#7c2d12' });

// server
box(400, y1, 470, 150, C.server, C.serverB);
text(420, y1 + 34, 'server/  (bộ não — ai.basso.vn)', { size: 17, weight: 700, fill: '#3730a3' });
lines(420, y1 + 62, [
  '• Dashboard + REST API',
  '• Quyết định GỬI CHO AI + build tin',
  '• Bot tự động (auto-notify)',
  '• Chống trùng + ghi lịch sử (SQLite)',
], { size: 13.5, fill: '#312e81' });

// runner
box(930, y1, 310, 150, C.runner, C.runnerB);
text(950, y1 + 34, 'local-runner/ (cánh tay)', { size: 17, weight: 700, fill: '#065f46' });
lines(950, y1 + 62, [
  'Máy có Chrome thật',
  '• Playwright + session Zalo',
  '• THỰC THI việc gửi',
  '• zalo.basso.vn',
], { size: 13.5, fill: '#064e3b' });

arrow(340, y1 + 60, 400, y1 + 60, C.bassoB, 'đọc');
arrow(400, y1 + 95, 340, y1 + 95, C.bassoB, 'cập nhật*');
arrow(870, y1 + 60, 930, y1 + 60, C.runnerB, 'POST send');
arrow(930, y1 + 100, 870, y1 + 100, C.runnerB, 'jobId/poll');

// ===== Hàng 2: hai nguồn kích hoạt =====
const y2 = 320;
text(40, y2 + 4, '2 luồng kích hoạt gửi — đều đi qua bước GỬI chung (dưới cùng)', { size: 17, weight: 700 });

// B - báo tay
box(40, y2 + 20, 580, 250, C.white, C.serverB);
text(60, y2 + 52, 'B) BÁO TAY  — người bấm trên dashboard', { size: 16, weight: 700, fill: '#3730a3' });
lines(60, y2 + 82, [
  'POST /api/notify  → notifyMany()  🔒 withLock',
  '',
  '① build tin (ưu tiên "ND báo hàng" của đơn)',
  '② gửi qua local-runner  (bước GỬI chung)',
  '③ OK + AUTO_UPDATE_STATUS → cập nhật web Basso',
  '④ ghi reports (success/failed)',
  '⑤ OK → ghi dấu "manual" vào dedup',
], { size: 13.5, mono: true, fill: '#1e293b', lh: 23 });
text(60, y2 + 250, 'Có người soát → cho phép khớp "đơn trên cùng"', { size: 12.5, fill: '#64748b' });

// C - bot
box(660, y2 + 20, 580, 250, C.auto, C.autoB);
text(680, y2 + 52, 'C) BÁO TỰ ĐỘNG — bot', { size: 16, weight: 700, fill: '#9d174d' });
lines(680, y2 + 82, [
  '(1) Poller mỗi 2 phút   (2) Webhook /arrived',
  '        → runAutoNotify()  🔒 withLock',
  '',
  '① runner offline? → bỏ lượt (không trừ lượt)',
  '② quét HẾT trang đơn "Chưa báo" (not_sent)',
  '③ lọc: có Zalo + chưa gửi + còn lượt thử',
  '④ gửi (strict, KHÔNG đụng web) → dedup',
], { size: 13.5, mono: true, fill: '#1e293b', lh: 23 });
text(680, y2 + 250, 'Không người soát → strict match, không "lấy đại"', { size: 12.5, fill: '#64748b' });

arrow(330, y2 + 270, 330, y2 + 330, C.line);
arrow(950, y2 + 270, 950, y2 + 330, C.line);

// ===== Hàng 3: bước GỬI chung (FLOW D) =====
const y3 = 640;
box(40, y3, 1200, 210, C.runner, C.runnerB);
text(60, y3 + 34, 'D) BƯỚC GỬI QUA LOCAL-RUNNER  (chung cho cả tay & bot)', { size: 16, weight: 700, fill: '#065f46' });
lines(60, y3 + 66, [
  'server.sendBaoHang → POST /api/zalo/send → runner trả jobId → server poll /api/job/:id (tới khi done/error)',
  '',
  'runner xử lý job (tuần tự) → salework.sendBaoHang():',
], { size: 13.5, mono: true, fill: '#064e3b', lh: 23 });
lines(80, y3 + 142, [
  '① TEST_MODE: chỉ gửi số trong TEST_PHONES (chặn an toàn)',
  '② mở browser (session đã lưu) → vào Salework → kiểm tra đăng nhập → chọn account Zalo',
  '③ tìm & mở hội thoại (tên/SĐT; bot = strict, không khớp chắc thì BÁO LỖI, không gửi)',
  '④ dán nội dung (giữ xuống dòng) → bấm Gửi → trả { ok:true }',
], { size: 13.5, mono: true, fill: '#064e3b', lh: 23 });

// ===== Hàng 4: lưu trữ =====
const y4 = 900;
box(40, y4, 580, 170, C.db, C.dbB);
text(60, y4 + 32, 'SQLite — reports', { size: 16, weight: 700, fill: '#334155' });
lines(60, y4 + 62, [
  'Mọi lượt gửi (tay + bot, OK + lỗi)',
  '→ xem ở trang /reports.html',
  'kèm thống kê ✅ / ❌',
], { size: 13.5, fill: '#334155', lh: 24 });

box(660, y4, 580, 170, C.db, C.dbB);
text(680, y4 + 32, 'SQLite — auto_notified (chống trùng)', { size: 16, weight: 700, fill: '#334155' });
lines(680, y4 + 62, [
  'khóa: c<customerId>:d<dateInventory>',
  "status: 'success' (bot) / 'manual' (tay) / 'failed'",
  '→ bot bỏ qua đơn đã success/manual',
], { size: 13.5, mono: true, fill: '#334155', lh: 24 });

arrow(620, y3 + 180, 660, y4 + 40, C.line);
arrow(560, y3 + 195, 330, y4, C.line);

// ===== Hàng 5: các lớp an toàn =====
const y5 = 1110;
text(40, y5 + 4, 'Các lớp chống sai & chống trùng', { size: 18, weight: 700 });
const safety = [
  ['TEST_MODE', 'chỉ gửi số whitelist'],
  ['Khóa dedup ổn định', 'không phụ thuộc field id'],
  ['success / manual', 'không gửi lại lần 2'],
  ['withLock', 'tay & bot không chạy chồng'],
  ['strictMatch', 'bot không gửi nhầm người'],
  ['skip khi runner offline', 'không "bỏ cuộc" oan'],
  ['quét hết trang', 'không bỏ sót đơn >100'],
];
let sx = 40; let sy = y5 + 28;
const cardW = 288; const cardH = 70; const gap = 16;
safety.forEach((s, i) => {
  const col = i % 4; const row = Math.floor(i / 4);
  const x = 40 + col * (cardW + gap);
  const y = sy + row * (cardH + gap);
  box(x, y, cardW, cardH, C.white, C.ok, 12);
  text(x + 16, y + 28, '✓ ' + s[0], { size: 14.5, weight: 700, fill: C.ok });
  text(x + 16, y + 52, s[1], { size: 13, fill: '#475569' });
});

// footer
text(40, H - 24, '* Bot mặc định CẬP NHẬT web Basso (AUTO_NOTIFY_UPDATE_WEB=true) + đánh dấu trong mi (badge 🤖). Đặt =false để chỉ đánh dấu trong mi. Chi tiết: docs/FLOW.md', { size: 13, fill: '#64748b' });

add('</svg>');

const svg = parts.join('\n');
const svgPath = path.join(OUT_DIR, 'flow.svg');
fs.writeFileSync(svgPath, svg);

const resvg = new Resvg(svg, { font: { loadSystemFonts: true }, background: 'white' });
const png = resvg.render().asPng();
const pngPath = path.join(OUT_DIR, 'flow.png');
fs.writeFileSync(pngPath, png);
console.log('Wrote', svgPath, 'and', pngPath, `(${png.length} bytes)`);
