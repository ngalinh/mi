'use strict';
const config = require('./config');
const { getAccountsCached } = require('./playwrightProxy');
const { getArrivedItems } = require('./bassoApi');
const { isFacebookOrder, findChannelAccount, getContactStaffIds } = require('./db');

/**
 * Quyết định gửi đơn bằng tài khoản Zalo nào (MÔ HÌNH B: mỗi account 1 profile riêng).
 *
 * Thứ tự ưu tiên:
 *   1) opts.account truyền thẳng (người dùng chọn cụ thể trên UI) — dùng kèm opts.profile.
 *   1.5) opts.kenhSale (người dùng chọn Kênh sale cho lượt báo): tra bảng cấu hình (kênh sale +
 *      NV phụ trách đơn -> tài khoản Zalo, xem db.js findChannelAccount). Basso không trả field
 *      kênh sale trong dữ liệu đơn nên KHÔNG có nhánh tự nhận diện — chỉ áp dụng khi được chọn.
 *   2) accountsStore (runner): khớp đơn theo staffId (= order.userId, hoặc account được gắn DÙNG
 *      CHUNG qua sharedStaffIds) rồi tới tên NV (= order.staff), không khớp thì tới NV phụ trách
 *      gán tay cho khách trong Danh bạ (zalo_contacts.staff_id — xem myAccounts). NV không khớp
 *      account riêng nào qua cả 3 cách (kể cả NV mới chưa từng cấu hình) -> rơi về nhóm account
 *      "CHUNG TOÀN CÔNG TY" (không gắn staffId) — áp dụng đúng luật brand bên dưới, y hệt như
 *      đang xét account của 1 NV.
 *      - Chỉ 1 account khớp (riêng hoặc chung)  -> dùng luôn (không tra API).
 *      - Nhiều account khớp + có gắn brand -> đọc mã đơn (getArrivedItems), chọn account có
 *        `brand` khớp PREFIX mã đơn (vd đơn "BS26052646" -> account brand "BS"). Vì mỗi dòng
 *        hàng về chỉ thuộc 1 brand nên chỉ cần đọc 1 mã. Các account còn lại trong rổ (khác brand
 *        hoặc không brand) được đính kèm làm FALLBACK — xem chú thích `fallbackAccounts` bên dưới.
 *      - Không khớp brand nào (HƯỚNG A): nếu có account KHÔNG gắn brand thì dùng làm "catch-all"
 *        (các account còn lại làm fallback), không thì BỎ QUA (skip=true) -> luồng gọi tự quyết
 *        (auto bỏ đơn, tay báo lỗi rõ ràng).
 *   3) Legacy ZALO_ACCOUNT_MAP (env): map NV -> tên account, gửi qua profile mặc định.
 *   4) Mặc định: profile 'default' + opts.defaultAccount.
 *
 * @returns {Promise<{profile:string, account:(string|undefined), autoEnabled:boolean, source:string,
 *   skip?:boolean, skipReason?:string, orderBrand?:string}>}
 */
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** true nếu account thuộc về NV `uid` — chủ (staffId) hoặc được gắn DÙNG CHUNG (sharedStaffIds). */
const ownedBy = (a, uid) => norm(a.staffId) === uid || (a.sharedStaffIds || []).some((s) => norm(s) === uid);

/**
 * Rổ account (trong `pool`, đã lọc platform từ trước) thuộc về NV phụ trách đơn `order`. Thứ tự:
 *   1) order.userId (staffId/sharedStaffIds) — dữ liệu Basso, đáng tin nhất khi có.
 *   2) order.staff (tên) — khi Basso không trả userId.
 *   3) NV phụ trách gán TAY cho khách trong Danh bạ (zalo_contacts.staff_id, hỗ trợ nhiều NV) —
 *      DỰ PHÒNG khi (1)/(2) không khớp account nào: đơn có thể do NV khác duyệt/tạo hộ, nhưng
 *      khách vẫn có 1 NV chăm sóc cố định đã gán trong Danh bạ -> ưu tiên gửi qua account NV đó
 *      thay vì rơi thẳng xuống nhóm "chung toàn công ty".
 * Trả [] nếu không khớp gì — caller tự quyết fallback tiếp theo (thường là nhóm chung).
 */
