'use strict';
const path = require('path');
// Nạp .env theo thứ tự ưu tiên (dotenv KHÔNG ghi đè biến đã có sẵn trong process.env):
//   1) process.env do nền tảng (ai.basso.vn) tiêm thẳng — ưu tiên cao nhất.
//   2) server/.env  — nơi panel/wizard ghi (cùng thư mục với file này).
//   3) .env ở gốc repo — tương thích chạy local / local-runner.
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bassoBase = process.env.BASSO_API_BASE_URL || '';
const useMockEnv = (process.env.USE_MOCK || '').toLowerCase();
const useMock = useMockEnv === 'true' ? true : useMockEnv === 'false' ? false : !bassoBase;

// Ánh xạ NHÂN VIÊN -> tên tài khoản Zalo (đúng tên hiện trong dropdown Salework). Khai báo
// JSON trong ZALO_ACCOUNT_MAP; key = user_id NV (ưu tiên) HOẶC tên nhân viên, value = tên
// account Zalo. Để mỗi đơn tự gửi bằng Zalo của nhân viên phụ trách. Sai JSON -> bỏ qua (map rỗng).
function parseZaloAccountMap(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const obj = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v != null && String(v).trim()) out[String(k).trim().toLowerCase()] = String(v).trim();
    }
    return out;
  } catch (e) {
    console.warn('[config] ZALO_ACCOUNT_MAP không phải JSON hợp lệ -> bỏ qua:', e.message);
    return {};
  }
}
const zaloAccountMap = parseZaloAccountMap(process.env.ZALO_ACCOUNT_MAP);

/** Tên account Zalo cho 1 đơn theo nhân viên phụ trách (userId ưu tiên, rồi tới tên). '' nếu không có. */
function zaloAccountForOrder(order) {
  if (!order) return '';
  const byId = order.userId != null ? zaloAccountMap[String(order.userId).trim().toLowerCase()] : '';
  if (byId) return byId;
  return (order.staff && zaloAccountMap[String(order.staff).trim().toLowerCase()]) || '';
}

