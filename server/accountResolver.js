'use strict';
const config = require('./config');
const { getAccountsCached } = require('./playwrightProxy');

/**
 * Quyết định gửi đơn bằng tài khoản Zalo nào (MÔ HÌNH B: mỗi account 1 profile riêng).
 *
 * Thứ tự ưu tiên:
 *   1) opts.account truyền thẳng (người dùng chọn cụ thể trên UI) — dùng kèm opts.profile.
 *   2) accountsStore (runner): khớp đơn theo staffId (= order.userId) rồi tới tên NV (= order.staff).
 *      -> { profile: acct.key, account: acct.saleworkName } — đúng Hướng B.
 *   3) Legacy ZALO_ACCOUNT_MAP (env): map NV -> tên account, gửi qua profile mặc định.
 *   4) Mặc định: profile 'default' + opts.defaultAccount.
 *
 * @returns {Promise<{profile:string, account:(string|undefined), autoEnabled:boolean, source:string}>}
 */
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

async function resolveForOrder(order, opts = {}) {
  // 1) Chọn cụ thể từ UI/lệnh.
  if (opts.account) {
    return { profile: opts.profile || 'default', account: opts.account, autoEnabled: true, source: 'explicit' };
  }

  // 2) accountsStore (Hướng B).
  let accounts = [];
  try { accounts = await getAccountsCached(); } catch { accounts = []; }
  if (Array.isArray(accounts) && accounts.length && order) {
    const uid = norm(order.userId);
    const staff = norm(order.staff);
    const match = accounts.find((a) => (uid && norm(a.staffId) === uid))
      || accounts.find((a) => (staff && norm(a.name) === staff));
    if (match) {
      return {
        profile: match.key,
        account: match.saleworkName || undefined,
        autoEnabled: match.autoEnabled !== false,
        source: 'store',
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

module.exports = { resolveForOrder };
