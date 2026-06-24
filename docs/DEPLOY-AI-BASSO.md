# Hướng dẫn deploy mi lên ai.basso.vn (giống Xeko)

Kiến trúc giống Xeko: **2 phần** chạy ở 2 nơi.

```
┌─────────────────────────────┐   register-local + forward    ┌──────────────────────────────┐
│  SERVER (bộ não)            │ ◀──────────────────────────── │  LOCAL-RUNNER (máy có Chrome) │
│  deploy lên ai.basso.vn     │ ── forward /api/zalo/send ──▶  │  chạy start.js trên máy NV    │
│  /b/<bot-id>/ (dashboard)   │                               │  Playwright + session Zalo    │
└─────────────────────────────┘                               └──────────────────────────────┘
```

- **SERVER** (`server/`) → deploy lên nền tảng bot **ai.basso.vn**. Đây là dashboard + API + SQLite.
- **LOCAL-RUNNER** (`local-runner/` qua `start.js`) → chạy trên **máy Windows có Chrome** của bạn. Nó tự đăng ký URL lên server (heartbeat 30s) và là nơi thực sự mở trình duyệt gửi Zalo.

> ⚠️ KHÔNG deploy local-runner lên cloud — nó cần Chrome thật + session đăng nhập Zalo trên máy bạn.

---

## 0. Yêu cầu

| | Yêu cầu |
|---|---|
| Node trên ai.basso.vn | **≥ 22.5** dùng `node:sqlite` built-in (khỏi compile). Node cũ hơn vẫn chạy được nếu cài `better-sqlite3` (xem §1.5). |
| Máy local-runner | Windows/máy có Chrome, Node ≥ 22.5, mạng ra Internet |
| Tunnel (khuyến nghị) | cloudflared / ngrok để server gọi vào runner mà không mở cổng |

---

## 1. Deploy SERVER lên ai.basso.vn

### 1.1 Tạo bot trên nền tảng
1. Tạo 1 bot mới trên ai.basso.vn → nền tảng cấp 1 URL dạng `https://ai.basso.vn/b/<bot-id>`.
2. Trỏ bot vào repo `ngalinh/mi` (nhánh deploy của bạn).
3. **Build/Install**: `npm install` rồi `npx playwright install chromium` *(server không gửi Zalo nhưng `playwright` là dependency — vẫn cần cài để `npm install` không lỗi; nếu nền tảng cho bỏ qua download browser thì đặt `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`)*.
4. **Start command**: `npm start` (= `node server/index.js`).
5. **Port**: nền tảng tự cấp qua biến `PORT` — server tự đọc, **không cần** đặt tay.

### 1.2 Base path `/b/<id>/` — đã xử lý
Dashboard mi đã dùng đường dẫn **tương đối** + tự suy `BASE` từ URL nên chạy đúng dưới `/b/<id>/` (giống Xeko). Không cần cấu hình gì thêm.

### 1.3 Lưu trữ bền cho dữ liệu (QUAN TRỌNG)
SQLite (`doraemi.sqlite`) chứa **Lịch sử báo** + **khóa chống gửi trùng**, và nằm trên server ai.basso.vn. Container là *ephemeral* — restart là mất nếu không bền. **Hai cách** (chọn 1):

- **Có volume**: map 1 volume bền (vd `/data`) rồi đặt `DATA_DIR=/data` (db = `/data/doraemi.sqlite`).
  Hoặc map volume thẳng vào `./data` của app — khi đó không cần đặt biến gì.
- **Không/không rõ volume**: hỏi nền tảng đường dẫn ổ ghi-bền rồi trỏ `DB_PATH` vào đó
  (vd `DB_PATH=/var/lib/mi/doraemi.sqlite`).

> ⚠️ Nếu KHÔNG có nơi bền nào, mỗi lần redeploy/restart sẽ mất khóa chống trùng → bot **nhắn lại trùng** cho khách. Bắt buộc cấu hình 1 trong 2 cách trên trước khi go-live.
>
> 📌 *Chỉ* SQLite này nằm trên ai.basso.vn. **Session đăng nhập Zalo + danh sách tài khoản** nằm trên **máy local-runner** (`playwright-data/`, `config/`), không ở cloud.

