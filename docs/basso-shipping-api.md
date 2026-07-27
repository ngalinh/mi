# API "Quản lý giao hàng" (Basso web admin)

Tài liệu này ghi lại API phía sau trang **Quản lý giao hàng** trên `basso.vn`, dùng cho
module `server/shippingApi.js` + trang `giaohang.html`.

> ⚠️ **KHÁC Partner API** ("Hàng về VN" trong `bassoApi.js`). Đây là endpoint AJAX **nội bộ
> của web admin**, xác thực bằng **cookie phiên** (`ci_session`) chứ không phải
> `X-Partner-Api-Key` + Bearer. Basso chưa mở phần giao hàng qua Partner API, nên ta gọi thẳng
> endpoint web bằng cookie đăng nhập của một tài khoản admin.

## Xác thực

- **Base URL:** `https://basso.vn/basso` (`BASSO_WEB_BASE_URL`)
- **Cookie bắt buộc:** `ci_session=...` (kèm `identity`, `remember_code` nếu có) — đặt trong
  `BASSO_WEB_COOKIE`. Lấy từ trình duyệt đã đăng nhập: DevTools → Network → request bất kỳ →
  **Request Headers → cookie**.
- **Header bắt buộc:** `X-Requested-With: XMLHttpRequest` (không có -> server trả HTML trang web
  thay vì JSON).
- Cookie **hết hạn theo phiên** → khi API trả về HTML/redirect login thì cập nhật lại
  `BASSO_WEB_COOKIE`.

## 1. Đọc danh sách đơn giao hàng

```
GET /shipping_order/?page=1&shipping_id=0&status=all&user_approve=0&key=<tìm>&filter_date=DD-MM-YYYY
```

| Query | Ý nghĩa |
|---|---|
| `page` | Trang (20 đơn/trang) |
| `shipping_id` | Lọc theo ĐVVC (`0` = tất cả). Vd 4=Viettel Post, 3=AhaMove, 7=Grab, 8=Nhận tại VP |
| `status` | `all` \| `waiting` \| `exported` \| `completed` |
| `user_approve` | Lọc theo NV duyệt (`0` = tất cả) — là **user id** |
| `key` | Tìm theo mã đơn / khách / sđt / tên NV |
| `filter_date` | Lọc theo ngày tạo, định dạng **DD-MM-YYYY** |

**Response:** `{ error:false, data:[...], pagination:{limit,total_item,current_page,total_page}, has_inventory_manager_role }`

Mỗi phần tử `data[]` (các field chính, map sang cột trên web):

| Field | Cột web | Field | Cột web |
|---|---|---|---|
| `created_time` (unix) | Ngày tạo vận đơn | `cod_amount` | Thu COD |
| `name` | Người nhận | `fee` | Phí ship |
| `code` / `carrier_tracking_id` | Mã vận đơn | `shipping` (+`shipping_id`) | Đơn vị vận chuyển |
| `phone` | Điện thoại | `status` | Trạng thái |
| `address` | Địa chỉ | `is_prepared` (`1`/`0`) | đã soạn hàng? |
| `note` | Ghi chú | `waiting_prepared_at` (unix) | Thời gian soạn hàng |
| `id` | **khoá để gọi thao tác** | `items[]` | SP trong đơn (con mắt 👁) |

`items[]`: `order_code` (Mã ĐH), `name` (Tên SP), `quantity` (SL), `variations[{name,value}]`
(Size/Màu), `approve_user` (NV duyệt), `image_path` (ảnh).

> Con mắt 👁 "xem chi tiết" **không gọi API riêng** — dữ liệu SP đã nằm sẵn trong `items[]` của
> danh sách.

## 2. Thao tác đổi trạng thái 1 đơn

```
POST /shipping_order/       Content-Type: application/x-www-form-urlencoded
body:  action=<...>&id=<id đơn>          (kèm shipper_link=<url> tuỳ chọn cho "Giao shipper")
```

**Response:** `{ error:false, message:"Cập nhật thành công", status:"<mới>", waiting_prepared_at? }`

