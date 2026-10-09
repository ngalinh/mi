# Tra lỗi gửi tin báo hàng

Trong log hệ thống trên dashboard, chọn cả server và runner, mức tất cả, tìm
`send-trace`. Tìm dòng `notify.report-final` theo `reportId` trong lịch sử báo,
sau đó copy `traceId` để lọc toàn bộ lượt gửi. `jobId` nối với job trên runner.
Một lượt thử tài khoản dự phòng có cùng traceId nhưng jobId khác nhau.

Các bước cần đối chiếu:

- `notify.prepared` / `notify.fresh-content`: report, khóa đơn, tài khoản và dấu
  vân tay nội dung trước khi gửi.
- `proxy.accepted` / `runner.queued` / `runner.started`: runner đã nhận lệnh hay
  còn chờ hàng đợi.
- `zalo.send.clicked` / `facebook.send.enter-pressed`: thao tác gửi đã chạy.
- `zalo.confirm.result`: số lần xuất hiện trước/sau, phạm vi toàn trang,
  độ dài nội dung còn trong ô soạn, kết quả xác nhận.
- `facebook.confirm.result`: ô soạn còn nội dung không; `deliveryVerified:false`
  cho biết đây chỉ là kiểm tra ô soạn trống, chưa xác minh giao tin.
- `runner.done` / `runner.error` / `proxy.job-status`: kết quả handler và job.
- `notify.web-update.*` / `notify.report-final`: lý do web và lịch sử được chốt.

Log này bổ sung chẩn đoán, chưa thay đổi điều kiện xác nhận gửi hiện tại.
Nếu runner báo done nhưng khách không nhận, đối chiếu bước confirm và ảnh
trong thư mục screenshots trên máy runner, cùng thời điểm thao tác gửi.

Log hệ thống trên dashboard ở RAM, có thể mất khi khởi động lại. Bản sao lưu
trên mỗi máy nằm trong `data/send-trace-<PID>.log`, có timestamp UTC. Khi file
đạt 5 MiB sẽ chuyển thành `.log.1` và tạo file mới (giữ một bản trước).
Có thể đặt `SEND_TRACE_FILE` thành đường dẫn tuyệt đối riêng cho server/runner
để cố định tên file qua các lần khởi động; mỗi tiến trình phải có file riêng.
Tra các file cũ theo traceId hoặc reportId khi bộ đệm dashboard đã hết dữ liệu.
File sẽ đầy theo giới hạn trên; không lưu vô hạn.

Không ghi nội dung tin nhắn, cookie hoặc mật khẩu: chỉ ghi độ dài và hash
SHA-256 rút gọn của tin. Log có mã đơn/tài khoản và thông báo lỗi, chỉ chia sẻ
cho người phụ trách xử lý. Nếu ghi file thất bại, có cảnh báo trong console;
việc gửi vẫn giữ hành vi hiện tại.