### 1.5 Node < 22.5? (fallback better-sqlite3)
`db.js` tự dò: có `node:sqlite` (Node ≥ 22.5) thì dùng built-in; không thì fallback **`better-sqlite3`** (đã khai báo `optionalDependencies`). Nếu Node của nền tảng < 22.5:
- Đảm bảo bước install build được `better-sqlite3` (cần build-tools/prebuilt). Nếu `npm install` bỏ qua optional, chạy `npm i better-sqlite3` trong build step.
- Không cần sửa code — driver tự chọn lúc khởi động.

### 1.4 Biến môi trường cho SERVER (đặt trong phần Env của bot)

```ini
# Bắt buộc
API_KEY=<chuoi-ngau-nhien-dai-GIONG-runner>     # bí mật chung server↔runner
REQUIRE_API_KEY=true                            # production: thiếu key là dừng (fail-closed)

# Basso Partner API (Basso cung cấp). Để trống BASSO_API_BASE_URL = chạy MOCK.
BASSO_API_BASE_URL=https://api.basso.vn
BASSO_API_KEY=...
BASSO_EMAIL=...
BASSO_PASS=...
USE_MOCK=false

# Tự động báo hàng
AUTO_NOTIFY=true
AUTO_NOTIFY_INTERVAL_MS=60000
AUTO_NOTIFY_UPDATE_WEB=true

# Bảo mật (khuyến nghị bật ở production)
GATEWAY_SECRET=<bí-mật-chung-với-gateway>       # chặn gọi thẳng app, giả mạo danh tính
REGISTER_ALLOWED_HOSTS=*.trycloudflare.com      # chỉ cho runner đăng ký URL thuộc host này
CORS_ORIGIN=https://ai.basso.vn

# KHÔNG cần PLAYWRIGHT_LOCAL_URL nếu dùng start.js (runner tự đăng ký).
```

> **`GATEWAY_SECRET`**: nếu bật, cấu hình gateway ai.basso.vn **gắn header `X-Gateway-Secret`** (đúng giá trị này) khi forward request vào bot. Nếu chưa cấu hình được header ở gateway thì **để trống** (giữ như cũ) cho tới khi sẵn sàng.

---

## 2. Cài LOCAL-RUNNER trên máy có Chrome

```powershell
git clone <repo> mi
cd mi
npm install
npm run install:browser        # tải Chromium cho Playwright
copy .env.example .env          # rồi sửa .env (mục dưới)
```

### 2.1 `.env` trên máy runner (các biến quan trọng)

```ini
API_KEY=<GIONG HỆT API_KEY của server>
REQUIRE_API_KEY=true

LOCAL_PORT=8090
REMOTE_BOT_URL=https://ai.basso.vn/b/<bot-id>   # URL bot ở bước 1.1
# URL công khai của runner để server gọi vào. Nếu dùng cloudflared cố định thì điền vào đây:
PLAYWRIGHT_PUBLIC_URL=https://<ten>.trycloudflare.com
REGISTER_INTERVAL_MS=30000

# Zalo Basso (mặc định đã đúng)
SALEWORK_URL=https://zalo.basso.vn

# AN TOÀN: bật TEST_MODE khi mới chạy — chỉ gửi tới số trong TEST_PHONES
TEST_MODE=true
TEST_PHONES=098xxxxxxx            # số của chính bạn để thử
HEADLESS=false                    # để thấy cửa sổ khi đăng nhập lần đầu
```

### 2.2 Mở tunnel + chạy runner

```powershell
# Cửa sổ 1: tunnel cổng 8090 ra Internet (lấy URL https://...trycloudflare.com)
cloudflared tunnel --url http://localhost:8090

# Cửa sổ 2: chạy runner (spawn local-runner + heartbeat đăng ký URL lên cloud)
npm run runner
```

