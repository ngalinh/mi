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
    // Để 20s (thay vì 12s): Basso đôi lúc trả chậm 12–18s; nếu cắt ở 12s thì cả cacheWarmer
    // lẫn request của client đều fail -> cache RAM không bao giờ ấm -> client luôn rơi vào
    // đường "cold" rồi timeout. Cho thêm thời gian để call kịp xong & nạp được cache.
    requestTimeoutMs: Math.max(parseInt(process.env.BASSO_TIMEOUT_MS || '20000', 10) || 0, 0),
    // TTL (ms) cache danh sách hàng về trong RAM — auto-sync/đổi tab/gõ tìm kiếm lặp lại
    // không phải gọi lại Basso mỗi lần. 0 = tắt cache.
    // Mặc định 60s (nâng từ 30s): giảm nửa số lần làm mới nền -> nhẹ Basso hơn. AN TOÀN cho
    // báo ship vì webhook /api/webhook/ship đọc TƯƠI (bỏ cache) nên vẫn thấy ND mới tức thời.
    listCacheTtlMs: Math.max(parseInt(process.env.BASSO_LIST_CACHE_TTL_MS || '60000', 10) || 0, 0),
    // Cửa sổ ngày MẶC ĐỊNH cho dashboard (giảm cold-load: chỉ kéo N ngày gần đây thay vì
    // all-time). 0 = all-time. PHẢI KHỚP `scopeDays` mặc định ở public/js/dashboard.js (client
    // gửi kèm ?days=) để cacheWarmer warm ĐÚNG cache key -> mở dashboard ăn cache ấm. Cả hai = 7.
    defaultDays: Math.max(parseInt(process.env.BASSO_DEFAULT_DAYS || '7', 10) || 0, 0),
    // Chu kỳ (ms) NẠP SẴN khung nhìn mặc định của dashboard vào cache RAM (xem cacheWarmer.js)
    // -> người mở dashboard không phải đợi Basso. 0 = tắt; nếu >0 thì tối thiểu 15000ms.
    // Mặc định 120s (giãn từ 60s): warm nền thưa hơn -> nhẹ Basso. Cache TTL 60s nên trong
    // khoảng giữa 2 lượt warm, cache có thể stale -> SWR vẫn trả ngay rồi tự làm mới, không kẹt.
    preloadIntervalMs: (() => {
      const v = parseInt(process.env.BASSO_PRELOAD_INTERVAL_MS ?? '120000', 10);
      return Number.isFinite(v) && v > 0 ? Math.max(v, 15000) : 0;
    })(),
    // Ngưỡng số đơn để dashboard lọc client-side (kéo hết 1 lần rồi lọc NV/trạng thái/trang
    // ngay trên trình duyệt). Tập vượt ngưỡng -> /api/orders/all trả truncated=true để client
    // tự fallback về phân trang server (tránh kéo quá nặng). 0 = luôn cho phép client-side.
    // Để 6000 (thay vì 3000): giữ client-mode cho tập all-time lớn hơn -> đổi tab/trạng thái
    // lọc TỨC THÌ tại trình duyệt thay vì mỗi lần đổi tab là 1 round-trip Basso (chậm). Cold
    // load nặng hơn được bù bằng concurrency cao hơn (pageConcurrency) + gzip + cache ấm.
    clientMaxOrders: Math.max(parseInt(process.env.BASSO_CLIENT_MAX_ORDERS || '6000', 10) || 0, 0),
    // Số trang Basso kéo SONG SONG khi gom toàn bộ đơn 1 khoảng ngày (getAllOrders). Cao hơn =
    // cold load / auto-sync nhanh hơn, nhưng tải lên Basso NẶNG hơn (đỉnh request cùng lúc cao).
    // Mặc định 4 (hạ từ 8): giảm nửa đỉnh tải lên Basso -> nhẹ hệ thống. Cold-load 7 ngày ít trang
    // nên gần như không chậm thêm. Cần kéo nhanh hơn (tập lớn) thì nâng qua BASSO_PAGE_CONCURRENCY.
    pageConcurrency: Math.min(Math.max(parseInt(process.env.BASSO_PAGE_CONCURRENCY || '4', 10) || 4, 1), 16),
    // Bật để in thời gian từng call tới Basso (chẩn đoán chậm: do mạng hay do Basso).
    // BASSO_LOG_TIMING=true -> log "[basso] getArrivedVnList 2380ms". Mặc định tắt.
    logTiming: String(process.env.BASSO_LOG_TIMING || 'false').toLowerCase() === 'true',
    // LẤY ND BÁO HÀNG TƯƠI NGAY TRƯỚC KHI GỬI: khi build tin từ order.noiDungBaoHang (auto-notify
    // + Báo hàng loạt, KHÔNG có messageOverride), gọi getOrderContent (bỏ cache) lấy nội dung mới
    // nhất từ Basso. Chống tình huống "về thêm sản phẩm nhưng tin vẫn báo nội dung cũ (1 sp)" do
    // list cache 30s / dashboard cầm bản cũ. Tắt bằng BASSO_REFRESH_CONTENT_BEFORE_SEND=false nếu
    // muốn ưu tiên tốc độ báo loạt hơn (mỗi đơn tốn thêm 1 call Basso).
    refreshContentBeforeSend: String(process.env.BASSO_REFRESH_CONTENT_BEFORE_SEND || 'true').toLowerCase() === 'true',
  },
  // Tự động báo hàng: cứ có đơn "Chưa báo" (đã về kho) là tự gửi tin, không cần bấm tay.
  autoNotify: {
    enabled: String(process.env.AUTO_NOTIFY || 'false').toLowerCase() === 'true',
    // Công tắc RIÊNG cho tự động BÁO SHIP (độc lập báo hàng). AUTO_NOTIFY_SHIP ghi đè; không đặt
    // thì MẶC ĐỊNH theo AUTO_NOTIFY (giữ hành vi cũ: bật auto là chạy cả ship). Giá trị admin đổi
    // trên trang Cài đặt lưu DB (app_settings) sẽ ghi đè mặc định env này lúc khởi động.
    shipEnabled: (() => {
      const v = String(process.env.AUTO_NOTIFY_SHIP ?? '').toLowerCase();
      if (v === 'true') return true;
      if (v === 'false') return false;
      return String(process.env.AUTO_NOTIFY || 'false').toLowerCase() === 'true';
    })(),
    // Sau khi RESTART server: có TỰ ĐỘNG gửi bù đợt "Chưa báo" còn dở NGAY khi khởi động không?
    // Mặc định FALSE -> tạm dừng mọi lượt gửi tự động tới khi admin bấm "Quét & gửi" (hoặc bật lại
    // auto trên dashboard) -> kiểm soát thời điểm, tránh bot vừa dựng lại đã nhắn loạt ngoài ý muốn.
    // Đặt AUTO_NOTIFY_RESUME_ON_BOOT=true để tự chạy lại ngay khi khởi động như trước.
    resumeOnBoot: String(process.env.AUTO_NOTIFY_RESUME_ON_BOOT || 'false').toLowerCase() === 'true',
    // Chu kỳ quét BÁO HÀNG (ms). Giãn 60s -> 120s: mỗi lượt quét đơn "Chưa báo" -> ít dội Basso
    // hơn. Đơn về mới trễ báo tối đa ~2 phút (webhook /api/webhook/arrived vẫn báo ngay nếu Basso gọi).
    intervalMs: Math.max(parseInt(process.env.AUTO_NOTIFY_INTERVAL_MS || '120000', 10) || 120000, 10000),
    // Chu kỳ quét BÁO SHIP (ms) — RIÊNG với báo hàng. Basso CHỈ có API (không đẩy webhook ra) nên
    // tốc độ báo ship phụ thuộc HOÀN TOÀN vào chu kỳ quét này. Hạ 180s -> 60s để bắt kịp cả đơn
    // giao rất nhanh (vd AhaMove nội thành xong trong ~1h) — trước đây 3 phút/lượt dễ khiến đơn rời
    // khỏi vùng quét trước khi bắt được. Để mỗi lượt quét dày mà KHÔNG dội sập Basso, cửa sổ quét
    // được giới hạn theo N ngày gần đây (shipActiveDays) thay vì all-time. Tối thiểu 10s.
    shipIntervalMs: Math.max(parseInt(process.env.AUTO_NOTIFY_SHIP_INTERVAL_MS || '60000', 10) || 60000, 10000),
    // BÁO SHIP quét thêm đơn ĐÃ ở trạng thái "Đã báo ship" (notified_ship) để bắt ca "NV tick trạng
    // thái tay TRƯỚC, ND ship hiện SAU, Mi chưa từng gửi" -> vẫn báo cho khách. Vì tập notified_ship
    // TÍCH LŨY vô hạn, GIỚI HẠN theo N ngày gần đây (lọc theo ngày đơn về kho) để không kéo cả kho
    // lịch sử mỗi lượt quét. Mặc định 7 ngày. Đặt AUTO_NOTIFY_SHIP_RECENT_DAYS=0 để TẮT quét
    // notified_ship (chỉ quét not_sent/notified_arrival như trước).
    shipRecentDays: Math.max(parseInt(process.env.AUTO_NOTIFY_SHIP_RECENT_DAYS ?? '7', 10) || 0, 0),
    // Cửa sổ quét (N ngày gần đây, theo ngày đơn về kho) cho 'not_sent' + 'notified_arrival' TRONG
    // LƯỢT BÁO SHIP. Trước đây quét ALL-TIME 2 trạng thái này -> lượt NẶNG NHẤT dội Basso, không thể
    // quét dày. Giới hạn N ngày -> mỗi lượt nhẹ hơn nhiều nên hạ interval xuống 60s vẫn an toàn.
    // Đánh đổi: đơn về kho quá N ngày mà giờ mới có ND ship sẽ không được tự báo (hiếm — ND ship
    // thường phát sinh sát ngày về). Mặc định 14 ngày. Đặt AUTO_NOTIFY_SHIP_ACTIVE_DAYS=0 để quay
    // lại quét ALL-TIME như trước. CHỈ áp dụng lượt BÁO SHIP — lượt báo hàng vẫn quét như cũ.
    shipActiveDays: Math.max(parseInt(process.env.AUTO_NOTIFY_SHIP_ACTIVE_DAYS ?? '14', 10) || 0, 0),
    profile: process.env.AUTO_NOTIFY_PROFILE || 'default',
    account: process.env.AUTO_NOTIFY_ACCOUNT || undefined,
    // Bot gửi xong có đẩy trạng thái "Đã báo hàng" về web Basso không?
    // Mặc định true: đồng bộ trạng thái về Basso như luồng báo tay. Đặt
    // AUTO_NOTIFY_UPDATE_WEB=false nếu muốn bot chỉ đánh dấu trong mi.
    updateWeb: String(process.env.AUTO_NOTIFY_UPDATE_WEB || 'true').toLowerCase() === 'true',
    // Số lần THỬ tối đa cho 1 đơn nếu gặp LỖI CẤP-ĐƠN (runner còn sống nhưng gửi lỗi, vd
    // KHONG_THAY_HOI_THOAI — không tìm thấy hội thoại). Mặc định 1 = KHÔNG thử lại: gửi hụt là chốt
    // 'failed', để người trực tự kiểm tra & gửi tay (thử lại thường vô ích — hội thoại không tự hiện
    // ra, brand/khách sai không tự đúng). Muốn thử lại N lần thì đặt AUTO_NOTIFY_MAX_RETRIES=N.
    // LƯU Ý: lỗi TẠM THỜI (runner offline / chưa đăng nhập Zalo) KHÔNG tính vào đây — luồng bỏ cả
    // lượt và thử lại nguyên vẹn khi runner online / đã đăng nhập (vì tin CHƯA hề tới khách).
    maxRetries: Math.max(parseInt(process.env.AUTO_NOTIFY_MAX_RETRIES || '1', 10) || 1, 1),
    // Bí mật bảo vệ webhook /api/webhook/arrived (so khớp header x-webhook-secret). Trống = không kiểm tra.
    webhookSecret: process.env.AUTO_NOTIFY_WEBHOOK_SECRET || '',
    // CHỈ tự báo đơn về TỪ ngày account được bật "Tự động báo" trở đi (bỏ qua đơn tồn đọng
    // về TRƯỚC đó) -> tránh nhắn trùng loạt khách cũ khi bật lại auto cho 1 nhân viên. Mốc
    // lưu ở account.autoEnabledAt (runner). Đặt AUTO_NOTIFY_ONLY_NEW=false để bot gửi cả
    // tồn đọng như trước. Chỉ áp dụng cho account Hướng B (khớp NV); account cũ chưa có mốc
    // (autoEnabledAt trống) giữ nguyên hành vi cũ tới lần bật/tắt kế tiếp.
    onlyNewOrders: String(process.env.AUTO_NOTIFY_ONLY_NEW ?? 'true').toLowerCase() !== 'false',
    // CHỈ tự gửi đơn khớp đúng 1 tài khoản Zalo ĐANG BẬT auto (source='store'). Đơn không khớp
    // account nào (rơi về 'default'/legacy) hoặc account tắt auto -> BỎ QUA. Dùng để cô lập test
    // về 1 nhân viên: bật auto cho 1 account là chỉ NV đó được gửi, còn lại tự động bỏ. Mặc định
    // false (giữ hành vi cũ: đơn không khớp vẫn gửi bằng account mặc định).
    requireAccount: String(process.env.AUTO_NOTIFY_REQUIRE_ACCOUNT || 'false').toLowerCase() === 'true',
    // GIỜ GỬI CỐ ĐỊNH (HH:MM, 24h) theo múi giờ `timezone` bên dưới. Khi có giá trị hợp lệ:
    // bot KHÔNG gửi ngay khi hàng về nữa — cả ngày gom lại, tới đúng giờ này mới quét & gửi 1
    // lượt cho mọi đơn "Chưa báo". Webhook /api/webhook/arrived chỉ để cập nhật, không gửi.
    // Để TRỐNG = quay lại hành vi cũ (gửi ngay theo poller mỗi intervalMs). Giá trị lưu trong
    // DB (app_settings) khi admin đổi trên trang Cài đặt sẽ GHI ĐÈ mặc định env này lúc khởi động.
    scheduleTime: process.env.AUTO_NOTIFY_SCHEDULE_TIME || '17:00',
    // Múi giờ dùng để hiểu scheduleTime (IANA tz). Mặc định giờ Việt Nam. Server có thể chạy UTC
    // nên cần quy đổi để "17:00" là 17h theo giờ VN, không phải theo giờ máy chủ.
    timezone: process.env.AUTO_NOTIFY_TZ || 'Asia/Ho_Chi_Minh',
    // Chu kỳ (ms) KIỂM TRA đồng hồ ở chế độ hẹn giờ — chỉ so sánh giờ (rẻ), tới giờ mới gọi
    // Basso để gửi. 60s là đủ mịn để bắt đúng phút hẹn.
    scheduleCheckMs: Math.max(parseInt(process.env.AUTO_NOTIFY_SCHEDULE_CHECK_MS || '60000', 10) || 60000, 15000),
    // NHẮC SOẠN ND trước giờ gửi bao nhiêu PHÚT: trước giờ hẹn `precheckMinutes` phút, bot tự
    // quét (đọc tươi từ Basso) và cảnh báo số đơn "Chưa báo" còn THIẾU nội dung báo hàng — để
    // người phụ trách kịp soạn nốt trên Basso trước khi gửi. 0 = tắt nhắc. Mặc định 30 phút.
    // Admin đổi trên trang Cài đặt sẽ GHI ĐÈ (lưu DB) và áp dụng ngay.
    precheckMinutes: parseInt(process.env.AUTO_NOTIFY_PRECHECK_MINUTES || '30', 10),
    // NHẮC RA ZALO (nội bộ): tới giờ nhắc (16:30) và sau khi gửi (17:00), tự nhắn 1 tin Zalo cho
    // người trực để biết mà KHÔNG cần mở mi. Gửi bằng 1 account Zalo đã đăng nhập trên runner.
    // Tất cả chỉnh được trên trang Cài đặt (lưu DB, ghi đè env). enabled mặc định tắt.
    alert: {
      enabled: String(process.env.AUTO_NOTIFY_ALERT || 'false').toLowerCase() === 'true',
      account: process.env.AUTO_NOTIFY_ALERT_ACCOUNT || '', // tên account Zalo gửi (vd "Bụt Ai")
      phone: process.env.AUTO_NOTIFY_ALERT_PHONE || '',     // SĐT nhận (của người trực)
      name: process.env.AUTO_NOTIFY_ALERT_NAME || 'Admin',  // tên hiển thị người nhận
    },
  },
  // Báo hàng loạt (áp dụng cho CẢ báo tay lẫn bot tự động): nghỉ một khoảng NGẪU NHIÊN giữa 2
  // khách LIÊN TIẾP để tránh gửi dồn quá nhanh -> giảm rủi ro chạm ngưỡng chống spam của Zalo/FB.
  // Delay chỉ chèn GIỮA các đơn (không nghỉ trước đơn đầu / sau đơn cuối / khi dừng cả loạt).
  // Mỗi lần nghỉ = số ngẫu nhiên trong [minMs, maxMs]. Đặt cả 2 = 0 để TẮT (gửi liền như trước).
  notify: {
    delayBetweenMinMs: Math.max(parseInt(process.env.SEND_DELAY_BETWEEN_MIN_MS ?? '5000', 10) || 0, 0),
    delayBetweenMaxMs: Math.max(parseInt(process.env.SEND_DELAY_BETWEEN_MAX_MS ?? '10000', 10) || 0, 0),
    // Khoảng "ân hạn" (ms) TRƯỚC khi thật sự gửi 1 đơn báo TAY — trong lúc này bấm Dừng sẽ HỦY sạch
    // (tin chưa đi). Chỉ áp cho gửi tay (route /api/notify), KHÔNG áp cho báo loạt/tự động. 0 = tắt.
    manualGraceMs: Math.max(parseInt(process.env.SEND_MANUAL_GRACE_MS ?? '3000', 10) || 0, 0),
  },
  dbPath: process.env.DB_PATH
    || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'doraemi.sqlite'),
};
