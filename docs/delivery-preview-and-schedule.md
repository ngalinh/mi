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

- Mọi ĐVVC: tự động gửi ngay khi đủ điều kiện ở lượt quét/webhook tiếp theo,
  không chờ mốc giờ trong ngày.
- AhaMove/Grab cần link theo dõi; Viettel/GHTK cần giao shipper theo điều kiện hiện có.
- Áp dụng cho báo ship từ Hàng về VN và Quản lý giao hàng, bao gồm webhook.
- Gửi tay vẫn chạy ngay. Delay, seed tồn cũ, chống trùng, giới hạn thử lại,
  nội dung/link/mã vận đơn và trạng thái giao shipper vẫn giữ nguyên.
- Lưới an toàn cho đơn chỉ mới soạn hàng vẫn tắt tự động như trước.
- API Hàng về VN không trả shipping_id: vẫn gửi khi đủ điều kiện của luồng này,
  không cần suy đoán ĐVVC từ nội dung để kiểm tra giờ gửi.