function myAccounts(pool, order) {
  const uid = norm(order && order.userId);
  const staff = norm(order && order.staff);
  let mine = uid ? pool.filter((a) => ownedBy(a, uid)) : [];
  if (!mine.length && staff) mine = pool.filter((a) => norm(a.name) === staff);
  if (!mine.length && order && order.phone != null) {
    const ids = getContactStaffIds(order.phone);
    if (ids.length) mine = pool.filter((a) => ids.some((cid) => ownedBy(a, norm(cid))));
  }
  return mine;
}

/** Prefix chữ cái đầu của mã đơn -> brand (vd "BS26052646" -> "BS"). '' nếu không đọc được. */
function brandOfCode(code) {
  const m = /^[A-Za-z]+/.exec(String(code == null ? '' : code).trim());
  return m ? m[0].toUpperCase() : '';
}

/** Lấy 1 mã đơn (orderCode) của dòng hàng về — ưu tiên client gửi sẵn, không thì tra Basso (cache). */
async function fetchOrderCode(order) {
  if (order && order.orderCode && String(order.orderCode).trim()) return String(order.orderCode).trim();
  try {
    const { items } = await getArrivedItems({
      id: order.id, customerId: order.customerId, dateInventory: order.dateInventory,
    });
    const code = (items || []).map((it) => it.orderCode).find(Boolean);
    return code ? String(code).trim() : '';
  } catch {
    return '';
  }
}

/**
 * Đóng gói 1 account (tìm theo key) -> shape resolved cho luồng KÊNH SALE. Trả null nếu key
 * không khớp account nào còn tồn tại (đã xoá/đổi key sau khi cấu hình kênh sale).
 */
function fromChannelAccount(row, accounts) {
  const acct = (accounts || []).find((a) => a.key === row.zalo_account_key);
  if (!acct) return null;
  return {
    channel: 'zalo',
    profile: acct.key,
    account: acct.saleworkName || undefined,
    autoEnabled: acct.autoEnabled !== false,
    autoEnabledAt: acct.autoEnabledAt || null,
    notifyTarget: acct.notifyTarget === 'personal' ? 'personal' : 'group',
    source: 'channel',
  };
}

/** Đóng gói 1 account store -> shape resolved. */
function fromStore(acct) {
  return {
    channel: 'zalo',
    profile: acct.key,
    account: acct.saleworkName || undefined,
    autoEnabled: acct.autoEnabled !== false,
    autoEnabledAt: acct.autoEnabledAt || null, // mốc bật auto -> lọc đơn tồn đọng ở autoNotify
    notifyTarget: acct.notifyTarget === 'personal' ? 'personal' : 'group', // kiểu báo: nhóm/cá nhân
    source: 'store',
  };
}

/**
 * Chọn tài khoản FACEBOOK cho 1 đơn thuộc diện báo qua FB (khách trong danh sách / NV gắn FB).
 * FB không có brand/dropdown account -> chỉ cần tìm 1 account FB của NV phụ trách.
 * @returns {object} resolved (channel:'facebook') hoặc skip nếu NV chưa có tài khoản FB.
 */
function resolveFacebook(order, accounts) {
  const fbAccounts = (accounts || []).filter((a) => a.platform === 'facebook');
  let mine = myAccounts(fbAccounts, order);
  // Không khớp NV (kể cả qua Danh bạ) -> chỉ dùng account FB "chung" (không gắn staffId) làm
  // catch-all. KHÔNG lấy đại account FB của NV khác (tránh gửi nhầm từ trang FB của người khác).
  if (!mine.length) mine = fbAccounts.filter((a) => !norm(a.staffId));
  const acct = mine[0];
  if (!acct) {
    // Đơn cần báo FB nhưng chưa cấu hình tài khoản Facebook nào cho NV -> bỏ qua có lý do rõ ràng.
    return { channel: 'facebook', profile: null, account: undefined, autoEnabled: true, source: 'fb', skip: true, skipReason: 'fb_no_account' };
  }
  return {
    channel: 'facebook',
    profile: acct.key,
    account: acct.fbName || undefined,
    autoEnabled: acct.autoEnabled !== false,
    autoEnabledAt: acct.autoEnabledAt || null,
    source: 'store-fb',
  };
}