Nếu `PLAYWRIGHT_PUBLIC_URL` để trống, `start.js` sẽ tự dò IP public + cổng (cần mở/forward cổng).
Kiểm tra: vào `GET https://ai.basso.vn/b/<id>/api/health` → `localRunner.online: true` là OK.

> Giữ bền: bọc bằng `pm2 start start.js --name mi-runner` (hoặc NSSM/Task Scheduler) để auto-restart + auto-start cùng máy.

---

## 3. Thêm tài khoản Zalo (Mô hình B — mỗi NV 1 profile)

Trên dashboard → **Cài đặt → Tài khoản Zalo → Thêm tài khoản**:
- **Mã profile (key)**: vd `linh_duong` (dùng làm tên thư mục session, không đổi sau này).
- **Tên nhân viên**, **Tên Zalo trong dropdown** (đúng tên hiện ở zalo.basso.vn), **staffId** (= userId NV trong đơn — để khớp đơn → account), **Tự động báo**: Bật/Tắt.

Bấm Lưu → trên **máy runner** sẽ bật cửa sổ Chromium → **đăng nhập Zalo Basso + chọn đúng tài khoản** → đóng cửa sổ (session tự lưu). Cột **Kết nối** bấm **Kiểm tra** để xác nhận.

> Cách cũ vẫn chạy (fallback): `ZALO_ACCOUNT_MAP` / `AUTO_NOTIFY_ACCOUNT` trong `.env` runner — dùng khi chưa khai báo account trên UI.

---

## 4. Chạy thử an toàn → bật thật

1. **Giữ `TEST_MODE=true`** + `TEST_PHONES` là số của bạn.
2. Trên dashboard, báo tay 1 đơn (hoặc đợi auto) → kiểm tra bạn nhận được tin.
3. Xem **Lịch sử báo** + log runner. Ổn rồi mới:
   - Đặt `TEST_MODE=false` trên runner (gửi khách thật).
   - Đảm bảo `AUTO_NOTIFY=true` trên server nếu muốn tự động.

---

## 5. Checklist trước khi go-live

- [ ] Node ≥ 22.5 trên ai.basso.vn.
- [ ] `data/` nằm trên volume bền.
- [ ] `API_KEY` GIỐNG NHAU ở server và runner; `REQUIRE_API_KEY=true` cả 2 nơi.
- [ ] `GET /b/<id>/api/health` → `localRunner.online: true`.
- [ ] Đã thêm + đăng nhập từng tài khoản Zalo, **Kiểm tra** = Đã kết nối.
- [ ] Đã test gửi với `TEST_MODE=true`, rồi mới tắt.
- [ ] (Khuyến nghị) bật `GATEWAY_SECRET` + cấu hình gateway gắn header; `REGISTER_ALLOWED_HOSTS` đúng host tunnel.
- [ ] (Tuỳ chọn) `AUTO_NOTIFY_WEBHOOK_SECRET` nếu Basso gọi webhook `/api/webhook/arrived`.

---

## 6. Lỗi thường gặp

| Triệu chứng | Nguyên nhân / cách sửa |
|---|---|
| Dashboard trắng / 404 CSS-JS | Asset path — đã fix bằng đường dẫn tương đối; xoá cache trình duyệt (server gửi `Cache-Control: no-store`). |
| `localRunner.online: false` | Runner chưa chạy / tunnel sai / `REMOTE_BOT_URL` sai / `API_KEY` lệch / host không nằm trong `REGISTER_ALLOWED_HOSTS`. |
| Server crash lúc start | Node < 22.5 (`node:sqlite`). Nâng Node. |
| 401 trên mọi `/api/*` | Bật `GATEWAY_SECRET` nhưng gateway chưa gắn header `X-Gateway-Secret`. Bỏ trống biến này hoặc cấu hình header ở gateway. |
| `KHONG_RO_TAI_KHOAN` khi auto gửi | Đơn chưa map được NV → account (chưa khai báo account/staffId trên UI, cũng chưa đặt `AUTO_NOTIFY_ACCOUNT`). Bot huỷ để tránh gửi nhầm. |
| Nhắn trùng sau khi restart cloud | `data/` không bền → mất khóa chống trùng. Map volume bền. |
