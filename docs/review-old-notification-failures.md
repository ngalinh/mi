# Rà các lượt gửi lỗi cũ

Trong Cài đặt → Log, chọn kết quả lỗi, nhân viên, loại tin và khoảng ngày cần kiểm tra. Bộ lọc chạy trên toàn bộ lịch sử trước khi giới hạn số dòng. Dùng “Tải các lượt cũ hơn” để đọc tiếp; bộ đếm hiển thị số đã tải / tổng số khớp. Có thể tìm bằng mã đơn, tên, số hiện tại, số người nhận ban đầu hoặc chuỗi lỗi.

Một lượt lỗi không chứng minh đơn vẫn chưa được báo. Tra tiếp cùng mã đơn ở tất cả kết quả để đối chiếu các lần thành công sau đó và hội thoại thực tế trước khi báo lại.

Các nhóm cần rà riêng sau khi sửa lỗi chuyển Zalo sang Facebook:

- Đã hết lượt thử: mặc định Hàng về VN dừng sau 1 lần lỗi, Quản lý giao hàng sau 2 lần; cấu hình thực tế có thể khác. Sửa code không xóa số lần lỗi. Báo lại từ màn hình đơn sau khi đối chiếu.
- Đơn có nội dung ship khi bật lại tự động có thể bị đánh dấu tồn cũ, kể cả từng gửi lỗi; không tự chạy lại.
- Tra khách từ mã đơn mặc định chỉ quét 45 ngày, tối đa 300 dòng; tự động Quản lý giao hàng mặc định quét 3 ngày. Không tìm ra không đồng nghĩa khách không tồn tại.
- Lỗi chưa rõ đã gửi hay chưa phải kiểm tra hội thoại. Không gửi lại hàng loạt chỉ vì lịch sử ghi lỗi.

PR này cải thiện việc tìm lịch sử, không reset lượt thử, thay đổi mốc tồn cũ hay kích hoạt gửi tin. Cần dữ liệu hệ thống đang chạy để kết luận khách/mã đơn nào thực sự còn sót.
