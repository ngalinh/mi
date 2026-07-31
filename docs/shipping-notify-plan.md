# Plan: Báo ship dựa trên "Quản lý giao hàng"

Xây dựng nội dung báo ship (báo khách khi giao shipper) từ **Quản lý giao hàng**
(`shipping_order`, Partner API) thay vì dựa vào `content_ship` của **Hàng về VN**.

**Trạng thái:** Pha 0 (xem/copy) + Pha 1 (gửi tay đơn lẻ/hàng loạt qua Zalo, đồng bộ
`notified_ship`) đã xong — xem `server/shippingSendService.js`. Pha 2 (tự động — poller +
lưới an toàn 17:00) đã code xong — xem `server/shippingAutoNotify.js` — **mặc định TẮT**,
admin bật tay ở trang Cài đặt ("Tự động báo ship — Quản lý giao hàng (mới)"), công tắc
ĐỘC LẬP với "Tự động báo ship" cũ (`autoNotify.shipEnabled`, dựa vào `content_ship`).
Pha 3 (sửa mẫu tin) đã code xong — trang Cài đặt → tab "Mẫu báo ship": admin sửa được
**nội dung** mẫu theo từng ĐVVC (biến `{name}/{carrier}/{code}/{cod}/{link}/{trackUrl}`),
xem trước bằng dữ liệu mẫu, khôi phục mặc định. Registry ĐVVC (loại link/tracking, có
gửi hay không, whitelist) vẫn CỐ ĐỊNH trong `server/shippingNotify.js` — chưa cho thêm/xoá
ĐVVC qua UI (xem "Còn lại" bên dưới).

## Mục tiêu
- Nội dung do **mi** dựng theo mẫu riêng, đúng ĐVVC + mã vận đơn + COD + link theo dõi.
- Sau khi gửi → đồng bộ trạng thái **`notified_ship`** về Hàng về VN (dashboard đúng + chống gửi trùng).

## Trigger (theo từng loại ĐVVC)
- **AhaMove/Grab (nhóm link):** gửi khi **có `shipper_link`** — bất kể status (có link = đã đặt shipper).
- **Viettel/GHTK (nhóm tracking):** gửi khi **bấm "Giao shipper"** (status → `exported`) — không dựa vào mã vận đơn (mã có thể tạo trước lúc bàn giao).
- Dedup theo id vận đơn (`ship_seen`) → dù kiểm nhiều lần vẫn gửi đúng 1 lần.

## Lưới an toàn 17:00 (NV quên bấm "Giao shipper")
NV có thể soạn xong hàng nhưng quên bấm Giao shipper → Viettel/GHTK không được báo. Tới **17:00**
hằng ngày (tái dùng cơ chế `AUTO_NOTIFY_SCHEDULE_TIME` sẵn có), quét đơn **"Đã soạn hàng"**
(`is_prepared=1`, chưa `exported`, soạn **trong ngày**) chưa báo ship → coi như đã giao trong ngày → gửi.
- **Viettel/GHTK:** có mã vận đơn → gửi bình thường.
- **AhaMove/Grab:** chưa có `shipper_link` → **không gửi**, chỉ **cảnh báo NV** (chưa đặt shipper).
- **CHỈ gửi tin + đánh dấu `notified_ship`** — **KHÔNG** đổi status vận đơn sang `exported`
  (đổi status sẽ làm NV quản lý kho tưởng đã bàn giao → rối luồng kho). Giữ nguyên "Đã soạn hàng"
  để kho tự bấm "Giao shipper" khi thực sự giao.
- Chỉ quét đơn soạn trong ngày; dedup theo `ship_seen`.

## Template theo ĐVVC (`shipping_id`)
| Nhóm | ĐVVC | Nội dung |
|---|---|---|
| Link | AhaMove (3), Grab (7) | tên + "bàn giao cho {ĐVVC}" + 📦 `shipper_link` + "để ý điện thoại" |
| GHTK | Giao hàng tiết kiệm (2) | + 📦 mã vận đơn + 💰 COD + 🔎 `https://i.ghtk.vn/{code}` + "dự kiến 2–5 ngày" |
| Tracking | Viettel Post (4) & ĐVVC có mã | + 📦 mã vận đơn + 💰 COD + "dự kiến 2–5 ngày" |
| Nhận tại VP (8) | — | **Chưa gửi** (khách tự tới lấy) — trừ khi có mẫu riêng |

### ĐVVC chưa có mẫu riêng → KHÔNG gửi (Hướng B — an toàn)
Meta có ~18 ĐVVC. **Chỉ ĐVVC được khai trong registry mới gửi tin** (whitelist).