async function resolveForOrder(order, opts = {}) {
  // KÊNH gửi: mặc định Zalo. Chuyển sang Facebook khi ép qua opts.channel='facebook' (nút báo tay),
  // hoặc đơn thuộc diện định tuyến FB (SĐT khách / NV được gắn FB). Chọn account trước, mọi logic
  // Zalo bên dưới bỏ qua khi đã ở kênh FB.
  const wantFb = opts.channel === 'facebook' || (opts.channel !== 'zalo' && isFacebookOrder(order));
  if (wantFb) {
    let accounts = [];
    try { accounts = await getAccountsCached(); } catch { accounts = []; }
    return resolveFacebook(order, accounts);
  }
  // 1) Chọn cụ thể từ UI/lệnh. Vẫn tra "Kiểu báo" (notifyTarget) của account được chọn (khớp theo
  // tên dropdown/tên NV) để báo tay chọn account cụ thể KHÔNG bị mất kiểu báo cá nhân -> mặc định 'group'.
  if (opts.account) {
    let notifyTarget = 'group';
    try {
      const accts = await getAccountsCached();
      const found = (accts || []).find((a) => norm(a.saleworkName) === norm(opts.account) || norm(a.name) === norm(opts.account));
      if (found && found.notifyTarget === 'personal') notifyTarget = 'personal';
    } catch { /* không tra được -> giữ 'group' */ }
    return { channel: 'zalo', profile: opts.profile || 'default', account: opts.account, autoEnabled: true, notifyTarget, source: 'explicit' };
  }

  // 1.5) KÊNH SALE: Basso có "Kênh Sale" hiển thị trên web nhưng Partner API KHÔNG trả field này
  // (không có cách tự nhận diện kênh sale của 1 đơn) -> người gửi có thể CHỌN kênh sale cho lượt
  // báo (opts.kenhSale, UI báo tay), hoặc nó được suy MẶC ĐỊNH từ kênh sale đã gắn cho khách trong
  // Danh bạ (opts.kenhSaleExplicit=false — xem notifyService/shippingSendService). Có kênh sale thì
  // tra bảng cấu hình (kênh sale + NV phụ trách đơn -> tài khoản Zalo, tab Kênh Sale cũ).
  // Không tìm thấy cấu hình/account:
  //   - opts.kenhSaleExplicit=true (người dùng TƯỜNG MINH chọn) -> BÁO RÕ (skip), không âm thầm rơi
  //     về nhánh khác kẻo gửi nhầm tài khoản ngoài ý muốn.
  //   - opts.kenhSaleExplicit=false (chỉ là MẶC ĐỊNH suy từ Danh bạ) -> ÂM THẦM rơi tiếp xuống nhánh
  //     accountsStore bình thường bên dưới, KHÔNG skip — khách gắn kênh sale trong Danh bạ mà kênh đó
  //     chưa/không còn cấu hình (vd tab Kênh Sale đã bỏ) không được vì thế mà mất báo hàng.
  if (opts.kenhSale && String(opts.kenhSale).trim()) {
    const row = findChannelAccount({
      kenhSale: opts.kenhSale,
      staffId: order && order.userId,
      staffName: order && order.staff,
    });
    if (row) {
      let accounts = [];
      try { accounts = (await getAccountsCached()).filter((a) => a.platform !== 'facebook'); } catch { accounts = []; }
      const resolved = fromChannelAccount(row, accounts);
      if (resolved) return resolved;
    }
    if (opts.kenhSaleExplicit) {
      return {
        channel: 'zalo', profile: null, account: undefined, autoEnabled: true,
        source: 'channel', skip: true, skipReason: 'channel_no_account',
      };
    }
  }

  // 2) accountsStore (Hướng B). Chỉ xét account ZALO ở nhánh này (FB đã xử lý ở trên).
  let accounts = [];
  try { accounts = (await getAccountsCached()).filter((a) => a.platform !== 'facebook'); } catch { accounts = []; }
  if (Array.isArray(accounts) && accounts.length && order) {
    // Tất cả account của NV này: ưu tiên khớp theo staffId (hoặc sharedStaffIds)/tên từ đơn Basso,
    // dự phòng NV phụ trách gán trong Danh bạ (xem myAccounts).
    let mine = myAccounts(accounts, order);
    // NV không có Zalo riêng (không khớp staffId/sharedStaffIds/tên/Danh bạ) -> dùng nhóm account
    // "CHUNG TOÀN CÔNG TY" (không gắn staffId), chọn theo brand y như 1 NV bình thường. Áp dụng
    // cho MỌI NV kể cả NV mới sau này chưa từng cấu hình riêng (đối xứng với resolveFacebook).
    if (!mine.length) mine = accounts.filter((a) => !norm(a.staffId));

    if (mine.length === 1) {
      // 1 account -> dùng luôn. (Nếu account có gắn brand mà đơn khác brand thì vẫn cần khớp:
      // xử lý ở nhánh "có brand" bên dưới để không gửi nhầm brand.)
      const only = mine[0];
      if (!only.brand) return fromStore(only); // account "chung" -> nhận mọi brand.
    }

    if (mine.length) {
      const branded = mine.filter((a) => a.brand);
      if (!branded.length) {
        // NV không cấu hình brand nào. 1 account -> dùng luôn. NHIỀU account (vd NV được gắn 2 tài
        // khoản Zalo dùng chung, không phân biệt được bằng brand) -> vẫn ưu tiên account đầu, nhưng
        // đính kèm các account còn lại làm FALLBACK: nếu account đầu gửi lỗi "không thấy hội thoại"
        // (khách có thể đang nằm ở tài khoản kia), caller (notifyService/shippingSendService) sẽ tự
        // thử lần lượt các account dự phòng này thay vì bỏ cuộc ngay.
        const primary = fromStore(mine[0]);
        if (mine.length > 1) primary.fallbackAccounts = mine.slice(1).map(fromStore);
        return primary;
      }
      // NV có cấu hình brand -> BẮT BUỘC khớp prefix mã đơn (kể cả khi chỉ 1 account có brand).
      const code = await fetchOrderCode(order);
      const orderBrand = brandOfCode(code);
      const codeU = String(code).toUpperCase();
      // 1 account có thể gắn NHIỀU brand, ngăn cách bằng phẩy/khoảng trắng/;/ (vd "BS, SU").
      // Tách ra rồi khớp nếu mã đơn bắt đầu bằng BẤT KỲ brand nào -> hỗ trợ account đa-brand.
      const brandsOf = (a) => String(a.brand || '').split(/[\s,;/|]+/).map((b) => b.trim().toUpperCase()).filter(Boolean);
      // Đính kèm các account CÒN LẠI trong rổ (khác account vừa chọn) làm FALLBACK — đối xứng với
      // nhánh "không brand" ở trên: nếu account chọn theo brand gửi lỗi "không thấy hội thoại"
      // (mã đơn khớp brand nhưng khách thực tế lại đang chat ở tài khoản Zalo KHÁC của NV — vd
      // NV dùng chung nhiều account, brand không phản ánh đúng account nào giữ hội thoại), caller
      // (notifyService/shippingSendService) sẽ tự thử lần lượt các account dự phòng thay vì bỏ cuộc.
      const withFallback = (chosen) => {
        const primary = { ...fromStore(chosen), orderBrand };
        const rest = mine.filter((a) => a !== chosen);
        if (rest.length) primary.fallbackAccounts = rest.map(fromStore);
        return primary;
      };
      const match = mine.find((a) => brandsOf(a).some((b) => codeU.startsWith(b)));
      if (match) return withFallback(match);
      // Không khớp brand nào: account "chung" (không brand) làm catch-all nếu có.
      const catchAll = mine.find((a) => !a.brand);
      if (catchAll) return withFallback(catchAll);
      // HƯỚNG A: NV chưa có Zalo cho brand này -> bỏ qua (không gửi nhầm brand).
      const first = mine[0];
      return {
        channel: 'zalo',
        profile: first.key,
        account: undefined,
        autoEnabled: first.autoEnabled !== false,
        autoEnabledAt: first.autoEnabledAt || null,
        source: 'store',
        skip: true,
        skipReason: 'brand',
        orderBrand,
      };
    }
  }

  // 3) Legacy ZALO_ACCOUNT_MAP — giữ tương thích cấu hình cũ.
  const legacy = config.zaloAccountForOrder(order);
  if (legacy) {
    return { channel: 'zalo', profile: opts.profile || 'default', account: legacy, autoEnabled: true, source: 'legacy' };
  }

  // 4) Mặc định.
  return { channel: 'zalo', profile: opts.profile || 'default', account: opts.defaultAccount || undefined, autoEnabled: true, source: 'default' };
}

/**
 * true nếu lỗi gửi cho thấy "tài khoản này không có hội thoại của khách" (khách có thể nằm ở tài
 * khoản Zalo KHÁC của NV) -> đáng thử tiếp fallbackAccounts. Các lỗi khác (chưa đăng nhập, chọn sai
 * tài khoản, mạng...) KHÔNG thử tiếp vì thử account khác cũng sẽ lỗi y hệt hoặc gửi nhầm ngữ cảnh.
 */
function isRetryableAccountError(msg) {
  return /^KHONG_THAY_HOI_THOAI/.test(String(msg || '').trim());
}

module.exports = { resolveForOrder, brandOfCode, isRetryableAccountError };
