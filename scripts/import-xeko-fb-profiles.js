'use strict';
/**
 * IMPORT PROFILE FACEBOOK ĐÃ ĐĂNG NHẬP TỪ XEKO SANG MI.
 *
 * Vì sao cần script này:
 *   - Session đăng nhập FB chỉ là 1 thư mục userDataDir của Chromium (Playwright
 *     launchPersistentContext) — copy được giữa 2 app vì cùng cơ chế.
 *   - NHƯNG cách đặt tên + vị trí khác nhau, và mi hiển thị tài khoản theo FILE JSON
 *     (config/zalo-accounts.json) chứ KHÔNG quét thư mục như Xeko. Nên chỉ copy folder
 *     thôi thì mi không hiện gì — phải tạo thêm bản ghi tài khoản.
 *
 *   Xeko  : FB profile ở  <xeko>/server/playwright-data/<key>
 *           meta hiển thị ở <xeko>/server/config/profiles-meta.json  ({ key: {name,email,proxy,password} })
 *   Mi    : FB profile ở  <mi>/playwright-data/fb-<key>              (tiền tố "fb-")
 *           tài khoản ở   <mi>/config/zalo-accounts.json             (platform:'facebook')
 *
 * Script này, cho MỖI profile FB của Xeko:
 *   1) Copy thư mục userDataDir  ->  playwright-data/fb-<key>  (bỏ qua Singleton* lock)
 *   2) Thêm/cập nhật 1 bản ghi tài khoản trong config/zalo-accounts.json (platform:'facebook')
 *      với name/fbName/email/proxy lấy từ profiles-meta.json của Xeko.
 *
 * An toàn:
 *   - Mặc định autoEnabled=FALSE (không tự động báo hàng ngay sau import — tránh blast khách
 *     thật). Bật bằng --enable-auto hoặc trong UI sau khi đã kiểm tra.
 *   - Không ghi đè folder/bản ghi đã có (trừ khi --force).
 *   - --dry-run chỉ in kế hoạch, KHÔNG đụng đĩa.
 *
 * ⚠️ TẮT Chromium của Xeko trước khi chạy: Chromium giữ SingletonLock trên userDataDir, copy
 *    lúc đang mở có thể ra bản dở. Script tự bỏ file lock nhưng không mở được profile đang chạy.
 *
 * Cách chạy (từ thư mục gốc mi):
 *   node scripts/import-xeko-fb-profiles.js --xeko=../Xeko/server            # import tất cả
 *   node scripts/import-xeko-fb-profiles.js --xeko=../Xeko/server --dry-run  # xem trước
 *   node scripts/import-xeko-fb-profiles.js --xeko=../Xeko/server --only=key1,key2
 *   node scripts/import-xeko-fb-profiles.js --xeko=../Xeko/server --force --enable-auto
 *
 * Tuỳ chọn:
 *   --xeko=<path>     Thư mục "server" của Xeko (chứa playwright-data/ và config/). BẮT BUỘC
 *                     nếu không auto-dò được. Cũng nhận thẳng đường dẫn playwright-data.
 *   --only=a,b,c      Chỉ import các key này.
 *   --force           Ghi đè cả thư mục profile lẫn bản ghi tài khoản đã tồn tại.
 *   --enable-auto     Bật autoEnabled=true (đóng dấu mốc từ bây giờ). Mặc định false.
 *   --no-password     KHÔNG import mật khẩu FB từ meta (mặc định có import nếu meta có).
 *   --dry-run         Chỉ in kế hoạch, không thay đổi gì.
 */

const fs = require('fs');
const path = require('path');

// Đường dẫn CỐ ĐỊNH của mi (khớp hằng số trong local-runner/config.js: dataDir & zaloAccountsFile).
// Tính thẳng theo repo root để script chạy độc lập, không kéo dotenv/playwright.
const MI_ROOT = path.resolve(__dirname, '..');
const miConfig = {
  dataDir: path.join(MI_ROOT, 'playwright-data'),
  zaloAccountsFile: path.join(MI_ROOT, 'config', 'zalo-accounts.json'),
};

