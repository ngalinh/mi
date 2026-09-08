# Tự động deploy mi runner lên VPS Windows

Workflow `.github/workflows/deploy-vps.yml` deploy commit mới của nhánh `main` lên GitHub Actions self-hosted runner Windows và chỉ reload PM2 process `mi-runner`; `mi-server` không bị tác động.

## Phần mềm cần cài

- Windows Server 2016 trở lên, Windows 10 hoặc Windows 11 64-bit.
- Git for Windows.
- Node.js 22 LTS (tối thiểu 22.5) và npm.
- PM2 cùng tiện ích tự khởi động trên Windows:

  ```powershell
  npm install --global pm2 pm2-windows-startup
  pm2-startup install
  ```

- GitHub Actions self-hosted runner được đăng ký với custom label `vps`.

Workflow tự chạy `npx playwright install chromium`; không cần cài Chromium thủ công.

## Đăng ký GitHub Actions runner

Dùng runner instance riêng cho mi tại `C:\actions-runner-mi`. Trong repository mi mở Settings → Actions → Runners → New self-hosted runner, chọn Windows/x64 và chạy đúng các lệnh GitHub sinh ra. Khi chạy `config.cmd`, thêm label `vps`. Runner phải có đủ labels `self-hosted`, `Windows`, `X64`, `vps`.

Nếu Playwright chạy headed (`HEADLESS=false`), khởi động runner tương tác bằng `run.cmd` trong Windows user đang đăng nhập. Không chạy runner hoặc PM2 trong Session 0 vì cửa sổ Chrome không hiển thị được. Muốn tự bật sau reboot, cấu hình auto-login và Task Scheduler với lựa chọn “Run only when user is logged on”.

## Thư mục ứng dụng

Thư mục hiện tại:

```powershell
New-Item -ItemType Directory -Force C:\mi
```

User chạy GitHub runner phải có quyền Modify trên thư mục này. Lần workflow đầu tiên sẽ clone source rồi dừng an toàn nếu thiếu secret. Sau đó tạo `C:\mi\.env` từ `.env.example`, điền `REMOTE_BOT_URL`, `API_KEY`, URL public/tunnel và cấu hình headless phù hợp, rồi chạy lại workflow.

Nếu mi đang nằm ở thư mục khác, đặt repository variable `MI_DEPLOY_DIR` thành đường dẫn hiện tại để không tạo bản chạy thứ hai. Health check mặc định là `http://127.0.0.1:8090/health`; thay bằng `MI_HEALTHCHECK_URL` nếu port khác.

Sau lần deploy thành công:

```powershell
pm2 save
pm2 status
```

## Lưu ý

Hai workflow dùng chung file lock trong `%TEMP%` để không deploy Xeko và mi đồng thời. File `.env`, profile Playwright và dữ liệu không được Git theo dõi sẽ được giữ nguyên qua các lần deploy.
