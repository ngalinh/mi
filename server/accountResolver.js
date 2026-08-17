'use strict';
const config = require('./config');
const { getAccountsCached } = require('./playwrightProxy');
const { getArrivedItems } = require('./bassoApi');
const { isFacebookOrder, getContactKenhSale } = require('./db');

/**
 * Quyết định gửi đơn bằng tài khoản Zalo nào (MÔ HÌNH B: mỗi account 1 profile riêng).
 * NV phụ trách là trục CHÍNH quyết định RỔ tài khoản; Kênh sale KHÔNG còn tự chọn account độc lập
 * với NV như trước — chỉ còn vai trò PHỤ: khi rổ của 1 NV có từ 2 tài khoản trở lên (Zalo lẫn
 * Facebook) mà không phân biệt được bằng brand, dùng Kênh sale của đơn/khách để chọn đúng cái
 * trong rổ đó (xem `kenhSaleSignal`/`pickByKenhSale`).
 *
 * Thứ tự ưu tiên:
 *   1) opts.account truyền thẳng (người dùng chọn cụ thể trên UI, Zalo lẫn Facebook) — dùng kèm
 *      opts.profile. Đứng TRƯỚC cả định tuyến Facebook tự động (đơn thuộc diện auto-route FB vẫn
 *      gửi đúng account người dùng chọn tay). Kênh gửi suy từ platform của account được chọn.
 *   1.5) KÊNH gửi ép THẲNG qua nút "Báo qua Facebook" (opts.channel='facebook', người gửi TƯỜNG
 *      MINH bấm cho lượt báo này) — lựa chọn rõ ràng của người gửi, không được ghi đè.
 *   1.8) Tự nhận diện Facebook: khách đã có sẵn link Facebook trong Danh bạ (db.isFacebookOrder)
 *      -> định tuyến Facebook theo NV phụ trách (resolveFacebook). NV có ≥2 tài khoản FB -> chọn
 *      theo Kênh sale (xem trên), không phân biệt được thì lấy account đầu như trước.
 *   2) accountsStore (runner): khớp đơn theo staffId (= order.userId, hoặc account được gắn DÙNG
 *      CHUNG qua sharedStaffIds) rồi tới tên NV (= order.staff). NV không khớp account riêng nào
 *      (kể cả NV mới chưa từng cấu hình) -> rơi về nhóm account "CHUNG TOÀN CÔNG TY" (không gắn
 *      staffId) — áp dụng đúng luật brand bên dưới, y hệt như đang xét account của 1 NV.
 *      - Chỉ 1 account khớp (riêng hoặc chung)  -> dùng luôn (không tra API).
 *      - Nhiều account khớp + có gắn brand -> đọc mã đơn (getArrivedItems), chọn account có
 *        `brand` khớp PREFIX mã đơn (vd đơn "BS26052646" -> account brand "BS"). Vì mỗi dòng
 *        hàng về chỉ thuộc 1 brand nên chỉ cần đọc 1 mã. NHIỀU account CÙNG khớp 1 brand (hoặc
 *        cùng KHÔNG gắn brand) -> phân biệt tiếp bằng Kênh sale trước khi đành lấy account đầu.
 *        Các account còn lại trong rổ được đính kèm làm FALLBACK — xem chú thích `fallbackAccounts`.
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

/** Kênh sale THẬT của 1 đơn — field Partner API trả thẳng (sale_channel/sale_channel_label, đã
 * chuẩn hoá thành saleChannelLabel/saleChannel ở bassoApi.js/shippingApi.js). '' nếu đơn không có. */
function orderKenhSale(order) {
  return String((order && (order.saleChannelLabel || order.saleChannel)) || '').trim();
}

/** Nguồn Kênh sale dùng để PHÂN BIỆT giữa nhiều tài khoản của CÙNG 1 NV — KHÔNG dùng để tự chọn
 * account độc lập với NV (đó là hành vi CŨ đã bỏ). Ưu tiên: a) opts.kenhSale (chọn tay cho lượt báo
 * này); b) kênh sale THẬT của đơn; c) kênh sale gắn riêng cho khách trong Danh bạ. */
function kenhSaleSignal(order, opts) {
  return String((opts && opts.kenhSale) || '').trim()
    || orderKenhSale(order)
    || getContactKenhSale(order && order.phone);
}

