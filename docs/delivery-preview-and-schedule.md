# Cách gửi và lịch báo ship

Danh sách Hàng về VN thay ô chọn tài khoản bằng cột **Cách gửi**:
nhãn Zalo/FB, tên tài khoản thật và Cá nhân/Nhóm đối với Zalo. Bấm bút để
chọn tài khoản hoặc trở về Tự động. Lựa chọn được dùng cho gửi từng dòng và
báo loạt như trước. Các cột khác giữ nguyên.

API xem trước chỉ đọc, dùng chung accountResolver và ưu tiên kiểu báo trong
danh bạ như luồng gửi. Không đoán tài khoản theo nhãn kênh sale ở trình duyệt.
Lỗi tra cứu hiển thị “Chưa xác định”. Đây là tài khoản dự kiến ban đầu;
luồng gửi vẫn có thể dùng tài khoản dự phòng theo quy tắc hiện có.

## Báo ship

- Ahamove (shipping_id=3): giữ gửi ngay khi đạt điều kiện hiện có.
- ĐVVC khác: các lượt tự động chỉ gửi từ **17:30** theo múi giờ cấu hình
  (mặc định Việt Nam). Poller đầu tiên từ 17:30 xử lý đơn đủ điều kiện;
  các lượt sau bắt đơn mới/lỗi có thể thử lại đến hết ngày. Hôm sau chờ 17:30.
- Áp dụng cho báo ship từ Hàng về VN và Quản lý giao hàng, bao gồm webhook.
- Gửi tay vẫn chạy ngay. Delay, seed tồn cũ, chống trùng, giới hạn thử lại,
  nội dung/link/mã vận đơn và trạng thái giao shipper vẫn giữ nguyên.
- Lưới an toàn cho đơn chỉ mới soạn hàng vẫn tắt tự động như trước.
- API Hàng về VN không trả shipping_id: không suy đoán Ahamove từ nội dung;
  dòng thiếu mã ĐVVC chờ 17:30. Luồng Quản lý giao hàng có shipping_id nên
  nhận diện chính xác ngoại lệ Ahamove.