module.exports = {
  zaloAccountMap,
  zaloAccountForOrder,
  // Ưu tiên PORT (nền tảng host như ai.basso.vn thường cấp port động qua biến này),
  // sau đó tới SERVER_PORT (cấu hình thủ công), cuối cùng mặc định 8080 cho chạy local.
  port: parseInt(process.env.PORT || process.env.SERVER_PORT || '8080', 10),
  apiKey: process.env.API_KEY || '',
  // Bắt buộc có API_KEY (fail-closed) khi chạy production hoặc REQUIRE_API_KEY=true. Dev (mặc
  // định) vẫn chạy được khi để trống key.
  requireApiKey: String(process.env.REQUIRE_API_KEY || '').toLowerCase() === 'true'
    || process.env.NODE_ENV === 'production',
  // Secret dùng chung gateway↔app: nếu đặt, mọi route /api/* (trừ health/register-local/webhook)
  // phải kèm header X-Gateway-Secret khớp -> chặn gọi thẳng app bỏ qua gateway. Trống = bỏ qua.
  gatewaySecret: process.env.GATEWAY_SECRET || '',
  // Allowlist host được phép đăng ký qua /api/register-local (vd "*.trycloudflare.com,localhost").
  // Trống = cho tất cả (như cũ). Hỗ trợ wildcard "*.domain".
  registerAllowedHosts: (process.env.REGISTER_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  playwrightLocalUrl: process.env.PLAYWRIGHT_LOCAL_URL || 'http://localhost:8090',
  // Đăng nhập do gateway ai.basso.vn lo (đứng trước app). Gateway forward danh tính nhân
  // viên qua header để app GHI LẠI "ai gửi tin" vào lịch sử. Danh sách header thử lần lượt,
  // lấy giá trị đầu tiên có. Đổi qua AUTH_USER_HEADER (phân tách bằng dấu phẩy).
  auth: {
    userHeaders: (process.env.AUTH_USER_HEADER ||
      'x-user-email,x-forwarded-email,x-forwarded-user,x-auth-request-email,x-authenticated-user')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },
  // Siết CORS: liệt kê origin được phép (phân tách bằng dấu phẩy) trong CORS_ORIGIN.
  // Để trống = mở cho mọi origin (mặc định cũ — phù hợp khi gateway là lối vào duy nhất).
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  basso: {
    baseUrl: bassoBase.replace(/\/$/, ''),
    partnerApiKey: process.env.BASSO_API_KEY || '',
    email: process.env.BASSO_EMAIL || '',
    pass: process.env.BASSO_PASS || '',
    useMock,
    autoUpdateStatus: String(process.env.AUTO_UPDATE_STATUS || 'true').toLowerCase() === 'true',
    // Timeout (ms) cho mỗi request tới API Basso — tránh treo "Đang tải..." vô thời hạn
    // khi upstream chậm/không phản hồi. 0 = tắt timeout.
    requestTimeoutMs: Math.max(parseInt(process.env.BASSO_TIMEOUT_MS || '12000', 10) || 0, 0),
    // TTL (ms) cache danh sách hàng về trong RAM — auto-sync/đổi tab/gõ tìm kiếm lặp lại
    // không phải gọi lại Basso mỗi lần. 0 = tắt cache.
    listCacheTtlMs: Math.max(parseInt(process.env.BASSO_LIST_CACHE_TTL_MS || '30000', 10) || 0, 0),
    // Ngưỡng số đơn để dashboard lọc client-side (kéo hết 1 lần rồi lọc NV/trạng thái/trang
    // ngay trên trình duyệt). Tập vượt ngưỡng -> /api/orders/all trả truncated=true để client
    // tự fallback về phân trang server (tránh kéo quá nặng). 0 = luôn cho phép client-side.
    clientMaxOrders: Math.max(parseInt(process.env.BASSO_CLIENT_MAX_ORDERS || '3000', 10) || 0, 0),
    // Bật để in thời gian từng call tới Basso (chẩn đoán chậm: do mạng hay do Basso).
    // BASSO_LOG_TIMING=true -> log "[basso] getArrivedVnList 2380ms". Mặc định tắt.
    logTiming: String(process.env.BASSO_LOG_TIMING || 'false').toLowerCase() === 'true',
  },
  // Tự động báo hàng: cứ có đơn "Chưa báo" (đã về kho) là tự gửi tin, không cần bấm tay.
  autoNotify: {
    enabled: String(process.env.AUTO_NOTIFY || 'false').toLowerCase() === 'true',
    intervalMs: Math.max(parseInt(process.env.AUTO_NOTIFY_INTERVAL_MS || '120000', 10) || 120000, 10000),
    profile: process.env.AUTO_NOTIFY_PROFILE || 'default',
    account: process.env.AUTO_NOTIFY_ACCOUNT || undefined,
    // Bot gửi xong có đẩy trạng thái "Đã báo hàng" về web Basso không?
    // Mặc định true: đồng bộ trạng thái về Basso như luồng báo tay. Đặt
    // AUTO_NOTIFY_UPDATE_WEB=false nếu muốn bot chỉ đánh dấu trong mi.
    updateWeb: String(process.env.AUTO_NOTIFY_UPDATE_WEB || 'true').toLowerCase() === 'true',
    // Số lần thử lại tối đa cho 1 đơn nếu gửi lỗi (tránh spam khi local-runner offline)
    maxRetries: Math.max(parseInt(process.env.AUTO_NOTIFY_MAX_RETRIES || '3', 10) || 3, 1),
    // Bí mật bảo vệ webhook /api/webhook/arrived (so khớp header x-webhook-secret). Trống = không kiểm tra.
    webhookSecret: process.env.AUTO_NOTIFY_WEBHOOK_SECRET || '',
  },
  dbPath: process.env.DB_PATH
    || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'doraemi.sqlite'),
};