Registry (shipping_id → mẫu):
| ĐVVC | id | Mẫu |
|---|---|---|
| GHTK | 2 | Tracking + link `i.ghtk.vn/{code}` |
| AhaMove | 3 | Link |
| Viettel Post | 4 | Tracking |
| Grab | 7 | Link |
| Nhận hàng tại VP | 8 | none (không gửi) |

- ĐVVC **không có** trong registry → **KHÔNG gửi tin**, chỉ **cảnh báo NV** (tên ĐVVC + số đơn liên quan)
  để bổ sung mẫu. Không gửi mẫu chung tự động.
- Thêm ĐVVC mới = thêm 1 dòng registry (dễ mở rộng; sau này đưa lên trang Cài đặt ở Pha 3).

## Gửi Zalo
- Tái dùng hạ tầng sẵn có: `notifyService` + runner; resolve SĐT→Zalo (`getZaloMap`/`normPhone`).
- Tài khoản Zalo gửi: theo **NV phụ trách đơn** (approve_user) như flow báo hàng hiện tại.

## Đồng bộ trạng thái về Hàng về VN (khớp chính xác)
Sau khi gửi ship cho 1 vận đơn:
1. Lấy **mã vận đơn** (`code`) + list **`order_code`** trong vận đơn.
2. `getArrivedVnList?key=<sđt>&status=notified_arrival` → dòng "Đã báo hàng" của khách.
3. Soi items (`getArrivedVnItems`): dòng có item **`shipCode == code`** (chính) hoặc `orderCode` khớp (dự phòng).
4. `updateArrivedVnStatus` các dòng khớp → **`notified_ship`**. Dòng khác giữ nguyên.

> 1 khách có nhiều dòng "Đã báo hàng" → **chỉ** đánh dấu dòng thật sự nằm trong vận đơn vừa ship.
> Nhờ đó batch chưa ship vẫn được báo, và flow `content_ship` cũ tự bỏ qua batch đã `notified_ship`
> (chống gửi trùng, không cần tắt flow cũ thủ công).

## Chống gửi trùng
- Bảng `ship_seen` (đã có) khóa theo **id vận đơn** (`order_shippings.id`) → không gửi lại 1 vận đơn.
- Cộng với việc mark `notified_ship` ở trên → flow cũ không đụng lại.

## Các pha (rủi ro tăng dần)
- **Pha 0** — Sinh nội dung, KHÔNG gửi. Nút 💬 "Xem tin" trên đơn đã giao shipper → hiện nội dung + Copy. *(rủi ro ~0)*
- **Pha 1** — Gửi tay: nút "Báo giao hàng" đơn lẻ + "Báo loạt" (tick nhiều) → gửi Zalo + đồng bộ `notified_ship`.
- **Pha 2** — Tự động: poller quét đơn mới `exported`/có `shipper_link` trong N ngày (dedup
  `shipping_notified` + seed `shipping_auto_seen`) + toggle riêng ở Cài đặt (mặc định TẮT) +
  lưới an toàn 17:00. **Đã code xong** — chưa có webhook riêng (Pha 2 dùng poller interval,
  chưa đấu `/api/webhook/*` cho luồng này).
- **Pha 3** — Cho sửa NỘI DUNG template ở Cài đặt (đã xong). Chưa làm: cho quản lý cả
  registry (thêm/xoá ĐVVC, đổi loại link/tracking) qua UI — vẫn phải sửa code
  `shippingNotify.js` khi có ĐVVC mới.

## Quyết định (mặc định đề xuất)
| # | Vấn đề | Chọn |
|---|---|---|
| 1 | Chế độ gửi | **Tay trước (Pha 0→1)**, auto sau |
| 2 | Flow `content_ship` cũ | **Giữ nguyên** — tự bỏ qua nhờ `notified_ship` |
| 3 | Tài khoản Zalo | Theo **NV phụ trách** (approve_user) |
| 4 | Nhận tại VP | **Không gửi** (trừ khi có mẫu) |
| 5 | Template | **Hardcode** ở Pha 1, sửa được ở Pha 3 |
| 6 | Điều kiện gửi | AhaMove/Grab = có `shipper_link` (bất kể status); Viettel/GHTK = khi bấm "Giao shipper" (`exported`) |
| 7 | Khớp trạng thái | **`shipCode`** chính, `order_code` dự phòng; đánh dấu **mọi dòng khớp** |
| 8 | Lưới 17:00 | **Chỉ gửi tin + mark `notified_ship`**, KHÔNG đổi status vận đơn (tránh ảnh hưởng NV kho) |
| 9 | ĐVVC chưa khai mẫu | **Hướng B** — KHÔNG gửi, chỉ cảnh báo NV (whitelist registry) |
