'use strict';
/**
 * Kiểm tra "mi có TỰ ĐỘNG báo hàng khi không mở app không" — soi CẢ 2 đầu trong 1 lần chạy:
 *   1) local-runner (máy có Chrome)  : /health — runner còn sống? đang ở TEST_MODE?
 *   2) server cloud (ai.basso.vn)    : /api/health — AUTO_NOTIFY bật chưa? cloud có "thấy"
 *      runner đã đăng ký (heartbeat còn tươi) không? runner online từ phía cloud không?
 *
 * Vì sao cần cả 2: bộ "tự động" (poller) chạy TRÊN CLOUD; còn việc gửi Zalo chạy DƯỚI runner.
 * Cầu nối là heartbeat start.js (POST /api/register-local mỗi 30s). Thiếu 1 mắt xích nào thì
 * "không mở app vẫn báo hàng" sẽ KHÔNG chạy — script này chỉ thẳng mắt xích đang hỏng.
 *
 * Chạy:  npm run check
 *   Tuỳ chọn override (mặc định đọc .env): API_KEY, LOCAL_PORT/PLAYWRIGHT_LOCAL_URL, REMOTE_BOT_URL
 *   Hoặc truyền cờ:  node scripts/health-check.js --local=http://localhost:8090 --remote=https://ai.basso.vn/b/xxxx
 *
 * CHỈ ĐỌC: không gửi Zalo, không đổi cấu hình, không đụng dữ liệu.
 */
const fetch = require('node-fetch');
const config = require('../server/config');

const ok = (s) => console.log(`✅ ${s}`);
const bad = (s) => console.log(`❌ ${s}`);
const warn = (s) => console.log(`⚠️  ${s}`);
const info = (s) => console.log(`   ${s}`);

/** Đọc cờ dạng --key=value từ argv (ưu tiên hơn .env). */
function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

