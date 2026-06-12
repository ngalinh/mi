# Doraemi Bot — Tự động báo hàng về VN qua Zalo (Salework)

Chatbot tự động thông báo "hàng đã về kho VN" cho khách, gồm 3 phần như yêu cầu:

1. **Dashboard** hiển thị danh sách hàng về (lấy từ API website — hiện dùng dữ liệu MOCK, ráp API thật sau).
2. **Trang lịch sử báo** — log mọi lượt nhắn tin (thành công/thất bại, nội dung, thời gian).
3. **Automation Playwright** trên tài khoản **Salework Zalo** (`https://zalo.salework.net`), port theo pattern của [Xeko](https://github.com/ngalinh/Xeko).

## Kiến trúc (giống Xeko)

```
┌────────────────────────┐       HTTP (tunnel/localhost)      ┌──────────────────────────┐
│  server/  (ai.basso.vn) │  ──── POST /api/zalo/send ───────▶ │ local-runner/ (máy có Chrome)│
│  • Dashboard + Reports  │  ◀─── poll /api/job/:id  ───────── │ • Playwright persistent ctx │
│  • bassoApi (đọc orders)│                                    │ • Điều khiển zalo.salework  │
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
Lần đầu hãy mở `https://zalo.salework.net` trong cửa sổ browser do bot bật lên và **đăng nhập thủ công 1 lần**. Session được lưu vào `playwright-data/salework-default/` nên các lần sau không phải login lại.

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

> Điều kiện gửi 1 đơn: trạng thái `not_sent` **và** khách có Zalo (`hasZalo !== false`).

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

**Bot gửi xong KHÔNG đụng vào web Basso** (mặc định `AUTO_NOTIFY_UPDATE_WEB=false`): chỉ
đánh dấu trong mi qua bảng `auto_notified`, và dashboard hiển thị badge **🤖 Bot đã gửi**
(kèm giờ gửi) ở cột trạng thái để phân biệt rõ với báo tay. Đơn vẫn giữ nhãn web gốc nên
vẫn xem được ở mi cho tới khi xử lý xong. Muốn bot cũng cập nhật web thì đặt
`AUTO_NOTIFY_UPDATE_WEB=true` (khi đó dùng theo `AUTO_UPDATE_STATUS`).

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
  noiDungBaoHang, noiDungBaoShip, statusCode, status, note, staff, userId, hasZalo }
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
| GET | `/api/health` | Trạng thái server + local-runner + auto-notify |

Local-runner: `POST /api/zalo/send`, `GET /api/job/:id`, `GET /health` (bảo vệ bằng header `x-api-key`).
