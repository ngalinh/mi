# Doraemi Bot — Tự động báo hàng về VN qua Zalo (Salework)

Chatbot tự động thông báo "hàng đã về kho VN" cho khách, gồm 3 phần như yêu cầu:

1. **Dashboard** hiển thị danh sách hàng về (lấy từ API website — hiện dùng dữ liệu MOCK, ráp API thật sau).
2. **Trang lịch sử báo** — log mọi lượt nhắn tin (thành công/thất bại, nội dung, thời gian).
3. **Automation Playwright** trên trang quản lý **Zalo Basso** (`https://zalo.basso.vn`, giao diện Vuetify), port y hệt flow Zalo của [Xeko](https://github.com/ngalinh/Xeko). (Trước đây dùng `zalo.salework.net` — vẫn override được qua `SALEWORK_URL`.)

## Kiến trúc (giống Xeko)

```
┌────────────────────────┐       HTTP (tunnel/localhost)      ┌──────────────────────────┐
│  server/  (ai.basso.vn) │  ──── POST /api/zalo/send ───────▶ │ local-runner/ (máy có Chrome)│
│  • Dashboard + Reports  │  ◀─── poll /api/job/:id  ───────── │ • Playwright persistent ctx │
│  • bassoApi (đọc orders)│                                    │ • Điều khiển zalo.basso.vn  │
│  • SQLite log lịch sử   │                                    │ • Lưu session đăng nhập     │
└────────────────────────┘                                    └──────────────────────────┘
```

- **server/**: Express, phục vụ web + API, lưu lịch sử (SQLite). Có thể deploy lên server.
- **local-runner/**: chạy trên **máy Windows có trình duyệt**, giữ session đăng nhập Salework, thực thi automation. POST trả `jobId`, client poll kết quả (tránh timeout qua tunnel).

> Vì sao tách? Session đăng nhập Zalo/Salework cần ở máy "thật" để tránh bị chặn và giữ đăng nhập lâu dài — đúng pattern Xeko.

## Cài đặt

```powershell
npm install
npm run install:browser   # tải Chromium cho Playwright
copy .env.example .env     # rồi sửa .env
```

Trong `.env` đặt `API_KEY` (chuỗi ngẫu nhiên, giống nhau cho cả 2 process).

## Chạy

### 1) Local-runner (máy có Chrome) — đăng nhập Salework lần đầu
```powershell
npm run local:debug        # mở cửa sổ browser (HEADLESS=false)
```
Lần đầu hãy mở `https://zalo.basso.vn` trong cửa sổ browser do bot bật lên và **đăng nhập thủ công 1 lần**. Session được lưu vào `playwright-data/salework-default/` nên các lần sau không phải login lại.

> Tip: profile mặc định là `default`. Mỗi account Salework/Zalo nên dùng 1 profile riêng (truyền `profile` khi gọi `/api/notify`).

### 2) Server (dashboard)
```powershell
npm run server
```
Mở http://localhost:8080 — dashboard "Hàng về VN".

### Chung 1 máy?
Để mặc định `PLAYWRIGHT_LOCAL_URL=http://localhost:8090` là chạy chung máy được luôn. Nếu local-runner ở máy khác sau NAT, dùng tunnel:
```powershell
# ví dụ với cloudflared / ngrok
ngrok http 8090
# rồi đặt PLAYWRIGHT_LOCAL_URL = URL tunnel trong .env của server
```

## Luồng hoạt động

1. Dashboard gọi `GET /api/orders` → bảng hàng về.
2. Chọn các đơn **"Chưa báo"** (hoặc bấm 📣 ở 1 dòng để xem/sửa nội dung trước khi gửi).
3. `POST /api/notify { orderIds, messageOverride? }` → server build tin nhắn → forward xuống local-runner → Playwright tìm khách theo SĐT/tên trên Salework và gửi.
4. Mỗi lượt được ghi vào **Lịch sử báo** (`/reports.html`).

## Tự động báo hàng (auto-notify) 🆕

> 📄 Sơ đồ toàn bộ luồng A→Z: xem [`docs/FLOW.md`](docs/FLOW.md).

![Sơ đồ luồng Doraemi Bot](docs/flow.png)


Không cần bấm tay: cứ có đơn **"Chưa báo"** (`not_sent` = hàng đã về kho) là hệ thống tự
build tin nhắn + gửi qua Zalo. Có **chống gửi trùng** (mỗi đơn chỉ tự gửi 1 lần thành công;
gửi lỗi sẽ thử lại tối đa `AUTO_NOTIFY_MAX_RETRIES` lần rồi thôi — tránh spam khi runner offline).

**2 cách kích hoạt** (dùng chung 1 luồng):

1. **Poller định kỳ** — server tự quét mỗi `AUTO_NOTIFY_INTERVAL_MS` (mặc định 2 phút).
   Bật bằng `.env`:
   ```
   AUTO_NOTIFY=true
   AUTO_NOTIFY_INTERVAL_MS=120000
   AUTO_NOTIFY_PROFILE=default
   ```
   Hoặc bật/tắt ngay trên dashboard qua badge **"Tự động"** (góc trên phải).

2. **Webhook real-time** — để website Basso gọi sang **ngay khi có hàng về**:
   ```
   POST /api/webhook/arrived
   Header (tùy chọn): x-webhook-secret: <AUTO_NOTIFY_WEBHOOK_SECRET>
   ```
   Server sẽ quét + gửi ngay, trả tóm tắt `{ scanned, candidates, sent, failed }`.

> Điều kiện gửi 1 đơn: trạng thái `not_sent`. Việc khách có Zalo hay không được
> xác định lúc gửi (tìm hội thoại theo SĐT trên Salework); không thấy thì báo lỗi.

**Cơ chế chống sai (đã kiểm thử):**
- **Khóa chống trùng ổn định**: dedup theo `customerId:dateInventory` (khóa thật của 1 dòng
  hàng về), không phụ thuộc field `id` (API thật có thể không trả) → không bị "gửi 1 đơn rồi
  bỏ hết".
- **Không gửi trùng với báo tay**: dashboard loại đơn bot đã gửi khỏi "Báo hàng loạt" (vẫn hiện
  badge 🤖) → khách không nhận 2 lần dù web vẫn `not_sent`.
- **Quét hết các trang** `not_sent` trong mỗi lượt → không bỏ sót khi có >100 đơn chờ.
- **Runner offline → bỏ cả lượt, KHÔNG trừ lượt thử**; lỗi mạng/timeout giữa chừng cũng không
  trừ → tự gửi lại nguyên vẹn khi runner online lại (chỉ lỗi cấp-đơn mới tính `maxRetries`).
- **Khớp chắc chắn (strict)**: bot chỉ gửi khi tìm đúng hội thoại theo tên/SĐT, KHÔNG "lấy đại
  đơn trên cùng" như gửi tay → tránh gửi nhầm khách khi không có người soát.
- **Không gửi chồng tay ↔ tự động**: hai luồng dùng chung 1 khóa (`server/lock.js`) nên chạy
  tuần tự, không cùng gửi 1 đơn. Báo tay thành công cũng ghi dấu `manual` vào bảng dedup →
  bot không gửi lại, kể cả khi không cập nhật web Basso. (Đã test bắn đồng thời: mỗi khách
  chỉ nhận đúng 1 tin.)

**Bot gửi xong ĐẨY trạng thái "Đã báo hàng" về web Basso** như luồng báo tay (mặc định
`AUTO_NOTIFY_UPDATE_WEB=true`, tuân theo `AUTO_UPDATE_STATUS`). Đồng thời vẫn đánh dấu
trong mi qua bảng `auto_notified`, và dashboard hiển thị badge **🤖 Bot đã gửi** (kèm giờ
gửi) ở cột trạng thái để phân biệt rõ với báo tay. Muốn bot CHỈ đánh dấu trong mi mà không
đụng vào web thì đặt `AUTO_NOTIFY_UPDATE_WEB=false` (khi đó đơn giữ nhãn web gốc).

## Gửi bằng tài khoản Zalo theo nhân viên 🆕

Bối cảnh: tất cả nhân viên đăng nhập **cùng 1 link Salework** (`salework.net/login/user18`),
nhưng trong chat `zalo.salework.net` mỗi người là **một tài khoản Zalo riêng**, chọn qua
dropdown. Hai khái niệm trong code tách biệt:

- **`profile`** = một *phiên đăng nhập Salework* (lưu ở `playwright-data/salework-<profile>/`).
  Dùng chung 1 login user18 ⇒ **chỉ cần 1 profile** (`default`), đăng nhập 1 lần (`npm run login`).
- **`account`** = *tài khoản Zalo nào* được chọn trong dropdown trước khi gửi
  (`local-runner/salework.js` → `selectZaloAccount`).

Để **mỗi đơn tự gửi bằng Zalo của nhân viên phụ trách**, khai báo ánh xạ trong `.env` của server:

```
# key = user_id NV (ưu tiên) hoặc tên NV; value = TÊN account Zalo trong dropdown Salework
ZALO_ACCOUNT_MAP={"18":"Zalo Linh","25":"Zalo Hà"}
```

Thứ tự ưu tiên chọn account khi gửi (cả báo tay lẫn tự động):
1. `account` truyền thẳng vào lệnh (nếu có).
2. **Ánh xạ theo nhân viên** (`ZALO_ACCOUNT_MAP`, khớp `userId` rồi tới tên `staff`).
3. Account mặc định: `AUTO_NOTIFY_ACCOUNT` (tự động) / `DEFAULT_ZALO_ACCOUNT` ở runner (báo tay).

Kiểm tra nhanh số NV đã map ở `GET /api/health` → `zaloAccountMapped`. Tên account phải **khớp
đúng** tên hiện trong dropdown Salework, nếu không `selectZaloAccount` báo `KHONG_THAY_TAI_KHOAN_ZALO`.

**Xem 1 profile đang đăng nhập những Zalo nào** (chạy trên máy runner, dùng session đã lưu):

```powershell
npm run accounts              # profile mặc định "default"
npm run accounts -- ten_acc   # profile khác
```

In ra trạng thái đăng nhập + danh sách tên tài khoản Zalo đang thấy (kèm ảnh
`screenshots/02a-account-search.png`). Copy đúng tên ở đây để điền vào `ZALO_ACCOUNT_MAP`.

## Ráp API website thật (ĐÃ tích hợp Basso Partner API)

Chỉ cần điền `.env` là chạy thật:
```
BASSO_API_BASE_URL=https://api.basso.vn   # Basso cung cấp
BASSO_API_KEY=...                          # X-Partner-Api-Key
BASSO_EMAIL=...                            # tài khoản login
BASSO_PASS=...
AUTO_UPDATE_STATUS=true                     # gửi xong tự đánh dấu "Đã báo hàng" về web
```
Để trống `BASSO_API_BASE_URL` => tự chạy MOCK.

Đã cài sẵn trong [`server/bassoApi.js`](server/bassoApi.js):
- **Login + cache token**: `POST /partner/login` → `data.access_token` (tự login lại khi hết hạn / gặp 401).
- **List**: `GET /partner/getArrivedVnList` (filter `status`, `from`/`to` DD-MM-YYYY, `key`, `tab`=user_id NV, `page_size`).
- **Chi tiết SP (load lazy)**: `GET /partner/getArrivedVnItems?id=` (hoặc `customer_id`+`date_inventory`) — gọi khi mở rộng từng dòng để lấy đầy đủ danh sách sản phẩm đã về.
- **Update**: `POST /partner/updateArrivedVnRow` `{customer_id, date_inventory, status, note}` — tự gọi sau khi gửi Zalo thành công (nếu `AUTO_UPDATE_STATUS=true`).

Map trạng thái API → nhãn: `not_sent`=Chưa báo, `notified_arrival`=Đã báo hàng, `notified_ship`=Đã báo ship, `send_failed`=Gửi lỗi.

Shape đơn (1 dòng hàng về):
```
{ id, customerId, dateInventory, stt, warehouseDate, customerName, phone,
  noiDungBaoHang, noiDungBaoShip, statusCode, status, note, staff, userId }
```

### Chi tiết sản phẩm đã về (đầy đủ như web `basso/arrived_vn`)

Dashboard **load lazy** qua `GET /api/arrived-items?id=&customerId=&dateInventory=`
(server gọi tiếp `/partner/getArrivedVnItems`) khi bấm mở rộng 1 dòng. Mỗi sản phẩm
(`normalizeItem`) map từ field thô đã xác nhận từ response thật:

| Cột hiển thị | Field thô | Trường nội bộ |
|---|---|---|
| Tình trạng | `shipped_time` (null → "Chưa giao") | `shipStatusLabel`, `shippedDate` |
| Mã ĐH | `orderCode` | `orderCode` |
| Hình SP | `image` | `image` |
| Tên/link sp | `nameItem`, `linkItem` | `name`, `link` |
| Size/Màu | `variationsItem` (**chuỗi JSON** `[{name,value}]`) | `variations` |
| SL về / Đã về | `soLuongVe`, `tongsanphamDaVe`/`tongsanpham` | `quantity`, `arrivedQty`/`totalQty` |
| Cân nặng | `canNang` | `weight` |
| Phí VC | `phiShip` | `shipFee` |
| Giá sp | `price`, `currency_symbol` | `priceValue`, `currencySymbol` |
| Phụ thu | `term_fee` | `termFee` |
| Tổng giá (VND) | tính: `price × currency_rate + phiShip + term_fee` | `totalVnd` |

## Khi giao diện Salework thay đổi

Mọi selector tập trung trong [`local-runner/salework.js`](local-runner/salework.js). Chạy `npm run local:debug` để xem cửa sổ + ảnh chụp từng bước trong thư mục `screenshots/` để chỉnh selector.

## Mẫu tin nhắn

Sửa nội dung mặc định trong [`shared/messageTemplate.js`](shared/messageTemplate.js). Nếu đơn đã có sẵn "ND báo hàng" thì hệ thống ưu tiên dùng nguyên văn nội dung đó.

## API tóm tắt

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/orders?status=&staff=&q=&from=&to=` | Danh sách hàng về |
| GET | `/api/arrived-items?id=&customerId=&dateInventory=` | Chi tiết SP đã về 1 dòng (load lazy) |
| POST | `/api/notify` `{orderIds[], profile?, account?, messageOverride?}` | Báo hàng |
| GET | `/api/auto-notify` | Trạng thái tự động báo hàng |
| POST | `/api/auto-notify/toggle` `{enabled}` | Bật/tắt tự động (runtime) |
| POST | `/api/auto-notify/run` | Quét + gửi ngay 1 lượt |
| POST | `/api/webhook/arrived` | Webhook: có hàng về → gửi ngay (header `x-webhook-secret`) |
| GET | `/api/reports?status=&q=&limit=` | Lịch sử + thống kê |
| POST | `/api/register-local` `{url, apiKey}` | Runner tự khai báo URL (Xeko pattern) — server lưu trong RAM + dùng forward |
| GET | `/api/health` | Trạng thái server + local-runner + auto-notify |
| GET/POST | `/api/accounts` | Liệt kê / thêm tài khoản Zalo (forward xuống runner) |
| PUT | `/api/accounts/:key` | Sửa account (tên, saleworkName, staffId, autoEnabled, proxy…) |
| POST | `/api/accounts/:key/login` · `/check` | Mở lại Chromium đăng nhập · kiểm tra còn đăng nhập |
| DELETE | `/api/accounts/zalo/:key` | Xoá account (kèm session) |

Quản lý tài khoản Zalo trên **dashboard** (tab *Cài đặt → Tài khoản Zalo*): server cloud chỉ **forward** xuống local-runner (runner mới là nơi lưu account + mở Chromium).

Local-runner (bảo vệ bằng header `x-api-key`):

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/zalo/send` `{profile, account?, keyword, name?, message, strictMatch?, imagePaths?}` | Gửi báo hàng (trả `jobId`) |
| GET | `/api/job/:id` | Trạng thái job gửi |
| GET | `/api/accounts` | Liệt kê tài khoản + `loggedIn` + `connection` |
| POST | `/api/accounts` `{type:'zalo', key, name, saleworkName, phone?, staffId?, autoEnabled?, proxy?}` | Thêm account → mở Chromium đăng nhập + chọn tài khoản |
| PUT | `/api/accounts/:key` | Sửa account |
| POST | `/api/accounts/:key/login` | Mở lại Chromium đăng nhập lại |
| POST | `/api/accounts/:key/check` | Kiểm tra profile còn đăng nhập (mở browser) |
| GET | `/api/accounts/:key/history` | Lịch sử đăng nhập của profile |
| DELETE | `/api/accounts/zalo/:key` (`?keepProfile=1` để giữ session) | Xoá account (kèm thư mục session) |
| GET | `/api/profile/:name` | Kiểm tra profile đã có session chưa |
| GET | `/health` | Trạng thái runner |

### Mô hình tài khoản (Hướng B — giống Xeko)

Mỗi tài khoản Zalo = **1 profile trình duyệt riêng** (`playwright-data/salework-<key>`). Khi gửi, luồng tự động **chọn account theo NV phụ trách đơn**: `accountResolver` khớp `order.userId/staff` → account trong store → gửi bằng `profile=key` + chọn đúng `saleworkName` (có read-back verify, sai thì huỷ để khỏi gửi nhầm).

- `key` = mã profile; `saleworkName` = tên account trong dropdown `zalo.basso.vn`.
- `staffId`/`name` để khớp đơn → account; `autoEnabled` tắt thì luồng tự động bỏ qua đơn của NV đó (để báo tay).
- Fallback khi store rỗng/không khớp: `ZALO_ACCOUNT_MAP` (env, legacy) → `AUTO_NOTIFY_PROFILE`/`AUTO_NOTIFY_ACCOUNT`.
- `proxy` lưu để tương thích Xeko nhưng **chưa áp dụng** — mi chạy trên máy nhân viên (IP thật).

## Tự đăng ký URL runner lên cloud (Xeko pattern) 🆕

Thay vì hardcode `PLAYWRIGHT_LOCAL_URL` ở server, chạy launcher `start.js` trên máy có
Chrome — nó spawn local-runner rồi **tự POST URL của runner lên cloud** (`REMOTE_BOT_URL`)
qua `/api/register-local`, lặp lại **heartbeat mỗi 30s** (vì cloud lưu URL trong RAM, cứ
restart là mất). Đổi IP/tunnel không cần sửa `.env` của server.

```powershell
# .env trên máy runner:
REMOTE_BOT_URL=https://ai.basso.vn/b/<bot-id>   # URL bot trên cloud
API_KEY=...                                      # giống hệt server
PLAYWRIGHT_PUBLIC_URL=https://abcd.ngrok-free.app  # (tùy chọn) URL tunnel để khai báo

npm run runner      # = node start.js  (spawn runner + heartbeat đăng ký)
```

Server ưu tiên URL đã đăng ký (còn "tươi" trong ~90s); hết hạn thì fallback
`PLAYWRIGHT_LOCAL_URL`. Xem trạng thái ở `GET /api/health` → `localRunner.registered`.

> Giữ launcher sống bền: dùng PM2 (có sẵn [`ecosystem.config.js`](ecosystem.config.js)).
> File cấu hình đã đặt `max_memory_restart` (Chrome rò rỉ RAM) + chính sách restart chống
> crash-loop. **Không** ép `HEADLESS` — để `.env` tự quyết (Zalo nên chạy hiện cửa sổ).
>
> ```powershell
> pm2 start ecosystem.config.js --only mi-runner   # runner trên máy Windows có Chrome
> pm2 save                                          # lưu danh sách tiến trình
> ```
>
> **Auto-start khi reboot (Windows):** `pm2 startup` KHÔNG hỗ trợ Windows. Dùng một trong:
> - **[pm2-installer](https://github.com/jessety/pm2-installer)** (khuyến nghị) — cài PM2 thành
>   Windows Service, tự chạy `pm2 resurrect` lúc khởi động.
> - Hoặc **NSSM** bọc lệnh `pm2 resurrect`, hoặc Task Scheduler chạy lúc logon.
>
> Lưu ý nếu chạy PM2 dưới dạng **Windows Service** (chạy nền, không có session desktop) thì
> Chrome hiện-cửa-sổ (`HEADLESS=false`) sẽ không có màn hình để vẽ. Nếu cần Zalo chạy hiện
> cửa sổ, hãy để PM2 chạy trong phiên đăng nhập của nhân viên (Task Scheduler "run at logon")
> thay vì service nền.

## Deploy lên ai.basso.vn 🚀

Xem hướng dẫn từng bước + settings đầy đủ ở **[docs/DEPLOY-AI-BASSO.md](docs/DEPLOY-AI-BASSO.md)**
(deploy `server/` lên bot ai.basso.vn, chạy `start.js` trên máy có Chrome, thêm tài khoản Zalo,
test an toàn rồi go-live).

## Vận hành & bảo mật ⚙️

- **Yêu cầu Node ≥ 22.5**: server dùng `node:sqlite` (built-in, khỏi compile). Node cũ hơn sẽ
  lỗi ngay khi khởi động.
- **Giữ bền thư mục `data/` (QUAN TRỌNG)**: SQLite (`data/doraemi.sqlite`) chứa **Lịch sử báo**
  và **khóa chống gửi trùng** (bảng `auto_notified`). Container trên cloud là *ephemeral* — nếu
  `data/` không nằm trên **volume bền**, mỗi lần restart sẽ mất khóa chống trùng → bot có thể
  **nhắn lại trùng** cho khách. Hãy map `data/` vào ổ đĩa bền khi deploy.
- **Đăng nhập do gateway ai.basso.vn lo** (mỗi nhân viên 1 tài khoản, đứng trước app). App này
  **không tự xác thực** — chỉ chạy phía sau gateway. Hệ quả & cấu hình:
  - **Audit "ai gửi tin"**: app ghi cột `sent_by` vào Lịch sử báo. `bot` = luồng tự động; còn
    lại là danh tính nhân viên do gateway **forward qua header** (đặt `AUTH_USER_HEADER`, mặc
    định dò `x-user-email`, `x-forwarded-email`, ...). Không có header → để trống ("—").
  - **Siết CORS** (tùy chọn): đặt `CORS_ORIGIN=https://ai.basso.vn` để chỉ nhận request từ
    gateway. Để trống = mở mọi origin (chấp nhận được khi gateway là lối vào duy nhất).
- **Siết cho production (tuỳ chọn, không phá dev)** — bật bằng biến môi trường:
  - `REQUIRE_API_KEY=true` (tự bật khi `NODE_ENV=production`): bắt buộc có `API_KEY`, thiếu là
    **dừng hẳn** (fail-closed) thay vì chạy hớ. Cả server lẫn local-runner.
  - `GATEWAY_SECRET=...`: mọi `/api/*` (trừ `health`/`register-local`/`webhook`) phải kèm header
    `X-Gateway-Secret` khớp → chặn gọi thẳng app bỏ qua gateway + giả mạo danh tính. Cấu hình
    gateway gắn header này khi forward. Để trống = bỏ qua (như cũ).
  - `REGISTER_ALLOWED_HOSTS=*.trycloudflare.com,localhost`: chỉ cho `register-local` đăng ký URL
    thuộc host này (giảm SSRF). Để trống = cho tất cả. URL không phải `http/https` luôn bị từ chối.
  - Secret (`API_KEY`/`GATEWAY_SECRET`/webhook) được so khớp **constant-time** (chống dò timing).
- **Nhớ tắt `TEST_MODE`** (`.env`) khi chạy thật — bật thì chỉ gửi tới `TEST_PHONES`, mọi số
  khác bị chặn. TEST_MODE chỉ khớp khách theo **SĐT whitelist** (không khớp theo tên).

## Hướng nâng cấp tương lai (khi nào cần)

Pattern Xeko (runner tự đăng ký URL + heartbeat) là lựa chọn **đủ tốt cho quy mô hiện tại**:
1 shop, báo hàng không cần realtime, đã chạy thật ở Xeko. Giữ nguyên cho gọn. Các đánh đổi
đã biết và **cách nâng cấp** nếu sau này thấy phiền:

| Hạn chế hiện tại | Khi nào thành vấn đề | Hướng nâng cấp |
|---|---|---|
| URL runner lưu **trong RAM** cloud → có cửa sổ "mù" ~30s sau khi cloud restart | Khi cần gửi gần như tức thời, không chịu được trễ | Lưu URL vào store bền (file/SQLite/Redis) thay vì RAM |
| Nhánh **tự dò IP public** (`http://ip:port`) mong manh, không TLS, phải mở cổng | Khi không muốn duy trì tunnel | **WebSocket runner→cloud**: runner mở kết nối thường trực lên cloud, cloud đẩy lệnh ngược qua đó. Bỏ hẳn inbound/port, xuyên NAT sạch, không còn cửa sổ mù |
| Mô hình **push** (cloud gọi vào runner) phụ thuộc tunnel + bảo mật `API_KEY` | Khi muốn loại bỏ inbound hoàn toàn | **Job-pull**: runner tự kéo job từ cloud (polling/long-poll). Không cần inbound, đổi lại thêm độ trễ |
| Chỉ giữ **1 URL** (last-writer-wins) | Khi chạy nhiều runner song song | Đăng ký theo `runnerId`, server chọn runner theo profile/tải |
| `start.js` **không tự restart** runner | Máy online 24/7 | pm2/NSSM bọc ngoài (đã nêu trên) |

> 👉 Nâng cấp **đáng giá nhất** nếu thấy việc duy trì tunnel/port phiền: chuyển sang
> **WebSocket runner→cloud**. Khi đó khỏi cần `PLAYWRIGHT_PUBLIC_URL`, `/api/register-local`
> và cả tunnel — runner chủ động giữ 1 kết nối lên cloud là đủ.