// ---- Đọc cờ dòng lệnh ------------------------------------------------------
function flag(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
const OPT = {
  xeko: flag('xeko'),
  only: (typeof flag('only') === 'string' ? flag('only') : '').split(',').map((s) => s.trim()).filter(Boolean),
  force: !!flag('force'),
  enableAuto: !!flag('enable-auto'),
  noPassword: !!flag('no-password'),
  dryRun: !!flag('dry-run'),
};

// Chrome tạo sẵn các thư mục KHÔNG phải profile FB — loại trừ y hệt Xeko để không nhận nhầm.
const KNOWN_NON_PROFILES = new Set([
  'Crashpad', 'Default', 'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache',
  'Variations', 'component_crx_cache', 'extensions_crx_cache', 'segmentation_platform',
  'Safe Browsing',
]);

// Sanitize key -> tên thư mục, GIỐNG HỆT local-runner/browser.js:profilePath để mi tìm ra folder.
const sanitizeKey = (k) => String(k || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');

const log = (s) => console.log(s);
const ok = (s) => console.log(`✅ ${s}`);
const warn = (s) => console.log(`⚠️  ${s}`);
const bad = (s) => console.log(`❌ ${s}`);
const info = (s) => console.log(`   ${s}`);

/** Tìm thư mục playwright-data của Xeko từ --xeko (nhận cả .../server hoặc .../server/playwright-data). */
function resolveXekoDataDir() {
  const candidates = [];
  if (OPT.xeko) {
    const base = path.resolve(process.cwd(), OPT.xeko);
    candidates.push(base); // có thể user trỏ thẳng vào playwright-data
    candidates.push(path.join(base, 'playwright-data'));
  }
  // Auto-dò các vị trí quen thuộc khi không truyền --xeko.
  const miRoot = path.resolve(__dirname, '..');
  for (const name of ['Xeko', 'xeko']) {
    candidates.push(path.resolve(miRoot, '..', name, 'server', 'playwright-data'));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()
        && path.basename(c) === 'playwright-data') return c;
  }
  return null;
}

/** Đường dẫn profiles-meta.json của Xeko (nằm ở <server>/config/), suy ra từ playwright-data. */
function resolveMetaFile(xekoDataDir) {
  const serverDir = path.dirname(xekoDataDir); // .../server
  return path.join(serverDir, 'config', 'profiles-meta.json');
}

/** Liệt kê các key profile FB trong thư mục Xeko (loại salework/dotfile/thư mục hệ thống Chrome). */
function listFbProfiles(xekoDataDir) {
  return fs.readdirSync(xekoDataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()
      && !KNOWN_NON_PROFILES.has(e.name)
      && !e.name.startsWith('.')
      && !e.name.startsWith('salework')) // salework-<key> là profile Zalo, bỏ qua
    .map((e) => e.name);
}

/** Copy đệ quy userDataDir, BỎ QUA các file lock/socket singleton (tránh mang lock cũ sang mi). */
function copyProfile(srcDir, destDir) {
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    force: true,
    filter: (src) => !/^Singleton(Lock|Socket|Cookie)$/.test(path.basename(src)),
  });
}

