'use strict';
const config = require('./config');
const { getAccountsCached } = require('./playwrightProxy');
const { getArrivedItems } = require('./bassoApi');
const { isFacebookOrder, findChannelAccount, getContactKenhSale } = require('./db');

/**
 * Quyết định gửi đơn bằng tài khoản Zalo nào (MÔ HÌNH B: mỗi account 1 profile riêng).
 *
 * Thứ tự ưu tiên:
 *   1) opts.account truyền thẳng (người dùng chọn cụ thể trên UI, Zalo lẫn Facebook) — dùng kèm
 *      opts.profile. Đứng TRƯỚC cả định tuyến Facebook tự động (đơn thuộc diện auto-route FB vẫn
 *      gửi đúng account người dùng chọn tay). Kênh gửi suy từ platform của account được chọn.
 *   1.5) KÊNH SALE: nguồn kenhSale theo thứ tự ưu tiên — a) opts.kenhSale (người dùng CHỌN TAY cho
 *      lượt báo này); b) kênh sale THẬT của đơn (order.saleChannelLabel/saleChannel — Partner API
 *      trả thẳng, xem cột "Kênh sale" trên Hàng về VN/Quản lý giao hàng); c) kênh sale đã gắn riêng
 *      cho khách trong Danh bạ (db.getContactKenhSale). Có kenhSale thì chọn account theo ĐÚNG kênh
 *      sale đó, KHÔNG CẦN biết NV phụ trách đơn — ưu tiên account (Zalo hoặc Facebook) gán TRỰC TIẾP
 *      nhãn kênh sale này ("Sửa tài khoản", xem findAccountByKenhSale), fallback cấu hình CŨ (kênh
 *      sale + NV -> tài khoản Zalo, xem db.js findChannelAccount) nếu chưa gán trực tiếp.
 *   1.8) Tự nhận diện Facebook: kênh sale ở trên KHÔNG chọn được account nào, và khách đã có sẵn
 *      link Facebook trong Danh bạ (db.isFacebookOrder) -> định tuyến Facebook theo NV phụ trách
 *      (resolveFacebook). Đứng SAU kênh sale có chủ đích — xem chú thích tại chỗ gọi.
 *   2) accountsStore (runner): khớp đơn theo staffId (= order.userId, hoặc account được gắn DÙNG
 *      CHUNG qua sharedStaffIds) rồi tới tên NV (= order.staff). NV không khớp account riêng nào
 *      (kể cả NV mới chưa từng cấu hình) -> rơi về nhóm account "CHUNG TOÀN CÔNG TY" (không gắn
 *      staffId) — áp dụng đúng luật brand bên dưới, y hệt như đang xét account của 1 NV.
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

/** Prefix chữ cái đầu của mã đơn -> brand (vd "BS26052646" -> "BS"). '' nếu không đọc được. */
function brandOfCode(code) {
  const m = /^[A-Za-z]+/.exec(String(code == null ? '' : code).trim());
  return m ? m[0].toUpperCase() : '';
}

/** Kênh sale THẬT của 1 đơn — field Partner API trả thẳng (sale_channel/sale_channel_label, đã
 * chuẩn hoá thành saleChannelLabel/saleChannel ở bassoApi.js/shippingApi.js). '' nếu đơn không có. */
