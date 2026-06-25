'use strict';
/**
 * ecosystem.config.js — Cấu hình PM2 cho mi (theo pattern Xeko).
 *
 * 2 tiến trình, thường chạy ở 2 NƠI KHÁC NHAU:
 *   - mi-runner : chạy trên MÁY CÓ CHROME (VPS/máy nhân viên). Đây là cái QUAN TRỌNG
 *                 nhất phải bọc PM2 — Playwright/Chrome hay crash mà start.js không tự
 *                 hồi sinh (child exit -> launcher thoát luôn).
 *   - mi-server : Express + dashboard. Thường deploy lên cloud (ai.basso.vn) và KHÔNG
 *                 cần PM2 ở đó. Chỉ bật app này khi bạn tự host server trên chính VPS.
 *
 * Dùng:
 *   pm2 start ecosystem.config.js               # chạy cả 2
 *   pm2 start ecosystem.config.js --only mi-runner   # chỉ runner (trường hợp phổ biến)
 *   pm2 save && pm2 startup                      # auto-start cùng máy khi reboot
 *   pm2 logs mi-runner    /    pm2 restart mi-runner    /    pm2 status
 *
 * Biến môi trường vẫn đọc từ .env như bình thường (start.js/server đều gọi
 * dotenv.config). Các env dưới đây chỉ ÉP vài giá trị quan trọng khi chạy production.
 */
module.exports = {
  apps: [
    {
      name: 'mi-runner',
      script: 'start.js',
      cwd: __dirname,
      // Fork (KHÔNG cluster): runner là stateful — 1 phiên Chrome/đăng nhập Zalo duy nhất.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Chrome rò rỉ RAM theo thời gian: tự restart khi vượt ngưỡng để tránh treo máy.
      max_memory_restart: '800M',
      // Crash thì chờ chút rồi mới dựng lại, tránh vòng lặp crash đốt CPU.
      restart_delay: 5000,
      // Nếu crash >15 lần trong <10s thì coi là lỗi cấu hình -> dừng hẳn để báo động.
      min_uptime: 10000,
      max_restarts: 15,
      time: true,           // gắn timestamp vào log
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        // Trên VPS không có màn hình -> chạy ẩn. (.env mẫu để HEADLESS=false cho debug.)
        HEADLESS: 'true',
      },
    },
    {
      name: 'mi-server',
      script: 'server/index.js',
      cwd: __dirname,
      exec_mode: 'fork',    // localRegistry lưu URL runner trong RAM -> không scale nhiều instance.
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      restart_delay: 3000,
      min_uptime: 10000,
      max_restarts: 15,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        // server ưu tiên PORT, rồi SERVER_PORT, cuối cùng 8080 (xem .env.example).
      },
    },
  ],
};
