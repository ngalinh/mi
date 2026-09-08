# Tự động deploy mi runner lên VPS

Workflow `.github/workflows/deploy-vps.yml` deploy đúng commit mới nhất của nhánh `main` lên self-hosted runner và chỉ khởi động lại tiến trình PM2 `mi-runner`. Tiến trình `mi-server` không bị tác động vì theo kiến trúc hiện tại server thường chạy trên cloud.

## Chuẩn bị một lần trên VPS

1. Dùng cùng user GitHub Actions runner đang chạy Xeko. User này phải sở hữu thư mục deploy và không nên có quyền `sudo` trong workflow.
2. Gắn các label cho runner: `self-hosted`, `Linux`, `X64`, `vps`.
3. Cài Git, Node.js >= 22.5, npm, PM2, curl, flock và các thư viện hệ thống của Playwright.
4. Tạo thư mục và cấp quyền cho user runner:

   ```bash
   sudo mkdir -p /srv/mi
   sudo chown -R <runner-user>:<runner-user> /srv/mi
   ```

5. Sau lần workflow đầu tiên (workflow sẽ clone source rồi dừng vì chưa có secret), tạo `/srv/mi/.env` từ `.env.example` và điền giá trị production. Các giá trị quan trọng gồm `REMOTE_BOT_URL`, `API_KEY`, URL public/tunnel và cấu hình headless phù hợp với VPS.
6. Cài thư viện hệ thống Playwright một lần nếu VPS chưa có:

   ```bash
   cd /srv/mi
   sudo npx playwright install-deps chromium
   ```

7. Cho PM2 tự phục hồi sau reboot bằng `pm2 startup`, sau đó chạy lệnh mà PM2 in ra. Workflow sẽ tự gọi `pm2 save` sau mỗi deploy.

## Biến GitHub tùy chọn

Trong repository Settings → Actions → Variables:

- `MI_DEPLOY_DIR`: mặc định `/srv/mi`.
- `MI_HEALTHCHECK_URL`: mặc định `http://127.0.0.1:8090/health`.

## Cách hoạt động

Mỗi push/merge vào `main` sẽ:

1. Khóa deploy chung trên VPS để Xeko và mi không restart PM2 đồng thời.
2. Fetch đúng commit GitHub yêu cầu và checkout vào thư mục cố định.
3. Giữ nguyên các file không được Git theo dõi như `.env`, dữ liệu và profile Playwright.
4. Chạy `npm ci`, cài đúng phiên bản Chromium, rồi reload duy nhất `mi-runner` bằng cấu hình PM2 hiện có.
5. Chỉ báo thành công khi endpoint health check phản hồi HTTP 2xx.

Có thể chạy lại thủ công từ Actions → Deploy mi runner to VPS → Run workflow.

## Lưu ý an toàn

Code được merge vào `main` có thể thực thi trên VPS. Nên bật branch protection/review cho `main`, dùng runner user riêng, không đưa secret vào repository và không cấp `sudo` không mật khẩu cho runner.