function orderKenhSale(order) {
  return String((order && (order.saleChannelLabel || order.saleChannel)) || '').trim();
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

/**
 * Tìm account (Zalo HOẶC Facebook) được gán TRỰC TIẾP nhãn kênh sale này (field account.kenhSale,
 * xem local-runner/accountsStore.js) — không cần biết NV phụ trách đơn. Khớp không phân biệt hoa/
 * thường/khoảng trắng thừa; 1 account có thể nhận nhiều kênh sale (tách bởi dấu phẩy/chấm phẩy).
 * Nhiều account cùng nhận 1 kênh sale (cấu hình trùng) -> lấy account ĐẦU TIÊN, ghi log cảnh báo
 * để admin sửa lại ở Cài đặt → Sửa tài khoản (tránh 2 account cùng khớp -> gửi lúc account này lúc
 * account kia, khó lường).
 */
function findAccountByKenhSale(accounts, kenhSale) {
  const want = norm(kenhSale);
  if (!want) return null;
  const matches = (accounts || []).filter((a) =>
    String(a.kenhSale || '').split(/[,;]+/).map((s) => norm(s)).includes(want));
  if (matches.length > 1) {
    console.warn(`[accountResolver] Kênh sale "${kenhSale}" đang gán cho ${matches.length} tài khoản (${matches.map((a) => a.key).join(', ')}) -> dùng tài khoản đầu "${matches[0].key}", sửa lại ở Cài đặt cho hết trùng.`);
  }
  return matches[0] || null;
}

/** Đóng gói 1 account (Zalo/Facebook) tìm theo kênh sale -> shape resolved. */
function fromKenhSaleAccount(acct) {
  const isFb = acct.platform === 'facebook';
  return {
    channel: isFb ? 'facebook' : 'zalo',
    profile: acct.key,
    account: (isFb ? acct.fbName : acct.saleworkName) || undefined,
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
  const uid = norm(order && order.userId);
  const staff = norm(order && order.staff);
  let mine = uid ? fbAccounts.filter((a) => ownedBy(a, uid)) : [];
  if (!mine.length && staff) mine = fbAccounts.filter((a) => norm(a.name) === staff);
  // Không khớp NV -> chỉ dùng account FB "chung" (không gắn staffId) làm catch-all. KHÔNG lấy
  // đại account FB của NV khác (tránh gửi nhầm từ trang FB của người khác).
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
  // cho lượt báo này) — đứng TRÊN CẢ kênh sale/tự nhận diện Facebook bên dưới vì đây là lựa chọn rõ
  // ràng của người gửi, không được ghi đè.
  if (opts.channel === 'facebook') {
    let accounts = [];
    try { accounts = await getAccountsCached(); } catch { accounts = []; }
    return resolveFacebook(order, accounts);
  }

  // 1.5) KÊNH SALE: nguồn kenhSale theo thứ tự ưu tiên — a) opts.kenhSale nếu người gửi TƯỜNG MINH
  // chọn cho lượt báo này (UI báo tay); không thì SUY MẶC ĐỊNH (kenhSaleExplicit=false) từ b) kênh
  // sale THẬT của đơn (order.saleChannelLabel/saleChannel — Partner API trả thẳng, xem cột "Kênh
  // sale" trên Hàng về VN/Quản lý giao hàng), rồi c) kênh sale đã gắn riêng cho khách trong Danh bạ
  // (db.getContactKenhSale — khách đặc thù không theo kênh sale thật của đơn).
  // Có kenhSale thì chọn account KHÔNG CẦN BIẾT NV phụ trách đơn — chỉ cần account nào đang gán
  // TRỰC TIẾP nhãn kênh sale này (field account.kenhSale, "Sửa tài khoản" — mọi kênh Zalo lẫn
  // Facebook, xem findAccountByKenhSale). Không có account nào gán trực tiếp thì thử tiếp cấu hình
  // CŨ (kênh sale + NV -> tài khoản Zalo, bảng channel_accounts) để không phá vỡ cấu hình từ trước
  // khi field account.kenhSale chưa có.
  // ĐỨNG TRƯỚC bước tự nhận diện Facebook theo Danh bạ bên dưới (isFacebookOrder) — CỐ Ý: nếu để
  // sau, isFacebookOrder chỉ true khi khách ĐÃ CÓ link Facebook trong Danh bạ, tức tới lượt kênh sale
  // xét thì chắc chắn khách CHƯA có link -> account Facebook chọn theo kênh sale (nếu có) sẽ LUÔN văng
  // lỗi "chưa có link Facebook" (nhánh kênh sale không bao giờ dùng được). Kênh sale khi đã cấu hình
  // là NGUỒN QUYẾT ĐỊNH kênh + tài khoản gửi — kể cả khi khách cũng có sẵn link Facebook (đổi ưu tiên
  // so với trước, nhất quán với việc "không quan trọng NV/đường đi cũ nữa, chỉ theo kênh sale").
  // Không tìm thấy cấu hình/account nào ở cả 2 nguồn trên:
  //   - kenhSaleExplicit=true (người dùng TƯỜNG MINH chọn) -> BÁO RÕ (skip), không âm thầm rơi
  //     về nhánh khác kẻo gửi nhầm tài khoản ngoài ý muốn.
  //   - kenhSaleExplicit=false (chỉ là MẶC ĐỊNH suy từ đơn/Danh bạ) -> ÂM THẦM rơi tiếp xuống bước
  //     tự nhận diện Facebook rồi accountsStore bên dưới, KHÔNG skip — đơn/khách có kênh sale mà
  //     kênh đó chưa/không còn cấu hình không được vì thế mà mất báo hàng.
  const kenhSaleExplicit = !!String(opts.kenhSale || '').trim();
  const kenhSale = String(opts.kenhSale || '').trim()
    || orderKenhSale(order)
    || getContactKenhSale(order && order.phone);
  if (kenhSale) {
    let accounts = [];
    try { accounts = await getAccountsCached(); } catch { accounts = []; }
    const direct = findAccountByKenhSale(accounts, kenhSale);
    if (direct) return fromKenhSaleAccount(direct);

    const row = findChannelAccount({
      kenhSale,
      staffId: order && order.userId,
      staffName: order && order.staff,
    });
    if (row) {
      const resolved = fromChannelAccount(row, accounts.filter((a) => a.platform !== 'facebook'));
      if (resolved) return resolved;
    }
    if (kenhSaleExplicit) {
      return {
        channel: 'zalo', profile: null, account: undefined, autoEnabled: true,
        source: 'channel', skip: true, skipReason: 'channel_no_account',
      };
    }
  }

  // KÊNH gửi TỰ NHẬN DIỆN: khách đã có sẵn link Facebook trong Danh bạ (isFacebookOrder) và kênh sale
  // ở trên KHÔNG tự chọn được account nào -> định tuyến Facebook theo NV phụ trách như trước đây.
  if (opts.channel !== 'zalo' && isFacebookOrder(order)) {
    let accounts = [];
    try { accounts = await getAccountsCached(); } catch { accounts = []; }
    return resolveFacebook(order, accounts);
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