| Nút trên web | `action` gửi đi | `status` nhận về |
|---|---|---|
| **Đã soạn hàng** | `exported` | `waiting` (+ `waiting_prepared_at`) |
| **Giao shipper** | *(xem ghi chú)* | `exported` |
| **Đã giao hàng** | *(xem ghi chú)* | `completed` |
| **Chưa giao hàng** (hoàn tác) | `waiting` | `waiting` |

> **Lưu ý quan trọng:** chữ `action` gửi đi **KHÔNG** trùng `status` trả về — luôn đọc `status`
> trong response để biết trạng thái mới. Vòng đời hiển thị: `waiting` → `exported` → `completed`.
>
> Các giá trị `action` đã bắt được từ request thật: `exported`, `waiting`, `shipped`. Ánh xạ
> chính xác từng nút → `action` được gom trong `ACTIONS` ở đầu `server/shippingApi.js`; nếu 1
> nút gọi sai chỉ cần sửa 1 dòng ở đó (kiểm chứng lại bằng DevTools → Payload).

## 3. Chưa bắt được (bổ sung sau nếu cần)

- **In phiếu giao hàng** — chưa rõ endpoint (có thể mở PDF qua GET).
- **Nút hàng loạt** (tick nhiều đơn) — chưa rõ có gửi nhiều `id` một lần không; hiện `giaohang.js`
  lặp gọi từng đơn.

## 4. Partner API — ĐÃ ĐỐI CHIẾU TÀI LIỆU: chưa có endpoint giao hàng

Đã rà toàn bộ tài liệu Partner API chính thức (mục "Tóm tắt endpoint"): **KHÔNG có** endpoint
nào cho `shipping_order` / vận đơn / giao hàng. Xác minh thêm bằng `npm run probe:shipping`
(16 tên đoán đều 404). Hai endpoint gần nhất nhưng **khác mô hình dữ liệu**:

- `getArrivedVnList` = "Hàng về VN" (hàng về kho VN, gom theo customer_id+ngày) — không có vận đơn/ĐVVC/COD.
- `getOrdersWithCancelledItems?item_status=shipped` = đơn có *dòng SP* đã giao — không phải *vận đơn*.

→ Muốn dùng Partner API cho Giao hàng, **Basso phải mở thêm** nhóm endpoint (bọc màn
`basso/shipping_order/` giống cách đã bọc `arrived_vn` / `item_issue` / `sms_log`). Spec đề xuất
(đúng chuẩn tài liệu — auth `X-Partner-Api-Key` + Bearer, envelope `{success,message,data,errors}`):

| Endpoint | Method | Tham số / Body | Trả về |
|---|---|---|---|
| `/partner/getShippingOrderList` | GET | `page, page_size, status, shipping_id, from, to, key, branch, include_items` | `data.rows[]` (field như màn shipping_order) + `data.total/page/page_size` |
| `/partner/updateShippingOrderStatus` | POST | `id`, `action` (`exported\|waiting\|shipped`) | `data.record{status, waiting_prepared_at}` |

Khi Basso mở xong: đổi `server/shippingApi.js` từ gọi `basso.vn/basso/shipping_order/` (cookie)
sang `/partner/getShippingOrderList` (Partner API key + Bearer, tái dùng luồng login của
`bassoApi.js`) — giao diện `giaohang.html`/`js/giaohang.js` giữ nguyên.

## Dùng trong mi

- Backend: `GET /api/shipping`, `POST /api/shipping/action` (`server/index.js`) → `shippingApi.js`.
- Frontend: trang **Giao hàng** (`giaohang.html` + `js/giaohang.js`).
- Cấu hình: `BASSO_WEB_BASE_URL`, `BASSO_WEB_COOKIE` (xem `.env.example`). Chưa có cookie → chạy
  **mock** từ `server/mock/shipping.json` để xem giao diện offline.
- Test đọc (chỉ đọc, an toàn): `node scripts/test-shipping.js`.