/** Trong 1 rổ candidates (đã lọc theo NV), tìm account có field `kenhSale` khớp `wanted` (không
 * phân biệt hoa/thường, 1 account có thể gán nhiều kênh sale tách bởi dấu phẩy/chấm phẩy). Trả
 * null nếu không có wanted, rổ chỉ có ≤1 account (không cần phân biệt), hoặc không ai khớp — để
 * caller tự rơi về luật cũ (account đầu tiên / catch-all) như trước khi có Kênh sale. */
function pickByKenhSale(candidates, wanted) {
  const want = norm(wanted);
  if (!want || !candidates || candidates.length < 2) return null;
  return candidates.find((a) => String(a.kenhSale || '').split(/[,;]+/).map((s) => norm(s)).includes(want)) || null;
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
 * FB không có brand để phân biệt như Zalo -> NV có từ 2 tài khoản FB trở lên thì dùng Kênh sale
 * của đơn/khách để chọn đúng cái (xem pickByKenhSale); không phân biệt được thì lấy account đầu.
 * @returns {object} resolved (channel:'facebook') hoặc skip nếu NV chưa có tài khoản FB.
 */
function resolveFacebook(order, accounts, kenhSale) {
  const fbAccounts = (accounts || []).filter((a) => a.platform === 'facebook');
  const uid = norm(order && order.userId);
  const staff = norm(order && order.staff);
  let mine = uid ? fbAccounts.filter((a) => ownedBy(a, uid)) : [];
  if (!mine.length && staff) mine = fbAccounts.filter((a) => norm(a.name) === staff);
  // Không khớp NV -> chỉ dùng account FB "chung" (không gắn staffId) làm catch-all. KHÔNG lấy
  // đại account FB của NV khác (tránh gửi nhầm từ trang FB của người khác).
  if (!mine.length) mine = fbAccounts.filter((a) => !norm(a.staffId));
  const acct = pickByKenhSale(mine, kenhSale) || mine[0];
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
  // 1) Chọn cụ thể từ UI/lệnh (cột "Tài khoản gửi" / modal báo tay) — ƯU TIÊN CAO NHẤT, đứng TRƯỚC
  // cả định tuyến FB tự động bên dưới: người dùng đã tự chọn đúng tài khoản (Zalo hoặc Facebook)
  // muốn gửi thì dùng luôn account đó, không để logic auto-route ghi đè. Kênh gửi (Zalo/Facebook)
  // suy từ chính account được chọn (`platform`), KHÔNG còn ép cứng về Zalo như trước — account chọn
  // là Facebook (khớp theo fbName) thì gửi qua Facebook. Vẫn tra "Kiểu báo" (notifyTarget) của
  // account để không bị mất kiểu báo cá nhân -> mặc định 'group'.
  if (opts.account) {
    let notifyTarget = 'group';
    let channel = 'zalo';
    try {
      const accts = await getAccountsCached();
      // Ưu tiên khớp CHÍNH XÁC theo profile (account.key, UI luôn gửi kèm opts.profile = acct.key
      // khi người dùng chọn tay — xem giaohang.js/dashboard.js acctOverride). Khớp theo key trước
      // để tránh nhầm platform khi 1 Zalo và 1 Facebook account TRÙNG tên hiển thị (vd NV "Thuỳ
      // Trang" có cả Zalo lẫn FB) — so khớp mập mờ theo tên bên dưới có thể vớ nhầm account KHÁC
      // platform với cái người dùng vừa chọn trên UI (chọn FB Thuỳ Trang lại resolve ra Zalo).
      let found = opts.profile ? (accts || []).find((a) => a.key === opts.profile) : null;
      if (!found) {
        found = (accts || []).find((a) =>
          norm(a.saleworkName) === norm(opts.account) || norm(a.fbName) === norm(opts.account) || norm(a.name) === norm(opts.account));
      }
      if (found) {
        if (found.notifyTarget === 'personal') notifyTarget = 'personal';
        if (found.platform === 'facebook') channel = 'facebook';
      }
    } catch { /* không tra được -> giữ mặc định zalo/group */ }
    return { channel, profile: opts.profile || 'default', account: opts.account, autoEnabled: true, notifyTarget, source: 'explicit' };
  }

  // KÊNH gửi ép THẲNG qua nút "Báo qua Facebook" (opts.channel='facebook', người gửi TƯỜNG MINH bấm
  // cho lượt báo này) — đứng TRÊN CẢ tự nhận diện Facebook bên dưới vì đây là lựa chọn rõ ràng của
  // người gửi, không được ghi đè.
  if (opts.channel === 'facebook') {
    let accounts = [];
    try { accounts = await getAccountsCached(); } catch { accounts = []; }
    return resolveFacebook(order, accounts, kenhSaleSignal(order, opts));
  }

  // KÊNH gửi TỰ NHẬN DIỆN: khách đã có sẵn link Facebook trong Danh bạ (isFacebookOrder) -> định
  // tuyến Facebook theo NV phụ trách. opts.channel==='zalo' = người gửi ép Zalo tường minh -> bỏ qua.
  if (opts.channel !== 'zalo' && isFacebookOrder(order)) {
    let accounts = [];
    try { accounts = await getAccountsCached(); } catch { accounts = []; }
    return resolveFacebook(order, accounts, kenhSaleSignal(order, opts));
  }

  // 2) accountsStore (Hướng B). Chỉ xét account ZALO ở nhánh này (FB đã xử lý ở trên).
  let accounts = [];
  try { accounts = (await getAccountsCached()).filter((a) => a.platform !== 'facebook'); } catch { accounts = []; }
  if (Array.isArray(accounts) && accounts.length && order) {
    const uid = norm(order.userId);
    const staff = norm(order.staff);
    // Tất cả account của NV này: ưu tiên khớp theo staffId (hoặc sharedStaffIds), không có thì theo tên.
    let mine = uid ? accounts.filter((a) => ownedBy(a, uid)) : [];
    if (!mine.length && staff) mine = accounts.filter((a) => norm(a.name) === staff);
    // NV không có Zalo riêng (không khớp staffId/sharedStaffIds/tên) -> dùng nhóm account "CHUNG
    // TOÀN CÔNG TY" (không gắn staffId), chọn theo brand y như 1 NV bình thường. Áp dụng cho MỌI
    // NV kể cả NV mới sau này chưa từng cấu hình riêng (đối xứng với resolveFacebook ở trên).
    if (!mine.length) mine = accounts.filter((a) => !norm(a.staffId));

    if (mine.length === 1) {
      // 1 account -> dùng luôn. (Nếu account có gắn brand mà đơn khác brand thì vẫn cần khớp:
      // xử lý ở nhánh "có brand" bên dưới để không gửi nhầm brand.)
      const only = mine[0];
      if (!only.brand) return fromStore(only); // account "chung" -> nhận mọi brand.
    }

    if (mine.length) {
      const kenhSale = kenhSaleSignal(order, opts);
      const branded = mine.filter((a) => a.brand);
      if (!branded.length) {
        // NV không cấu hình brand nào. 1 account -> dùng luôn. NHIỀU account (vd NV được gắn 2 tài
        // khoản Zalo dùng chung, không phân biệt được bằng brand) -> dùng Kênh sale của đơn/khách
        // để chọn đúng cái nếu account nào đó có gán kênh sale khớp; không phân biệt được thì vẫn
        // ưu tiên account đầu như trước. Các account còn lại đính kèm làm FALLBACK: nếu account
        // chọn gửi lỗi "không thấy hội thoại" (khách có thể đang nằm ở tài khoản kia), caller
        // (notifyService/shippingSendService) sẽ tự thử lần lượt các account dự phòng này thay vì
        // bỏ cuộc ngay.
        const chosen = pickByKenhSale(mine, kenhSale) || mine[0];
        const primary = fromStore(chosen);
        const rest = mine.filter((a) => a !== chosen);
        if (rest.length) primary.fallbackAccounts = rest.map(fromStore);
        return primary;
      }
      // NV có cấu hình brand -> BẮT BUỘC khớp prefix mã đơn (kể cả khi chỉ 1 account có brand).
      const code = await fetchOrderCode(order);
      const orderBrand = brandOfCode(code);
      const codeU = String(code).toUpperCase();
      // 1 account có thể gắn NHIỀU brand, ngăn cách bởi phẩy/khoảng trắng/;/ (vd "BS, SU").
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
      // NHIỀU account CÙNG khớp 1 brand (vd 2 tài khoản đều gắn "BS") -> Kênh sale phân biệt tiếp,
      // không phân biệt được thì lấy account đầu như trước.
      const brandMatches = mine.filter((a) => brandsOf(a).some((b) => codeU.startsWith(b)));
      if (brandMatches.length) return withFallback(pickByKenhSale(brandMatches, kenhSale) || brandMatches[0]);
      // Không khớp brand nào: account "chung" (không brand) làm catch-all — nhiều account "chung"
      // thì cũng phân biệt bằng Kênh sale trước khi đành lấy account đầu.
      const noBrand = mine.filter((a) => !a.brand);
      const catchAll = pickByKenhSale(noBrand, kenhSale) || noBrand[0];
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
