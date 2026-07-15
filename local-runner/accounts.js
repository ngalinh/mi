'use strict';
/**
 * Liệt kê các tài khoản Zalo mà 1 profile (phiên đăng nhập Salework) ĐANG THẤY trong dropdown.
 * Dùng để kiểm tra "profile này đã đăng nhập Salework chưa + có những Zalo nào của nhân viên nào",
 * và lấy đúng TÊN account để điền vào ZALO_ACCOUNT_MAP (tránh lỗi KHONG_THAY_TAI_KHOAN_ZALO).
 *
 * Chạy trên MÁY RUNNER (nơi có session đã lưu):
 *   npm run accounts              # profile mặc định "default"
 *   npm run accounts -- ten_acc   # profile khác
 *
 * Mặc định HEADLESS=false nên sẽ mở cửa sổ để bạn nhìn; có ảnh dropdown ở screenshots/02a-account-search.png.
 */
const config = require('./config');
const { getContext, profileExists } = require('./browser');
const { gotoSalework, ensureLoggedIn, listZaloAccounts } = require('./salework');

(async () => {
  const profile = process.argv[2] || 'default';
  console.log(`[accounts] profile="${profile}" | exists=${profileExists(profile)} | URL=${config.saleworkUrl}`);
  if (!profileExists(profile)) {
    console.error(`[accounts] ❌ Profile "${profile}" chưa có session. Đăng nhập trước: npm run login -- ${profile}`);
    process.exit(2);
  }

  const context = await getContext(profile);
  const page = context.pages()[0] || (await context.newPage());
  try {
    await gotoSalework(page);
    try {
      await ensureLoggedIn(page, { profile });
    } catch (e) {
      console.error(`[accounts] ❌ ${e.message}`);
      process.exit(3);
    }

    const names = await listZaloAccounts(page);
    if (!names.length) {
      console.log('[accounts] ✅ Đã đăng nhập, nhưng KHÔNG đọc được tài khoản nào trong dropdown.');
      console.log('[accounts] -> Có thể giao diện chỉ 1 account, hoặc selector đã đổi. Xem ảnh screenshots/02a-account-search.png.');
    } else {
      console.log(`[accounts] ✅ Đã đăng nhập. Thấy ${names.length} tài khoản Zalo:`);
      names.forEach((n, i) => console.log(`   ${String(i + 1).padStart(2)}. ${n}`));
      console.log('[accounts] Mẹo: copy đúng tên ở trên để điền ZALO_ACCOUNT_MAP (key = user_id NV / tên NV, value = tên Zalo).');
    }
  } finally {
    await context.close().catch(() => {});
  }
  process.exit(0);
})().catch((err) => {
  console.error('[accounts] Lỗi:', err.message);
  process.exit(1);
});
