# Quản lý giao hàng — tích hợp Partner API (Basso)

Trang **Giao hàng** (`giaohang.html`) dùng nhóm Partner API **`shipping_order`** (mục 8.10 tài
liệu Partner API của Basso) — **dùng chung** xác thực với phần "Hàng về VN":
`X-Partner-Api-Key` + `Authorization: Bearer` (tự login/refresh token qua
`bassoApi.partnerApiFetch`). **Không cần cookie/mật khẩu riêng.**

> Lịch sử: ban đầu phần này được reverse-engineer từ endpoint web nội bộ
> `basso.vn/basso/shipping_order/` (auth cookie `ci_session`). Sau đó Basso mở chính thức qua
> Partner API nên mi đã chuyển sang gọi Partner API (sạch, dùng chung key, không lo cookie hết hạn).

## Cấu hình

Không cần biến riêng — dùng chung `.env` của Partner API:
`BASSO_API_BASE_URL`, `BASSO_API_KEY`, `BASSO_EMAIL`, `BASSO_PASS`. Chưa cấu hình → trang chạy
**mock** (`server/mock/shipping.json`) để xem giao diện offline.

Test (chỉ đọc): `node scripts/test-shipping.js` (hoặc `npm run test:shipping`).

## Endpoint dùng (Partner API)

| Endpoint | Method | Dùng cho | Hàm `shippingApi.js` |
|---|---|---|---|
| `/partner/getShippingOrderMeta` | GET | Dropdown ĐVVC/trạng thái/chi nhánh/NV | `getShippingMeta` |
| `/partner/getShippingOrderList` | GET | Danh sách + lọc; `?id=` chi tiết | `getShippingOrders` / `getShippingOrder` |
| `/partner/getShippingInvoice` | GET | Dữ liệu phiếu giao hàng | `getShippingInvoice` |
| `/partner/updateShippingOrder` | POST | Sửa ĐVVC/mã/phí/COD | `updateShippingOrder` |
| `/partner/markShippingPrepared` | POST | Đã soạn hàng | `markPrepared` |
| `/partner/markShippingExported` | POST | Giao shipper (AhaMove/Grab cần `shipper_link`) | `giveToShipper` |
| `/partner/markShippingExportedBulk` | POST | Giao shipper nhiều | `markExportedBulk` |
| `/partner/markShippingShipped` | POST | Đã giao hàng (1 hoặc nhiều) | `markCompleted` / `markShippedBulk` |
| `/partner/revertShippingPrepared` | POST | Chưa giao hàng (admin/inventory_manager) | `revertPrepared` |

### Lọc danh sách (`getShippingOrderList`)
`page`, `shipping_id` (0=tất cả), `status` (`all`/`waiting`/`waiting_prepared`/`carrier_submitted`/
`exported`/`completed`), `key`, `branch` (`ha-noi`/`ho-chi-minh`), `user_approve` (id NV),
`filter_date` + `filter_date_end` (**YYYY-MM-DD**). Trả `data.items[]` + `data.total/page/page_size`
+ `data.has_inventory_manager_role`.

### Trạng thái vận đơn
`waiting` (Chờ giao) → *đã soạn* (`waiting` + `is_prepared=1`) → `exported` (Giao shipper) →
`completed` (Đã giao). Ngoài ra `carrier_submitted` (Lên đơn vận). Response thao tác trả
`status` (+ `waiting_prepared_at`) — nguồn sự thật để cập nhật UI.

## Kiến trúc trong mi

- **Backend** (`server/index.js`): `GET /api/shipping/meta`, `GET /api/shipping`,
  `GET /api/shipping/invoice`, `POST /api/shipping/update`, `POST /api/shipping/action`
  (`kind` = prepared|ship|complete|revert), `POST /api/shipping/bulk` (`kind` = ship|complete).
- **Adapter** (`server/shippingApi.js`): gọi Partner API qua `bassoApi.partnerApiFetch`, chuẩn
  hoá field sang shape hiển thị; mock khi chưa cấu hình.
- **Frontend** (`giaohang.html` + `js/giaohang.js`): nạp meta đổ dropdown, lọc, tabs chi nhánh,
  xem chi tiết SP, nút thao tác từng đơn + hàng loạt, in phiếu.

## Ghi chú
- Sửa vận đơn bị chặn khi đã lên GHTK (`shipping_id=2`)/Viettel Post (`shipping_id=4`) thành công
  (`is_carrier_submitted`); list trả `can_edit` để ẩn nút sửa.
- AhaMove (`shipping_id=3`) / Grab (`shipping_id=7`) bắt buộc `shipper_link` khi giao shipper —
  frontend tự hỏi link (dựa `shipper_link_shipping_ids` từ meta).
