'use strict';
const config = require('./config');
const { getOrders, updateOrderStatus, getArrivedItems, getOrderContent } = require('./bassoApi');
const { sendBaoHang, sendBaoHangFb } = require('./playwrightProxy');
const { buildBaoHangMessage, buildBaoShipMessage } = require('../shared/messageTemplate');
const { addReport, updateReport, getAutoRecord, recordAutoNotified, autoKey, autoKeyShip, getFbLink, getZaloName, getContactReportTarget } = require('./db');
const { withLock } = require('./lock');
const { resolveForOrder } = require('./accountResolver');

// Marker lỗi "chưa đăng nhập Zalo" do runner (salework.ensureLoggedIn) ném ra khi mở trình duyệt
// mà thấy trang login. Dùng để DỪNG NGAY báo loạt thay vì để mọi đơn còn lại failed như nhau.
const LOGIN_REQUIRED_RE = /CHUA_DANG_NHAP/i;
const isLoginRequiredError = (msg) => LOGIN_REQUIRED_RE.test(msg || '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Dừng báo loạt giữa chừng (do người dùng bấm nút "Dừng") ----
// `bulkRunning` = có 1 phiên notifyOrders đang chạy hay không (chỉ 1 vì đi qua withLock).
// `stopRequested` = người dùng đã yêu cầu dừng loạt đang chạy; vòng lặp kiểm tra cờ này ở ranh giới
// giữa các đơn để DỪNG ngay — các đơn còn lại bỏ dở (KHÔNG đánh dấu đã báo, báo lại sau được).
let bulkRunning = false;
let stopRequested = false;

/** Có phiên báo loạt đang chạy không (để route/quyết định phản hồi). */
function isBulkRunning() { return bulkRunning; }

/**
 * Yêu cầu DỪNG loạt đang chạy. Chỉ có tác dụng khi đang chạy; đặt cờ để vòng lặp tự thoát ở đơn
 * kế tiếp (đơn đang gửi dở vẫn chạy xong). Trả true nếu có loạt để dừng, false nếu không có gì đang chạy.
 */
function requestStopBulk() {
  if (!bulkRunning) return false;
  stopRequested = true;
  return true;
}

/**
 * Khoảng nghỉ NGẪU NHIÊN (ms) chèn GIỮA 2 khách liên tiếp khi báo loạt — tránh gửi dồn quá nhanh
 * (giảm rủi ro chống spam Zalo/FB). Đọc [minMs, maxMs] từ config.notify. Trả 0 (tắt) khi max<=0.
 * min>max thì hoán đổi để luôn hợp lệ.
 */
function betweenSendDelayMs() {
  let min = config.notify?.delayBetweenMinMs || 0;
  let max = config.notify?.delayBetweenMaxMs || 0;
  if (max <= 0) return 0;
  if (min > max) [min, max] = [max, min];
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Nghỉ giữa 2 khách theo cấu hình (no-op nếu delay = 0). Chia nhỏ giấc ngủ để THOÁT SỚM khi người
 * dùng bấm Dừng — nếu không, dừng có thể phải chờ tới hết 1 nhịp nghỉ (mặc định 5–10s) mới ăn.
 * `stopRequested` chỉ bật khi có báo loạt tay đang chạy (requestStopBulk), nên nhánh này không ảnh
 * hưởng luồng auto (dùng chung hàm này nhưng không đặt cờ dừng).
 */
async function delayBetweenCustomers() {
  const ms = betweenSendDelayMs();
  if (ms <= 0) return;
  const STEP_MS = 250;
  for (let waited = 0; waited < ms; waited += STEP_MS) {
    if (stopRequested) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(STEP_MS, ms - waited));
  }
}

/**
 * Báo hàng/ship cho 1 đơn: build tin nhắn -> gửi qua local-runner -> (tùy chọn) cập nhật
 * trạng thái về web -> ghi report.
 * @param {object} order - đơn đã chuẩn hóa
 * @param {object} [opts] { profile, account, messageOverride, kind, skipWebUpdate } kind = 'hang' | 'ship'
 */
/**
 * Mã đơn để HIỂN THỊ trên report = "Mã ĐH" (orderCode, vd BS26052646), KHÔNG phải id nội bộ (vd 546).
 * orderCode nằm trên từng sản phẩm nên: ưu tiên client gửi sẵn, không có thì tra qua getArrivedItems
 * (mọi luồng đều truyền đủ id/customerId/dateInventory nên luôn tra được), gộp các mã khác nhau
 * (1 dòng có thể nhiều SP). Không tra được (đơn không có SP, hoặc API rỗng/lỗi) -> trả null để UI
 * hiển thị "—". KHÔNG fallback về id nội bộ nữa để tránh nhầm id (546) với mã ĐH (BS...).
 * @param {object} order
 * @returns {Promise<string|null>}
 */
async function resolveOrderMeta(order) {
  let orderCode = order.orderCode && String(order.orderCode).trim() ? String(order.orderCode).trim() : null;
  let images = [];
  try {
    const { items } = await getArrivedItems({
      id: order.id,
      customerId: order.customerId,
      dateInventory: order.dateInventory,
    });
    const list = items || [];
    if (!orderCode) {
      const codes = [...new Set(list.map((it) => it.orderCode).filter(Boolean))];
      if (codes.length) orderCode = codes.join(', ');
      else console.warn(`[notify] đơn id=${order.id} không có mã ĐH (không có SP đã về) -> report để trống`);
    }
    // Ảnh SP để hiển thị thumbnail trên Lịch sử báo (giữ tối đa 20, UI cắt còn 4 + "+N").
    images = [...new Set(list.map((it) => it.image).filter(Boolean))].slice(0, 20);
  } catch (err) {
    console.warn(`[notify] không tra được SP cho đơn id=${order.id}: ${err.message}`);
  }
  return { orderCode, images };
}

async function notifyOne(order, opts = {}) {
  const kind = opts.kind === 'ship' ? 'ship' : 'hang';
  const newStatus = kind === 'ship' ? 'notified_ship' : 'notified_arrival';

  // LẤY ND TƯƠI NGAY TRƯỚC KHI GỬI (chỉ khi KHÔNG có messageOverride — tức luồng auto-notify &
  // Báo hàng loạt dùng thẳng ND từ Basso). order.noiDungBaoHang có thể là bản CŨ (list cache 30s
  // / dashboard cầm bản cũ) -> khách về thêm sản phẩm nhưng tin vẫn báo nội dung cũ (vd 1 sp).
  // getOrderContent bỏ cache, khớp đúng đơn theo (customerId + dateInventory) nên lấy được nội
  // dung mới nhất Basso đã soạn lại. Lỗi/không thấy -> giữ nguyên ND đang có, KHÔNG chặn gửi.
  const noOverride = !(opts.messageOverride && opts.messageOverride.trim());
  if (noOverride && config.basso.refreshContentBeforeSend
      && order.customerId != null && order.dateInventory != null) {
    try {
      const fresh = await getOrderContent({
        customerId: order.customerId,
        dateInventory: order.dateInventory,
        phone: order.phone,
      });
      if (fresh && fresh.found) {
        const key = kind === 'ship' ? 'noiDungBaoShip' : 'noiDungBaoHang';
        const next = kind === 'ship' ? fresh.noiDungBaoShip : fresh.noiDungBaoHang;
        const prev = order[key];
        if (next && String(next).trim() && String(next).trim() !== String(prev || '').trim()) {
          console.log(`[notify] ND ${kind} của ${order.customerName || order.phone || order.customerId} đã ĐỔI trên Basso -> dùng bản mới nhất (bản cũ có thể thiếu sản phẩm vừa về).`);
          order = { ...order, [key]: next };
        }
      }
    } catch (err) {
      console.warn(`[notify] không lấy được ND tươi cho đơn ${order.customerId}/${order.dateInventory}: ${err.message} — dùng ND đang có.`);
    }
  }

  const message = opts.messageOverride && opts.messageOverride.trim()
    ? opts.messageOverride.trim()
    : (kind === 'ship' ? buildBaoShipMessage(order) : buildBaoHangMessage(order));

  // Tìm khách: dùng SĐT (whitelist + tìm) và tên (khớp hội thoại).
  // DANH BẠ ZALO: nếu SĐT khách có tên Zalo/FB đã lưu (import/nhập tay), dùng tên đó để KHỚP
  // hội thoại thay cho tên Basso (hay lệch tên hiển thị trên Zalo). SĐT vẫn là khoá chính;
  // tên Zalo chỉ là fallback (khách không SĐT / SĐT không ra hội thoại). Khách Facebook không
  // có SĐT thì lấy luôn tên Zalo làm từ khoá tìm.
  const zaloName = getZaloName(order.phone);
  const matchName = zaloName || order.customerName;
  const keyword = order.phone || zaloName || order.customerName;
  if (zaloName) {
    console.log(`[notify] danh bạ Zalo: ${order.phone || '-'} -> tên hội thoại "${zaloName}" (thay tên Basso "${order.customerName || '-'}")`);
  }

  // MÔ HÌNH B: mỗi tài khoản Zalo 1 profile riêng. Resolver quyết định profile + saleworkName
  // theo NV phụ trách đơn (accountsStore trên runner), fallback ZALO_ACCOUNT_MAP / mặc định.
  const resolved = await resolveForOrder(order, opts);
  // NGOẠI LỆ THEO KHÁCH: nếu khách này có "Kiểu báo riêng" trong danh bạ ('personal'/'group'), nó
  // GHI ĐÈ kiểu báo của NV phụ trách (vd NV báo cá nhân nhưng riêng khách này báo vào group Zalo).
  // Chỉ áp cho kênh Zalo — kênh Facebook không có tab cá nhân/nhóm.
  if (resolved.channel !== 'facebook') {
    const override = getContactReportTarget(order.phone);
    if (override) resolved.notifyTarget = override;
  }
  // LOG CHẨN ĐOÁN: server đã chọn account nào + kiểu báo gì cho đơn này. notifyTarget=group cho NV
  // đáng lẽ cá nhân -> đơn KHÔNG khớp account store (source!='store'), hoặc server chạy code cũ.
  console.log(`[notify] ${order.customerName || order.phone || '?'} | staff=${order.staff || '-'} userId=${order.userId || '-'} -> channel=${resolved.channel || 'zalo'} account=${resolved.account || '-'} source=${resolved.source} notifyTarget=${resolved.notifyTarget || 'group'}`);

  // Tra mã ĐH + ảnh SP TRƯỚC khi gửi để dòng "đang báo" đã đủ thông tin hiển thị (chỉ tra 1 lần,
  // dùng lại cho cả lúc cập nhật kết quả cuối).
  const meta = await resolveOrderMeta(order);

  // Bỏ qua có lý do rõ ràng -> ghi 1 dòng "failed" vào Lịch sử báo để người soát xử lý.
  //   - brand        : NV chưa có Zalo cho brand của đơn (tránh gửi nhầm brand).
  //   - fb_no_account: đơn thuộc diện báo qua Facebook nhưng NV chưa cấu hình tài khoản Facebook.
  if (resolved.skip && (resolved.skipReason === 'brand' || resolved.skipReason === 'fb_no_account')) {
    const err = resolved.skipReason === 'fb_no_account'
      ? `Đơn cần báo qua Facebook nhưng NV ${order.staff || '—'} chưa có tài khoản Facebook. Vào Cài đặt → Tài khoản để thêm.`
      : `Chưa có tài khoản Zalo cho brand "${resolved.orderBrand || '?'}" của NV ${order.staff || '—'}`;
    const report = addReport({
      orderId: meta.orderCode,
      customerName: order.customerName,
      phone: order.phone,
      staff: order.staff,
      message,
      status: 'failed',
      error: err,
      images: meta.images,
      sentBy: opts.actor || null,
      customerId: order.customerId,
      dateInventory: order.dateInventory,
      userId: order.userId,
      kind,
      channel: resolved.channel,
      zaloAccount: null,
    });
    return { order, ok: false, error: err, report };
  }

  // Ghi 1 dòng "đang báo" (pending) NGAY trước khi gửi. Nhờ vậy cả báo tự động lẫn báo tay đều
  // thấy ngay đã nhận lệnh gửi cho khách nào, kể cả khi job kéo dài (sendBaoHang poll tới 10 phút)
  // hay đang xếp hàng trong báo loạt. Sau khi gửi xong sẽ UPDATE chính dòng này thành success/failed.
  const pending = addReport({
    orderId: meta.orderCode,
    customerName: order.customerName,
    phone: order.phone,
    staff: order.staff,
    message,
    status: 'pending',
    images: meta.images,
    sentBy: opts.actor || null,
    kind,
    // Khóa đơn + NV phụ trách -> để "Thử lại" tái tạo đơn & resolve đúng account.
    customerId: order.customerId,
    dateInventory: order.dateInventory,
    userId: order.userId,
    channel: resolved.channel,
    // Tài khoản Zalo dùng để gửi (để đối chiếu trên Lịch sử báo): ưu tiên tên dropdown,
    // không có thì tới profile/key, cuối cùng 'default'.
    zaloAccount: resolved.account || resolved.profile || null,
  });

  let result;
  try {
    if (resolved.channel === 'facebook') {
      // Kênh Facebook: mở THẲNG hội thoại theo LINK FB đã lưu cho khách (không search Messenger).
      const fbLink = getFbLink(order.phone);
      if (!fbLink) {
        result = { ok: false, error: `Chưa có link Facebook cho khách ${order.phone || '—'} — vào trang Danh bạ, mở khách này và thêm link (đang bật "Báo qua Facebook").` };
      } else {
        result = await sendBaoHangFb({
          profile: resolved.profile || 'default',
          fbLink,
          keyword,
          name: matchName,
          message,
          strictMatch: opts.strictMatch === true,
        });
      }
    } else {
      result = await sendBaoHang({
        profile: resolved.profile || 'default',
        account: resolved.account,
        keyword,
        name: matchName,
        message,
        strictMatch: opts.strictMatch === true, // luồng bot: chỉ gửi khi khớp chắc chắn
        notifyTarget: resolved.notifyTarget,     // 'group' | 'personal' -> runner tìm hội thoại đúng kiểu
        keepContext: opts.keepContext === true,  // báo loạt gom theo profile -> giữ browser cho đơn kế cùng account
      });
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  // Gửi thành công -> cập nhật trạng thái 'Đã báo hàng' ngược về web (nếu bật).
  // skipWebUpdate=true (luồng bot tự động): CHỈ lưu trạng thái trong mi, KHÔNG đẩy về web Basso.
  let updateError = null;
  if (result.ok && !opts.skipWebUpdate && config.basso.autoUpdateStatus && order.customerId != null) {
    try {
      await updateOrderStatus({
        customerId: order.customerId,
        dateInventory: order.dateInventory,
        status: newStatus,
        note: order.note || undefined,
      });
    } catch (err) {
      updateError = err.message;
    }
  }

  // Chốt kết quả vào CHÍNH dòng "đang báo" đã ghi ở trên (không tạo dòng mới).
  //  - Gửi lỗi                     -> 'failed'
  //  - Gửi OK + cập nhật web OK     -> 'success'
  //  - Gửi OK nhưng cập nhật web LỖI -> 'sent_check' = ĐÃ GỬI cho khách nhưng trạng thái web chưa
  //    đổi (vd Basso timeout) -> cần KIỂM TRA/sửa tay. KHÔNG để 'success' (giấu lỗi) cũng KHÔNG để
  //    'failed' (sai — khách đã nhận tin, gửi lại sẽ trùng).
  const report = updateReport(pending.id, {
    status: result.ok ? (updateError ? 'sent_check' : 'success') : 'failed',
    error: result.ok ? (updateError ? `Đã gửi nhưng update web lỗi: ${updateError}` : null) : result.error,
    jobId: result.jobId,
  });

  // loginRequired: Zalo hiện trang login (chưa đăng nhập). Caller (notifyOrders) dùng cờ này để
  // DỪNG cả loạt ngay — các đơn còn lại chắc chắn cũng fail vì cùng chưa đăng nhập.
  const loginRequired = !result.ok && isLoginRequiredError(result.error);
  return { order, ...result, updateError, report, loginRequired };
}

/**
 * Gom đơn theo PROFILE (tài khoản Zalo) để báo loạt chạy LIÊN TIẾP cùng 1 profile thay vì xen kẽ
 * NV -> đỡ mở/đóng trình duyệt lặp lại (rõ nhất khi CLOSE_AFTER_SEND=false: profile được tái dùng
 * giữa các đơn liền kề). Thứ tự profile theo lần XUẤT HIỆN ĐẦU TIÊN; giữ nguyên thứ tự đơn trong
 * cùng profile (sort ổn định) -> không xáo trộn. Client đã chọn account cụ thể (opts.account) hoặc
 * ít hơn 2 đơn -> trả nguyên. Có resolve trước để lấy profile (getArrivedItems/getAccountsCached đều
 * có cache nên lần notifyOne resolve lại gần như không tốn thêm).
 */
async function groupOrdersByProfile(orders, opts = {}) {
  const list = Array.isArray(orders) ? orders : [];
  if (opts.account || list.length < 2) return list.map((order) => ({ order, profileKey: null }));
  const tagged = [];
  for (let i = 0; i < list.length; i += 1) {
    let key = 'default';
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await resolveForOrder(list[i], { defaultAccount: opts.defaultAccount, profile: opts.profile });
      key = r.profile || 'default';
    } catch { /* lỗi resolve -> gom vào 'default' */ }
    tagged.push({ order: list[i], key, i });
  }
  const rank = new Map();
  for (const t of tagged) if (!rank.has(t.key)) rank.set(t.key, rank.size);
  return tagged
    .sort((a, b) => (rank.get(a.key) - rank.get(b.key)) || (a.i - b.i))
    .map((t) => ({ order: t.order, profileKey: t.key }));
}

/**
 * Báo hàng cho danh sách ĐƠN (object đầy đủ field do client gửi lên — đã có sẵn trên
 * dashboard). Không phải tra lại theo id nên không lệ thuộc phân trang/bộ lọc.
 * Bọc trong withLock để KHÔNG chạy chồng với luồng tự động (R6) -> tránh gửi trùng.
 * @param {object[]} orders - mỗi phần tử cần tối thiểu: customerId, dateInventory, customerName, phone
 * @param {object} [opts]
 */
async function notifyOrders(orders, opts = {}) {
  return withLock(async () => {
    // Đánh dấu "đang chạy" để nút Dừng có tác dụng; reset cờ dừng của phiên trước cho chắc.
    bulkRunning = true;
    stopRequested = false;
    try {
      // Gom theo profile trước -> gửi tuần tự HẾT đơn của 1 tài khoản rồi mới sang tài khoản kế.
      const ordered = await groupOrdersByProfile(orders, opts);
      const results = [];
      let aborted = false;
      let stopped = false;
      let abortError = null;
      for (let idx = 0; idx < ordered.length; idx += 1) {
        // Người dùng bấm Dừng -> thoát TRƯỚC khi gửi đơn kế (đơn đang gửi dở đã xong ở vòng trước).
        if (stopRequested) { stopped = true; break; }
        const { order, profileKey } = ordered[idx];
        // Giữ context nếu đơn KẾ TIẾP cùng profile (đã gom) -> tái dùng browser, đỡ mở/đóng lặp lại.
        const keepContext = profileKey != null && idx + 1 < ordered.length
          && ordered[idx + 1].profileKey === profileKey;
        // eslint-disable-next-line no-await-in-loop
        const r = await notifyOne(order, { ...opts, keepContext });
        // Báo tay thành công -> ghi dấu 'manual' để BOT không gửi lại (kể cả khi không cập nhật
        // web). Không đè lên 'success' của bot để giữ đúng badge. Khóa theo LOẠI tin (báo ship dùng
        // autoKeyShip) để báo ship tay chỉ chặn bot báo ship, không đụng báo hàng.
        if (r.ok) {
          const dkey = opts.kind === 'ship' ? autoKeyShip(order) : autoKey(order);
          const ex = getAutoRecord(dkey);
          if (!ex || ex.status !== 'success') recordAutoNotified(dkey, 'manual', ex ? ex.attempts : 0);
        }
        results.push({
          orderId: order.id,
          customerName: order.customerName,
          ok: r.ok,
          error: r.error || r.updateError || null,
          jobId: r.jobId || null,
        });
        // Zalo hiện trang login (chưa đăng nhập) -> DỪNG NGAY cả loạt: các đơn còn lại chắc chắn
        // cũng fail vì cùng chưa đăng nhập. Không gửi tiếp để tránh loạt đơn failed vô ích; trả cờ
        // aborted để UI hiện cảnh báo đăng nhập thay vì "Hoàn tất".
        if (r.loginRequired) {
          aborted = true;
          abortError = r.error || 'Zalo chưa đăng nhập.';
          break;
        }
        // Nghỉ NGẪU NHIÊN trước khi sang khách kế (chỉ GIỮA các đơn — bỏ qua sau đơn cuối) để tránh
        // gửi dồn quá nhanh -> giảm rủi ro chống spam Zalo/FB. Tắt bằng SEND_DELAY_BETWEEN_MAX_MS=0.
        if (idx + 1 < ordered.length) {
          // eslint-disable-next-line no-await-in-loop
          await delayBetweenCustomers();
        }
      }
      const sent = results.filter((r) => r.ok).length;
      // Số đơn CÒN LẠI chưa gửi khi dừng giữa chừng (login hoặc người dùng bấm Dừng) — để UI báo rõ
      // đã bỏ dở bao nhiêu.
      const skipped = (aborted || stopped) ? ordered.length - results.length : 0;
      return {
        total: results.length,
        sent,
        failed: results.length - sent,
        results,
        aborted,
        stopped,
        abortReason: aborted ? 'CHUA_DANG_NHAP' : (stopped ? 'STOPPED_BY_USER' : null),
        abortError,
        skipped,
      };
    } finally {
      bulkRunning = false;
      stopRequested = false;
    }
  });
}

/**
 * (Legacy) Báo hàng theo danh sách orderId — tự tra đơn từ Basso. QUÉT QUA CÁC TRANG cho tới khi
 * tìm đủ id cần (hoặc hết trang), không còn kẹt ở trang đầu. Vẫn ưu tiên notifyOrders (client gửi
 * sẵn đơn đầy đủ) vì rẻ hơn; nhánh này chỉ dùng cho payload orderIds cũ.
 * @param {string[]} orderIds
 * @param {object} [opts]
 */
async function notifyMany(orderIds, opts = {}) {
  const want = new Set(orderIds.map((id) => String(id)));
  const byId = new Map();
  // Lật trang tới khi gom đủ id cần hoặc hết dữ liệu (trần 100 trang × 100 đơn cho an toàn).
  for (let page = 1; page <= 100 && byId.size < want.size; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { orders, total } = await getOrders({ page, pageSize: 100 });
    for (const o of orders) {
      const key = String(o.id);
      if (want.has(key) && !byId.has(key)) byId.set(key, o);
    }
    if (orders.length < 100) break;                    // hết trang
    if (total != null && page * 100 >= total) break;   // đã quét đủ tổng
  }
  const found = [];
  const missing = [];
  for (const id of orderIds) {
    const o = byId.get(String(id));
    if (o) found.push(o); else missing.push(id);
  }
  const res = await notifyOrders(found, opts);
  for (const id of missing) {
    res.results.push({ orderId: id, ok: false, error: 'Không tìm thấy đơn' });
    res.total += 1; res.failed += 1;
  }
  return res;
}

module.exports = {
  notifyOne, notifyMany, notifyOrders, delayBetweenCustomers, requestStopBulk, isBulkRunning,
};