function main() {
  const xekoDataDir = resolveXekoDataDir();
  if (!xekoDataDir) {
    bad('Không tìm thấy thư mục playwright-data của Xeko.');
    info('Truyền đường dẫn thư mục "server" của Xeko:  --xeko=../Xeko/server');
    process.exit(1);
  }
  const metaFile = resolveMetaFile(xekoDataDir);
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};

  log(`📂 Nguồn Xeko : ${xekoDataDir}`);
  log(`📄 Meta       : ${fs.existsSync(metaFile) ? metaFile : '(không có — dùng key làm tên)'}`);
  log(`📂 Đích mi     : ${miConfig.dataDir}`);
  log(`🗂️  Tài khoản  : ${miConfig.zaloAccountsFile}`);
  log(`⚙️  Chế độ     : ${OPT.dryRun ? 'DRY-RUN (không ghi)' : 'THẬT'}${OPT.force ? ' | force' : ''}${OPT.enableAuto ? ' | enable-auto' : ''}`);
  log('');

  let keys = listFbProfiles(xekoDataDir);
  if (OPT.only.length) keys = keys.filter((k) => OPT.only.includes(k));
  if (!keys.length) {
    warn('Không có profile FB nào để import (kiểm tra --xeko hoặc --only).');
    return;
  }

  // Đọc danh sách tài khoản mi hiện có (mảng thô) để merge — không dùng accountsStore.add để
  // kiểm soát được dry-run và không throw khi trùng key.
  let accounts = [];
  try {
    if (fs.existsSync(miConfig.zaloAccountsFile)) {
      const arr = JSON.parse(fs.readFileSync(miConfig.zaloAccountsFile, 'utf8'));
      if (Array.isArray(arr)) accounts = arr;
    }
  } catch (e) {
    warn(`Đọc zalo-accounts.json lỗi (${e.message}) — coi như rỗng.`);
  }
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  const nowIso = new Date().toISOString();

  const summary = { copied: 0, skippedFolder: 0, added: 0, updated: 0, skippedRecord: 0 };

  for (const key of keys) {
    const m = meta[key] || {};
    const safe = sanitizeKey(key);
    const srcDir = path.join(xekoDataDir, key);
    const destDir = path.join(miConfig.dataDir, `fb-${safe}`);
    const destExists = fs.existsSync(destDir);
    log(`• ${key}  →  fb-${safe}`);

    // --- 1) Copy thư mục profile ---
    if (destExists && !OPT.force) {
      info('folder: đã tồn tại → bỏ qua (dùng --force để ghi đè)');
      summary.skippedFolder += 1;
    } else if (OPT.dryRun) {
      info(`folder: ${destExists ? 'sẽ GHI ĐÈ' : 'sẽ copy'}  (${srcDir})`);
      summary.copied += 1;
    } else {
      try {
        if (destExists) fs.rmSync(destDir, { recursive: true, force: true });
        copyProfile(srcDir, destDir);
        ok(`   folder: đã copy → ${destDir}`);
        summary.copied += 1;
      } catch (e) {
        bad(`   folder: copy lỗi — ${e.message}`);
        continue; // không copy được thì đừng tạo bản ghi "logged in" giả
      }
    }

    // --- 2) Bản ghi tài khoản ---
    const existing = byKey.get(key);
    if (existing && existing.platform === 'facebook' && !OPT.force) {
      info('record: đã có → bỏ qua (dùng --force để cập nhật meta)');
      summary.skippedRecord += 1;
      continue;
    }

    const record = {
      platform: 'facebook',
      key,
      name: (m.name || existing?.name || key).toString().trim(),
      saleworkName: '',
      fbName: (m.name || existing?.fbName || '').toString().trim(),
      email: (m.email || existing?.email || '').toString().trim(),
      // Import mật khẩu để re-login tự điền form (parity với Xeko). Bỏ bằng --no-password.
      password: OPT.noPassword ? '' : (m.password || existing?.password || ''),
      // Device fingerprint đã lưu bên Xeko (nếu có) -> mi mở browser GIỐNG thiết bị Xeko cho
      // cùng account. Thiếu thì để trống, browser.js tự suy ra tất định theo key (vẫn khớp Xeko).
      userAgent: (m.userAgent || existing?.userAgent || '').toString().trim(),
      viewport: (m.viewport && typeof m.viewport.width === 'number' && typeof m.viewport.height === 'number')
        ? { width: m.viewport.width, height: m.viewport.height }
        : (existing?.viewport || undefined),
      phone: (existing?.phone || '').toString().trim(),
      staffId: existing?.staffId != null ? String(existing.staffId).trim() : '',
      brand: existing?.brand != null ? String(existing.brand).trim().toUpperCase() : '',
      autoEnabled: OPT.enableAuto,
      notifyTarget: existing?.notifyTarget === 'personal' ? 'personal' : 'group',
      proxy: (m.proxy || existing?.proxy || '').toString().trim(),
      createdAt: existing?.createdAt || nowIso,
      updatedAt: existing ? nowIso : undefined,
    };
    // Đóng dấu mốc auto để bot chỉ báo đơn về TỪ BÂY GIỜ (không blast tồn đọng cũ).
    if (OPT.enableAuto) record.autoEnabledAt = nowIso;

    if (OPT.dryRun) {
      const fpNote = record.userAgent
        ? ` fingerprint=meta(${record.viewport ? `${record.viewport.width}x${record.viewport.height}` : 'UA'})`
        : ' fingerprint=suy-ra-theo-key';
      info(`record: ${existing ? 'sẽ CẬP NHẬT' : 'sẽ THÊM'}  name="${record.name}"`
        + `${record.proxy ? ` proxy=${record.proxy}` : ''}${record.email ? ` email=${record.email}` : ''}`
        + ` autoEnabled=${record.autoEnabled}${fpNote}`);
      existing ? (summary.updated += 1) : (summary.added += 1);
      continue;
    }

    if (existing) { byKey.set(key, { ...existing, ...record }); summary.updated += 1; }
    else { byKey.set(key, record); summary.added += 1; }
  }

  // --- Ghi file tài khoản (1 lần) ---
  if (!OPT.dryRun && (summary.added || summary.updated)) {
    const next = Array.from(byKey.values());
    const dir = path.dirname(miConfig.zaloAccountsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(miConfig.zaloAccountsFile, JSON.stringify(next, null, 2));
    ok(`Đã ghi ${next.length} tài khoản → ${miConfig.zaloAccountsFile}`);
  }

  log('');
  log('──────── TỔNG KẾT ────────');
  log(`Profile copy   : ${summary.copied} (bỏ qua ${summary.skippedFolder})`);
  log(`Tài khoản thêm : ${summary.added} | cập nhật ${summary.updated} | bỏ qua ${summary.skippedRecord}`);
  if (OPT.dryRun) log('(DRY-RUN — chưa ghi gì. Bỏ --dry-run để thực thi.)');
  else {
    log('');
    log('Bước tiếp theo:');
    log('  1) Khởi động lại local-runner nếu đang chạy (để đọc zalo-accounts.json mới).');
    log('  2) Vào dashboard mi → tài khoản Facebook phải hiện, cờ "đã đăng nhập" = có.');
    log('  3) Bấm "Kiểm tra" (POST /api/accounts/:key/check) để xác nhận session còn sống.');
    if (!OPT.enableAuto) log('  4) Bật "Tự động báo" cho từng tài khoản khi đã sẵn sàng (mặc định đang TẮT).');
  }
}

try {
  main();
} catch (e) {
  bad(`Lỗi: ${e.message}`);
  process.exit(1);
}
