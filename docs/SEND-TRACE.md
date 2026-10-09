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
- `zalo.confirm.result`: mã tin Zalo và mã tin CRM do API trả về cho đúng
  hội thoại, nội dung khớp hoàn toàn. HTTP 2xx hoặc ô soạn trống chưa đủ.
- `facebook.confirm.result`: tin mới có nội dung khớp hoàn toàn trong
  khung hội thoại và nhãn Đã gửi/Đã nhận/Đã xem. Thiếu nhãn chuyển Cần kiểm tra.
- `runner.done` / `runner.error` / `proxy.job-status`: kết quả handler và job.
- `notify.web-update.*` / `notify.report-final`: lý do web và lịch sử được chốt.

Chỉ ghi thành công khi runner trả bằng chứng xác nhận. Job done thiếu bằng chứng
được chuyển sang needs_check, giữ khóa chặn gửi lại qua khởi động lại.
Vào lịch sử báo, mở đúng hội thoại rồi chọn Đã kiểm tra: đã gửi/chưa gửi để xử lý.
Messenger gửi lại nội dung giống hệt tin cũ có thể cần xác nhận thủ công nếu
giao diện không cung cấp mã tin ổn định để phân biệt với lịch sử render lại.
Khi triển khai, cập nhật cả server và local-runner: runner cũ không có bằng chứng
xác nhận sẽ bị server mới chuyển sang Cần kiểm tra. Bản sửa chưa gửi tin thật
trên tài khoản người dùng; cần đối chiếu API/nhãn trạng thái khi chạy thực tế.
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
lỗi ghi log không ngăn luồng gửi.