/** URL base của local-runner: cờ --local > PLAYWRIGHT_LOCAL_URL > http://localhost:LOCAL_PORT. */
function localBase() {
  const explicit = arg('local') || (process.env.PLAYWRIGHT_LOCAL_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = parseInt(process.env.LOCAL_PORT || '8090', 10) || 8090;
  return `http://localhost:${port}`;
}

/** URL server cloud: cờ --remote > REMOTE_BOT_URL. '' nếu không cấu hình (bỏ qua bước cloud). */
function remoteBase() {
  return (arg('remote') || process.env.REMOTE_BOT_URL || '').trim().replace(/\/$/, '');
}

/** GET JSON với timeout + x-api-key. Trả { ok, status, json, error, raw }. */
async function getJson(url, { apiKey } = {}) {
  try {
    const res = await fetch(url, {
      timeout: 8000,
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* không phải JSON */ }
    return { ok: res.ok, status: res.status, json, raw: text };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

/** Chẩn đoán lỗi kết nối thường gặp thành câu tiếng Việt. */
function diagnose(r) {
  const m = String((r && r.error) || '').toLowerCase();
  if (/econnrefused/.test(m)) return 'Cổng đóng / tiến trình không chạy (ECONNREFUSED).';
  if (/enotfound|eai_again/.test(m)) return 'Không phân giải được tên miền (kiểm tra URL).';
  if (/etimedout|timeout|network|socket/.test(m)) return 'Quá thời gian chờ / mạng (firewall hoặc chưa mở/forward cổng).';
  if (r && r.status && r.status >= 400) return `HTTP ${r.status}` + (r.json && r.json.error ? ` — ${r.json.error}` : '');
  return (r && r.error) || 'lỗi không xác định';
}

function fmtAge(ms) {
  if (ms == null) return '(chưa từng)';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s trước`;
  return `${Math.round(s / 60)} phút trước`;
}

(async () => {
  console.log('=== Kiểm tra tự-động-báo-hàng của mi (2 đầu: runner + cloud) ===\n');

  // Trạng thái tổng hợp để ra kết luận cuối.
  const st = {
    runnerAlive: false, runnerTestMode: false, runnerTestPhones: [],
    cloudReachable: false, autoEnabled: false, autoRunning: false, autoLastRun: null,
    cloudSeesRunner: false, registerFresh: false, registerAgeMs: null, registerUrl: '',
  };

  // ---------------- 1) LOCAL-RUNNER (máy có Chrome) ----------------
  const lbase = localBase();
  console.log(`[1/2] Local-runner: ${lbase}`);
  const lh = await getJson(`${lbase}/health`, { apiKey: config.apiKey });
  if (lh.ok && lh.json) {
    st.runnerAlive = true;
    st.runnerTestMode = !!lh.json.testMode;
    st.runnerTestPhones = lh.json.testPhones || [];
    ok(`Runner SỐNG (service=${lh.json.service || '?'}).`);
    if (st.runnerTestMode) {
      warn(`Đang ở TEST_MODE — CHỈ gửi tới: ${st.runnerTestPhones.join(', ') || '(trống → không gửi cho ai!)'}`);
      info('Khách thật ngoài danh sách này sẽ KHÔNG nhận tin. Tắt TEST_MODE khi chạy thật.');
    } else {
      info('TEST_MODE tắt → gửi tới khách thật.');
    }
  } else {
    bad('Runner KHÔNG phản hồi.');
    info('Nguyên nhân: ' + diagnose(lh));
    info('Sửa: chạy `node start.js` (KHÔNG chỉ `node local-runner/index.js`) trên máy có Chrome,');
    info('     kiểm tra đúng LOCAL_PORT/PLAYWRIGHT_LOCAL_URL, và runner chưa bị tắt.');
  }

  // ---------------- 2) SERVER CLOUD (ai.basso.vn) ----------------
  const rbase = remoteBase();
  console.log(`\n[2/2] Server cloud: ${rbase || '(chưa đặt REMOTE_BOT_URL — bỏ qua)'}`);
  if (!rbase) {
    warn('Không có REMOTE_BOT_URL để hỏi cloud. Đây là nơi poller "tự động báo hàng" chạy.');
    info('Đặt REMOTE_BOT_URL trong .env (vd https://ai.basso.vn/b/xxxx) rồi chạy lại,');
    info('hoặc mở thẳng <cloud>/api/health trong trình duyệt đang đăng nhập ai.basso.vn.');
  } else {
    const ch = await getJson(`${rbase}/api/health`);
    if (ch.ok && ch.json) {
      st.cloudReachable = true;
      const an = ch.json.autoNotify || {};
      const lr = ch.json.localRunner || {};
      const reg = lr.registered || {};
      st.autoEnabled = !!an.enabled;
      st.autoRunning = !!an.running;
      st.autoLastRun = an.lastRun || null;
      st.cloudSeesRunner = !!lr.online;
      st.registerFresh = !!reg.fresh;
      st.registerAgeMs = reg.ageMs != null ? reg.ageMs : null;
      // CHỈ dựa vào registered.url để biết runner có tự đăng ký chưa. KHÔNG dùng localRunner.url
      // vì đó là URL "hiệu lực" — khi chưa đăng ký nó fallback về PLAYWRIGHT_LOCAL_URL tĩnh, sẽ
      // khiến ta nhầm là "đã đăng ký". Giữ url tĩnh riêng để hiển thị tham khảo.
      st.registerUrl = reg.url || '';
      st.effectiveUrl = lr.url || '';

      ok('Cloud phản hồi /api/health.');

      // 2a) Poller tự động
      if (st.autoEnabled) {
        ok(`AUTO_NOTIFY = BẬT (quét mỗi ${Math.round((an.intervalMs || 0) / 1000)}s, profile=${an.profile || '?'}).`);
        info(`Lượt quét gần nhất: ${st.autoLastRun || '(chưa chạy lượt nào)'}` + (st.autoRunning ? ' · đang chạy 1 lượt' : ''));
        if (an.lastResult && (an.lastResult.sent != null)) {
          const r = an.lastResult;
          info(`Kết quả lượt gần nhất: gửi ${r.sent || 0} ✅ / lỗi ${r.failed || 0} ❌ (quét ${r.scanned || 0} đơn)`);
        }
      } else {
        bad('AUTO_NOTIFY = TẮT → cloud sẽ KHÔNG tự quét & gửi khi không ai bấm.');
        info('Bật bằng nút "Tự động báo hàng" ở trang Settings, hoặc đặt AUTO_NOTIFY=true rồi restart server.');
      }

      // 2b) Cloud có GỌI TỚI runner được không (đây mới là điều kiện để đẩy job xuống).
      //     Online có thể nhờ heartbeat (registered.url tươi) hoặc nhờ URL tĩnh PLAYWRIGHT_LOCAL_URL.
      if (st.cloudSeesRunner) {
        if (st.registerUrl && st.registerFresh) {
          ok(`Cloud GỌI ĐƯỢC runner — đăng ký qua heartbeat: ${st.registerUrl} (${fmtAge(st.registerAgeMs)}).`);
        } else {
          ok(`Cloud GỌI ĐƯỢC runner qua URL tĩnh: ${st.effectiveUrl}.`);
          warn('Đang dùng PLAYWRIGHT_LOCAL_URL tĩnh (chưa qua heartbeat). Nếu server & runner KHÁC máy,');
          info('nên chạy runner bằng `node start.js` để tự đăng ký URL — đổi IP/tunnel không phải sửa .env.');
        }
      } else if (st.registerUrl && !st.registerFresh) {
        bad(`Runner từng đăng ký nhưng heartbeat CŨ (${fmtAge(st.registerAgeMs)}) → cloud coi như offline.`);
        info('Runner có thể đã tắt / mất mạng / start.js ngừng heartbeat. Chạy lại `node start.js`.');
      } else if (!st.registerUrl) {
        bad('Cloud KHÔNG gọi được runner: chưa nhận đăng ký nào & URL tĩnh cũng không probe được.');
        info('Runner phải chạy qua `node start.js` để POST /api/register-local lên cloud —');
        info('chạy thẳng `node local-runner/index.js` thì runner sống nhưng cloud KHÔNG biết địa chỉ.');
      } else {
        bad('Cloud không probe được runner (có đăng ký nhưng /health tới runner thất bại).');
        info('Kiểm tra cổng runner có mở/forward ra ngoài để cloud gọi vào được không.');
      }
    } else if (/<!doctype|<html/i.test(ch.raw || '')) {
      warn('Cloud trả về trang HTML (nhiều khả năng trang đăng nhập gateway ai.basso.vn).');
      info('Mở thẳng <cloud>/api/health trong trình duyệt ĐANG đăng nhập để xem JSON, hoặc chạy script này TỪ máy runner.');
    } else {
      bad('Không hỏi được cloud /api/health.');
      info('Nguyên nhân: ' + diagnose(ch));
    }
  }

  // ---------------- KẾT LUẬN ----------------
  console.log('\n=== KẾT LUẬN: không mở app thì có tự báo hàng không? ===');
  const missing = [];
  if (rbase) {
    if (!st.cloudReachable) missing.push('cloud không hỏi được (không xác nhận được poller)');
    else {
      if (!st.autoEnabled) missing.push('bật AUTO_NOTIFY trên cloud');
      if (!st.cloudSeesRunner) missing.push('cloud gọi được runner (chạy start.js để đăng ký, hoặc mở/forward cổng)');
    }
  } else {
    missing.push('đặt REMOTE_BOT_URL để xác nhận trạng thái poller trên cloud');
  }
  if (!st.runnerAlive) missing.push('bật local-runner (máy có Chrome đã đăng nhập Zalo)');

  const willAutoSend = st.runnerAlive && st.cloudReachable && st.autoEnabled && st.cloudSeesRunner;
  if (willAutoSend) {
    ok('CÓ — đủ điều kiện: cloud tự quét (AUTO_NOTIFY bật) + thấy runner online. Không cần mở dashboard.');
    if (st.runnerTestMode) warn('Nhưng đang TEST_MODE → thực tế chỉ gửi cho SĐT test, không phải khách thật.');
    process.exit(0);
  } else {
    bad('CHƯA chắc tự báo được. Còn thiếu: ' + missing.join('; ') + '.');
    info('Đủ 3 điều kiện mới tự chạy: (1) AUTO_NOTIFY bật trên cloud, (2) start.js đăng ký runner lên cloud, (3) runner có Chrome đã login Zalo.');
    process.exit(1);
  }
})();
