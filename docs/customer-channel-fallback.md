# Tra khách đặt hàng khi không tìm thấy Zalo

Áp dụng cho báo hàng và báo ship ở Hàng về VN, cùng báo ship ở Quản lý giao hàng (gửi tay, hàng loạt và tự động dùng chung service).

Khi các tài khoản Zalo phù hợp trả `KHONG_THAY_HOI_THOAI`, hệ thống tra lại các mã đơn để xác định khách đặt hàng. Các mã phải tra được và cùng một khách; dòng sản phẩm không có mã được bỏ qua, nhưng nếu toàn bộ không có mã thì báo lỗi.

- Khách có link Facebook trong Danh bạ: chọn tài khoản Facebook theo nhân viên phụ trách và gửi qua link của khách, kể cả số khách trùng số người nhận hoặc trước đó đã chọn Zalo tay.
- Khách không có link Facebook: thử Zalo bằng số khách đặt hàng nếu số này khác số đã tìm.
- Thiếu tài khoản Facebook, lỗi tra cứu hoặc nhiều khách khác nhau: ghi lỗi vào lịch sử, không đánh dấu đã báo.
- Lỗi đăng nhập, mạng hoặc kết quả gửi chưa rõ không kích hoạt chuyển người nhận/kênh.

Lịch sử lưu khách tra được, số ban đầu và kênh/tài khoản thực tế. Nội dung vận đơn được giữ nguyên; Hàng về VN lấy nội dung mới theo đúng khóa khách/ngày nhập kho trước khi gửi. Nếu khách tra từ mã không khớp khóa khách của nội dung, dừng để kiểm tra đơn.

Kiểm thử dùng dữ liệu giả lập, không gửi tin nhắn thật:

```sh
node --test scripts/test-account-queue.js scripts/test-notification-fallback.js
```
