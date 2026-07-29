# Plan: Báo ship dựa trên "Quản lý giao hàng"

Xây dựng nội dung báo ship (báo khách khi giao shipper) từ **Quản lý giao hàng**
(`shipping_order`, Partner API) thay vì dựa vào `content_ship` của **Hàng về VN**.

## Mục tiêu
- Nội dung do **mi** dựng theo mẫu riêng, đúng ĐVVC + mã vận đơn + COD + link theo dõi.
- Sau khi gửi → đồng bộ trạng thái **`notified_ship`** về Hàng về VN (dashboard đúng + chống gửi trùng).

## Trigger (theo từng loại ĐVVC)
- **AhaMove/Grab (nhóm link):** gửi khi **có `shipper_link`** — bất kể status (có link = đã đặt shipper).
- **Viettel/GHTK (nhóm tracking):** gửi khi **bấm "Giao shipper"** (status → `exported`) — không dựa vào mã vận đơn (mã có thể tạo trước lúc bàn giao).
- Dedup theo id vận đơn (`ship_seen`) → dù kiểm nhiều lần vẫn gửi đúng 1 lần.

## Template theo ĐVVC (`shipping_id`)
| Nhóm | ĐVVC | Nội dung |
|---|---|---|
| Link | AhaMove (3), Grab (7) | tên + "bàn giao cho {ĐVVC}" + 📦 `shipper_link` + "để ý điện thoại" |
| GHTK | Giao hàng tiết kiệm (2) | + 📦 mã vận đơn + 💰 COD + 🔎 `https://i.ghtk.vn/{code}` + "dự kiến 2–5 ngày" |
| Tracking | Viettel Post (4) & ĐVVC có mã | + 📦 mã vận đơn + 💰 COD + "dự kiến 2–5 ngày" |
| Nhận tại VP (8) | — | **Chưa gửi** (khách tự tới lấy) — trừ khi có mẫu riêng |

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
- **Pha 2** — Tự động: poller quét đơn mới `exported` trong N ngày (dedup `ship_seen`) + toggle riêng ở Cài đặt + webhook. Có thể gửi ngay khi bấm "Giao shipper" trong mi.
- **Pha 3** — Cho sửa template ở Cài đặt.

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
