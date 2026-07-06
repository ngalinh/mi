'use strict';
const config = require('./config');
const { getAccountsCached } = require('./playwrightProxy');
const { getArrivedItems } = require('./bassoApi');

/**
 * Quyết định gửi đơn bằng tài khoản Zalo nào (MÔ HÌNH B: mỗi account 1 profile riêng).
 *
 * Thứ tự ưu tiên:
 *   1) opts.account truyền thẳng (người dùng chọn cụ thể trên UI) — dùng kèm opts.profile.
 *   2) accountsStore (runner): khớp đơn theo staffId (= order.userId) rồi tới tên NV (= order.staff).
 *      - NV chỉ 1 account            -> dùng luôn (không tra API).
 *      - NV nhiều account + có gắn brand -> đọc mã đơn (getArrivedItems), chọn account có
 *        `brand` khớp PREFIX mã đơn (vd đơn "BS26052646" -> account brand "BS"). Vì mỗi dòng
 *        hàng về chỉ thuộc 1 brand nên chỉ cần đọc 1 mã.
 *      - Không khớp brand nào (HƯỚNG A): nếu NV có account KHÔNG gắn brand thì dùng làm "chung",
 *        không thì BỎ QUA (skip=true) -> luồng gọi tự quyết (auto bỏ đơn, tay báo lỗi rõ ràng).
 *   3) Legacy ZALO_ACCOUNT_MAP (env): map NV -> tên account, gửi qua profile mặc định.
 *   4) Mặc định: profile 'default' + opts.defaultAccount.
 *
 * @returns {Promise<{profile:string, account:(string|undefined), autoEnabled:boolean, source:string,
 *   skip?:boolean, skipReason?:string, orderBrand?:string}>}
 */
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

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
    profile: acct.key,
    account: acct.saleworkName || undefined,
    autoEnabled: acct.autoEnabled !== false,
    autoEnabledAt: acct.autoEnabledAt || null, // mốc bật auto -> lọc đơn tồn đọng ở autoNotify
    notifyTarget: acct.notifyTarget === 'personal' ? 'personal' : 'group', // kiểu báo: nhóm/cá nhân
    source: 'store',
  };
}

async function resolveForOrder(order, opts = {}) {
  // 1) Chọn cụ thể từ UI/lệnh. Vẫn tra "Kiểu báo" (notifyTarget) của account được chọn (khớp theo
  // tên dropdown/tên NV) để báo tay chọn account cụ thể KHÔNG bị mất kiểu báo cá nhân -> mặc định 'group'.
  if (opts.account) {
    let notifyTarget = 'group';
    try {
      const accts = await getAccountsCached();
      const found = (accts || []).find((a) => norm(a.saleworkName) === norm(opts.account) || norm(a.name) === norm(opts.account));
      if (found && found.notifyTarget === 'personal') notifyTarget = 'personal';
    } catch { /* không tra được -> giữ 'group' */ }
    return { profile: opts.profile || 'default', account: opts.account, autoEnabled: true, notifyTarget, source: 'explicit' };
  }

  // 2) accountsStore (Hướng B).
  let accounts = [];
  try { accounts = await getAccountsCached(); } catch { accounts = []; }
  if (Array.isArray(accounts) && accounts.length && order) {
    const uid = norm(order.userId);
    const staff = norm(order.staff);
    // Tất cả account của NV này: ưu tiên khớp theo staffId, không có thì theo tên.
    let mine = uid ? accounts.filter((a) => norm(a.staffId) === uid) : [];
    if (!mine.length && staff) mine = accounts.filter((a) => norm(a.name) === staff);

    if (mine.length === 1) {
      // 1 account -> dùng luôn. (Nếu account có gắn brand mà đơn khác brand thì vẫn cần khớp:
      // xử lý ở nhánh "có brand" bên dưới để không gửi nhầm brand.)
      const only = mine[0];
      if (!only.brand) return fromStore(only); // account "chung" -> nhận mọi brand.
    }

    if (mine.length) {
      const branded = mine.filter((a) => a.brand);
      if (!branded.length) {
        // NV không cấu hình brand nào -> hành vi cũ: account đầu, nhận mọi đơn.
        return fromStore(mine[0]);
      }
      // NV có cấu hình brand -> BẮT BUỘC khớp prefix mã đơn (kể cả khi chỉ 1 account có brand).
      const code = await fetchOrderCode(order);
      const orderBrand = brandOfCode(code);
      const codeU = String(code).toUpperCase();
      const match = mine.find((a) => a.brand && codeU.startsWith(a.brand));
      if (match) return { ...fromStore(match), orderBrand };
      // Không khớp brand nào: account "chung" (không brand) làm catch-all nếu có.
      const catchAll = mine.find((a) => !a.brand);
      if (catchAll) return { ...fromStore(catchAll), orderBrand };
      // HƯỚNG A: NV chưa có Zalo cho brand này -> bỏ qua (không gửi nhầm brand).
      const first = mine[0];
      return {
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
    return { profile: opts.profile || 'default', account: legacy, autoEnabled: true, source: 'legacy' };
  }

  // 4) Mặc định.
  return { profile: opts.profile || 'default', account: opts.defaultAccount || undefined, autoEnabled: true, source: 'default' };
}

module.exports = { resolveForOrder, brandOfCode };
