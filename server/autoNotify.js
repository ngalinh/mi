'use strict';
const config = require('./config');
const { getOrders } = require('./bassoApi');
const { notifyOne } = require('./notifyService');
const { getAutoRecord, recordAutoNotified, autoKey, getSetting, setSetting } = require('./db');
const { checkLocalHealth } = require('./playwrightProxy');
const { withLock } = require('./lock');
const { resolveForOrder } = require('./accountResolver');

/**
 * TỰ ĐỘNG BÁO HÀNG.
 *
 * Cứ có đơn ở trạng thái "Chưa báo" (not_sent = hàng đã về kho nhưng chưa nhắn khách)
 * thì tự build tin nhắn + gửi qua Zalo, không cần bấm tay trên dashboard.
 *
 * 2 cách kích hoạt, dùng chung 1 hàm runAutoNotify():
 *   1) Poller định kỳ (startAutoNotify) — server tự quét mỗi `intervalMs`.
 *   2) Webhook /api/webhook/arrived — website Basso gọi sang để gửi NGAY khi có hàng về.
 *
 * Chống gửi trùng: bảng `auto_notified` (SQLite), khóa theo customerId+dateInventory
 * (khóa ổn định của 1 dòng hàng về). Gửi thành công 1 lần là khóa lại; lỗi CẤP-ĐƠN thì
 * tăng attempts, quá `maxRetries` thì bỏ qua. Lỗi TẠM THỜI (runner offline/timeout) KHÔNG
 * trừ attempts và dừng lượt — để thử lại nguyên vẹn khi runner online lại.
 */

const cfg = config.autoNotify;

// Khoá lưu giờ gửi cố định trong app_settings (admin đổi trên trang Cài đặt -> ghi đè env).
const SCHEDULE_SETTING_KEY = 'autoNotify.scheduleTime';
// Khoá lưu "nhắc soạn ND trước bao nhiêu phút" (số nguyên phút; 0 = tắt nhắc).
const PRECHECK_SETTING_KEY = 'autoNotify.precheckMinutes';

/** Chuẩn hoá số phút nhắc-trước: số nguyên 0..1439, ngoài range/không parse -> null. Trống -> null. */
function normalizeMinutes(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 1439) return null;
  return n;
}

/** Số phút trong ngày -> 'HH:MM'. */
function minutesToHHMM(mins) {
  const mm = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

/**
 * Chuẩn hoá chuỗi giờ "HH:MM" (24h). Trả:
 *   - ''      : trống -> TẮT hẹn giờ (quay lại gửi ngay theo interval)
 *   - 'HH:MM' : hợp lệ, đã đệm 0
 *   - null    : SAI định dạng (để nơi gọi báo lỗi)
 */
function normalizeTime(value) {
  if (value == null) return '';
  const t = String(value).trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * Lấy "ngày" (YYYY-MM-DD) và "số phút trong ngày" theo múi giờ cfg.timezone cho 1 mốc thời gian.
 * Dùng Intl (built-in) để quy đổi — không phụ thuộc giờ máy chủ (thường UTC). Lỗi tz -> UTC.
 */
function localParts(date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  } catch (_) {
    // Múi giờ không hợp lệ -> rơi về UTC để vẫn chạy được.
    return { day: date.toISOString().slice(0, 10), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

// Giờ gửi cố định lúc khởi động: ưu tiên giá trị admin đã lưu (DB), rồi tới mặc định env.
// Giá trị DB sai định dạng (không nên xảy ra) -> bỏ, dùng env.
function initialScheduleTime() {
  let saved = null;
  try { saved = getSetting(SCHEDULE_SETTING_KEY); } catch (_) { saved = null; }
  if (saved != null) {
    const norm = normalizeTime(saved);
    if (norm !== null) return norm;
  }
  const fromEnv = normalizeTime(cfg.scheduleTime);
  return fromEnv === null ? '' : fromEnv;
}

// Số phút nhắc-trước lúc khởi động: giá trị admin đã lưu (DB) -> env -> mặc định 30.
function initialPrecheckMinutes() {
  let saved = null;
  try { saved = getSetting(PRECHECK_SETTING_KEY); } catch (_) { saved = null; }
  if (saved != null) { const n = normalizeMinutes(saved); if (n != null) return n; }
  const envN = normalizeMinutes(cfg.precheckMinutes);
  return envN == null ? 30 : envN;
}

// Trạng thái runtime (dùng cho /api/auto-notify + dashboard)
const state = {
  enabled: cfg.enabled,
  running: false,
  lastRun: null,       // ISO time của lần chạy gần nhất
  lastResult: null,    // tóm tắt lần chạy gần nhất
  startedAt: null,
  scheduleTime: initialScheduleTime(), // '' = gửi ngay (interval); 'HH:MM' = hẹn giờ
  lastScheduledDay: null,              // YYYY-MM-DD (giờ VN) của lần chạy-theo-lịch gần nhất
  precheckMinutes: initialPrecheckMinutes(), // nhắc soạn ND trước giờ gửi (phút); 0 = tắt
  lastPrecheckDay: null,               // YYYY-MM-DD của lần nhắc gần nhất (1 lần/ngày)
  lastPrecheck: null,                  // kết quả nhắc gần nhất (để hiện trên Cài đặt)
};

let timer = null;

/**
 * Tới giờ hẹn chưa? (chạy MỖI scheduleCheckMs). Chỉ gọi Basso khi ĐÃ tới giờ và CHƯA chạy hôm
 * nay -> mỗi ngày đúng 1 lượt gửi. Nếu server khởi động lại SAU giờ hẹn mà hôm đó chưa chạy,
 * lượt này vẫn nổ để "gửi bù" — an toàn vì dedup (auto_notified) chặn gửi trùng khách.
 */
function scheduleTick() {
  if (!state.scheduleTime) return;
  const { day, minutes } = localParts(new Date());
  const [h, m] = state.scheduleTime.split(':').map(Number);
  const target = h * 60 + m;

  // NHẮC SOẠN ND: trước giờ gửi `precheckMinutes` phút, quét (đọc tươi) & cảnh báo đơn thiếu ND.
  // Chạy 1 lần/ngày trong khung [target-lead, target) — sau giờ gửi thì thôi (lượt gửi tự xử lý).
  const lead = state.precheckMinutes;
  if (lead > 0) {
    const precheckAt = target - lead;
    if (precheckAt >= 0 && minutes >= precheckAt && minutes < target && state.lastPrecheckDay !== day) {
      state.lastPrecheckDay = day;
      runPrecheck(day);
    }
  }

  // GỬI đúng giờ (1 lần/ngày).
  if (minutes >= target && state.lastScheduledDay !== day) {
    state.lastScheduledDay = day;
    console.log(`[auto-notify] tới giờ ${state.scheduleTime} (${cfg.timezone}) — chạy lượt gửi theo lịch cho ngày ${day}.`);
    runAutoNotify({ trigger: 'scheduled' });
  }
}

/**
 * NHẮC SOẠN ND (không gửi): quét tươi, ghi cảnh báo số đơn còn thiếu nội dung báo hàng + lưu kết
 * quả vào state.lastPrecheck để trang Cài đặt hiển thị. Chạy trước giờ gửi để NV kịp soạn nốt.
 */
async function runPrecheck(day) {
  try {
    const p = await previewAutoNotify();
    state.lastPrecheck = {
      at: new Date().toISOString(),
      day,
      scheduleTime: state.scheduleTime,
      scanned: p.scanned,
      ready: p.ready,
      missingContent: p.missingContent,
      alreadyHandled: p.alreadyHandled,
      missingList: p.missingList,
      runnerOnline: p.runnerOnline,
    };
    if (p.missingContent > 0) {
      const names = p.missingList.slice(0, 20)
        .map((o) => `${o.customerName || o.orderCode || '?'}${o.staff ? ` (${o.staff})` : ''}`).join(', ');
      console.warn(`[auto-notify] NHẮC (trước giờ gửi ${state.scheduleTime}): ${p.missingContent} đơn CHƯA có ND báo hàng — sẽ bị bỏ qua nếu không soạn kịp: ${names}`);
    } else {
      console.log(`[auto-notify] NHẮC (trước giờ gửi ${state.scheduleTime}): ${p.ready} đơn đã đủ ND, không đơn nào thiếu ✅`);
    }
  } catch (e) {
    console.warn('[auto-notify] nhắc soạn ND lỗi:', e.message);
  }
}

/** Tóm tắt tình trạng hẹn giờ cho dashboard/Cài đặt. */
function scheduleInfo() {
  if (!state.scheduleTime) return { mode: 'interval', scheduleTime: '', precheckMinutes: state.precheckMinutes };
  const { day, minutes } = localParts(new Date());
  const [h, m] = state.scheduleTime.split(':').map(Number);
  const target = h * 60 + m;
  const ranToday = state.lastScheduledDay === day;
  let next; // trạng thái lượt kế: đã gửi hôm nay | chờ tới giờ hôm nay | (đã qua giờ) gửi ngay/mai
  if (ranToday) next = 'done_today';
  else if (minutes < target) next = 'today';
  else next = 'due';
  const lead = state.precheckMinutes;
  const precheckAt = lead > 0 && target - lead >= 0 ? minutesToHHMM(target - lead) : '';
  return {
    mode: 'scheduled', scheduleTime: state.scheduleTime, timezone: cfg.timezone, ranToday, next,
    precheckMinutes: lead, precheckTime: precheckAt,
  };
}

/** Lỗi tạm thời (runner down / mạng / timeout) — KHÔNG nên trừ lượt thử của đơn. */
function isTransientError(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('econnrefused') || m.includes('local-runner') ||
    m.includes('timeout') || m.includes('hết thời gian') ||
    m.includes('network') || m.includes('fetch failed') ||
    m.includes('socket') || m.includes('etimedout')
  );
}

/**
 * Quy 1 mốc thời gian về "số ngày" (bucket theo UTC) để so sánh ngày, không lệ thuộc giờ:
 *   - unix giây (date_inventory của Basso, vd 1780531200) hoặc unix ms
 *   - chuỗi ISO (autoEnabledAt)
 * Trả null nếu không parse được. date_inventory là nửa đêm UTC của ngày hàng về nên so bucket
 * ngày là chuẩn: đơn về CÙNG ngày bật auto vẫn được gửi, chỉ đơn về TRƯỚC ngày đó bị bỏ.
 */
function dayBucket(value) {
  if (value == null || value === '') return null;
  let ms;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    ms = n < 1e12 ? n * 1000 : n; // giây -> ms
  } else {
    const t = Date.parse(value);
    if (Number.isNaN(t)) return null;
    ms = t;
  }
  return Math.floor(ms / 86400000);
}

/** Đơn có đủ điều kiện tự gửi không? */
function isCandidate(order) {
  if (order.statusCode !== 'not_sent') return false; // chỉ "Chưa báo"
  // Chỉ tự gửi khi Basso ĐÃ soạn sẵn "ND báo hàng" (raw.content). Đơn trống nội
  // dung -> bỏ qua hoàn toàn, KHÔNG dùng template mặc định để tránh gửi câu chung chung.
  if (!order.noiDungBaoHang || !String(order.noiDungBaoHang).trim()) return false;
  const rec = getAutoRecord(autoKey(order));
  if (!rec) return true;
  // Đã gửi (bot 'success' hoặc đã báo tay 'manual') -> bot không gửi lại.
  if (rec.status === 'success' || rec.status === 'manual') return false;
  return rec.attempts < cfg.maxRetries;               // 'failed' -> còn lượt thử lại
}

/**
 * Lấy TẤT CẢ đơn "Chưa báo" qua mọi trang (vì không cập nhật web nên tập này không tự co lại).
 * @param {object} [opts] { fresh } — fresh=true: đọc tươi từ Basso, bỏ qua cache (dùng cho webhook
 *   để thấy NGAY đơn vừa về, không bị cache 30s che). Poller thường dùng cache cho nhẹ.
 */
async function fetchAllNotSent(opts = {}) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { orders, total } = await getOrders({ status: 'not_sent', page, pageSize: 100, fresh: !!opts.fresh });
    for (const o of orders) {
      const k = autoKey(o);
      if (!seen.has(k)) { seen.add(k); all.push(o); }
    }
    if (orders.length < 100) break;                 // hết trang
    if (total != null && all.length >= total) break; // đã lấy đủ
  }
  return all;
}

/**
 * Quét đơn "Chưa báo" và tự gửi. An toàn khi gọi song song (có khóa `running`).
 * @param {object} [opts] { trigger?: 'interval'|'webhook'|'manual' }
 * @returns {Promise<object>} tóm tắt { trigger, scanned, candidates, sent, failed, skipped, results }
 */
async function runAutoNotify(opts = {}) {
  const trigger = opts.trigger || 'manual';
  // Chế độ HẸN GIỜ: "có hàng về" (webhook) chỉ để cập nhật — KHÔNG gửi ngay. Cả ngày gom lại,
  // đúng giờ (trigger 'scheduled') mới gửi. Nút "Quét & gửi ngay" (trigger 'manual') vẫn gửi
  // được ngay vì đó là hành động chủ đích của admin.
  if (trigger === 'webhook' && state.scheduleTime) {
    return {
      trigger, skipped: true, deferred: true, scheduleTime: state.scheduleTime,
      reason: `Đã hẹn giờ gửi lúc ${state.scheduleTime} (${cfg.timezone}) — không gửi ngay khi có hàng về`,
    };
  }
  if (state.running) {
    return { trigger, skipped: true, reason: 'Đang chạy một lượt khác' };
  }
  state.running = true;
  const summary = { trigger, scanned: 0, candidates: 0, sent: 0, failed: 0, results: [] };
  try {
    // R4: runner offline thì bỏ cả lượt, KHÔNG trừ attempts (tránh "bỏ cuộc" oan).
    const online = await checkLocalHealth();
    if (!online) {
      summary.skipped = true;
      summary.reason = 'local-runner offline';
      console.warn(`[auto-notify:${trigger}] bỏ lượt — local-runner offline (không trừ lượt thử).`);
      return summary;
    }

    // R6: bọc quét + gửi trong khóa dùng chung -> không chạy chồng với báo-tay (notifyMany).
    // Đặt quét đơn TRONG khóa để thấy trạng thái mới nhất sau khi luồng kia vừa gửi xong.
    await withLock(async () => {
      // Đọc TƯƠI (bỏ cache) cho:
      //  - webhook "vừa có hàng về" -> thấy ngay đơn mới;
      //  - lượt gửi theo lịch (scheduled) -> lấy ND báo hàng MỚI NHẤT do Basso/NV vừa soạn phút
      //    chót, không dính cache 30s (tránh bỏ sót đơn vừa được soạn nội dung).
      // Poller định kỳ (interval) vẫn dùng cache cho nhẹ.
      const orders = await fetchAllNotSent({ fresh: trigger === 'webhook' || trigger === 'scheduled' });
      summary.scanned = orders.length;
      // Đơn "Chưa báo" nhưng Basso chưa soạn "ND báo hàng" -> bỏ qua (không gửi).
      summary.skippedNoContent = orders.filter(
        (o) => o.statusCode === 'not_sent' && !(o.noiDungBaoHang && String(o.noiDungBaoHang).trim()),
      ).length;
      const candidates = orders.filter(isCandidate);
      summary.candidates = candidates.length;

      for (const order of candidates) {
        const key = autoKey(order);
        const prev = getAutoRecord(key);

        // MÔ HÌNH B: nếu account của NV phụ trách bị TẮT "Tự động báo" (autoEnabled=false)
        // thì bỏ qua đơn này (không gửi, không trừ lượt) — để NV tự báo tay.
        // eslint-disable-next-line no-await-in-loop
        const acct = await resolveForOrder(order, { defaultAccount: cfg.account, profile: cfg.profile });

        // CÔ LẬP THEO NV: chỉ gửi đơn khớp đúng 1 account (source='store'). Đơn không khớp
        // account nào (rơi về 'default'/legacy) -> BỎ QUA. Bật auto cho 1 account là chỉ NV đó
        // được gửi, còn lại tự động bỏ (không cần đi tắt từng account chưa map).
        if (cfg.requireAccount && acct.source !== 'store') {
          summary.skippedNoAccount = (summary.skippedNoAccount || 0) + 1;
          continue;
        }
        if (acct.source === 'store' && acct.autoEnabled === false) {
          summary.skippedAutoOff = (summary.skippedAutoOff || 0) + 1;
          continue;
        }
        // HƯỚNG A: NV có gắn brand nhưng không có Zalo cho brand của đơn này -> bỏ qua (KHÔNG gửi,
        // KHÔNG trừ lượt) để NV báo tay, tránh gửi nhầm brand.
        if (acct.skip && acct.skipReason === 'brand') {
          summary.skippedBrand = (summary.skippedBrand || 0) + 1;
          continue;
        }

        // CHỈ BÁO ĐƠN VỀ TỪ KHI BẬT AUTO: đơn về TRƯỚC ngày account được bật "Tự động báo"
        // (autoEnabledAt) -> bỏ qua, KHÔNG gửi & KHÔNG trừ lượt -> tránh nhắn trùng loạt khách
        // cũ đã xử lý tay. Bỏ qua lọc khi tắt qua AUTO_NOTIFY_ONLY_NEW=false hoặc account chưa
        // có mốc (autoEnabledAt trống -> giữ hành vi cũ). Đơn không đọc được ngày -> vẫn gửi.
        if (cfg.onlyNewOrders && acct.source === 'store' && acct.autoEnabledAt) {
          const orderDay = dayBucket(order.dateInventory);
          const sinceDay = dayBucket(acct.autoEnabledAt);
          if (orderDay != null && sinceDay != null && orderDay < sinceDay) {
            summary.skippedBacklog = (summary.skippedBacklog || 0) + 1;
            continue;
          }
        }

        // eslint-disable-next-line no-await-in-loop
        const r = await notifyOne(order, {
          profile: cfg.profile,
          defaultAccount: cfg.account,   // fallback khi NV không có trong ZALO_ACCOUNT_MAP
          kind: 'hang',
          skipWebUpdate: !cfg.updateWeb, // mặc định đẩy trạng thái về web Basso (tắt qua AUTO_NOTIFY_UPDATE_WEB=false)
          strictMatch: true,             // R5: tự động -> chỉ gửi khi khớp chắc chắn, không "lấy đại"
          actor: 'bot',                  // audit: luồng tự động
        });

        // Phân loại lỗi để quyết định "dừng cả lượt" hay "tính 1 attempt rồi đi tiếp".
        // CHỈ coi là transient (dừng lượt, KHÔNG trừ lượt) khi runner THỰC SỰ offline — xác
        // nhận bằng health-check thay vì chỉ dò chữ trong message. Lỗi Playwright CẤP-ĐƠN (vd
        // mở hội thoại 1 khách bị "Timeout ... exceeded") cũng chứa chữ "timeout"; trước đây bị
        // hiểu nhầm là transient -> break bỏ dở cả lượt + đơn đó retry vô hạn (không tăng attempt).
        // eslint-disable-next-line no-await-in-loop
        const runnerDown = !r.ok && isTransientError(r.error) && !(await checkLocalHealth());
        if (r.ok) {
          recordAutoNotified(key, 'success', (prev ? prev.attempts : 0) + 1);
          summary.sent += 1;
        } else if (runnerDown) {
          // Runner sập / mạng tới runner đứt giữa chừng: không trừ lượt, dừng luôn để thử lại sau.
          summary.failed += 1;
          summary.results.push({ orderId: key, customerName: order.customerName, ok: false, transient: true, error: r.error });
          summary.stopped = 'local-runner offline giữa chừng';
          console.warn(`[auto-notify:${trigger}] dừng giữa chừng — runner offline: ${r.error}`);
          break;
        } else {
          // Lỗi cấp-đơn (runner vẫn sống, kể cả khi message có chữ "timeout"): tính 1 lượt thử,
          // ĐI TIẾP đơn khác thay vì bỏ dở cả lượt. Hết maxRetries thì thôi.
          recordAutoNotified(key, 'failed', (prev ? prev.attempts : 0) + 1);
          summary.failed += 1;
        }
        summary.results.push({
          orderId: key,
          customerName: order.customerName,
          ok: r.ok,
          error: r.error || r.updateError || null,
        });
      }

      if (candidates.length || summary.skippedNoContent) {
        const skipNo = summary.skippedNoContent ? `, bỏ qua ${summary.skippedNoContent} đơn trống ND` : '';
        const skipOff = summary.skippedAutoOff ? `, bỏ qua ${summary.skippedAutoOff} đơn (account tắt auto)` : '';
        const skipNoAcc = summary.skippedNoAccount ? `, bỏ qua ${summary.skippedNoAccount} đơn (không khớp account)` : '';
        const skipBrand = summary.skippedBrand ? `, bỏ qua ${summary.skippedBrand} đơn (NV chưa có Zalo cho brand)` : '';
        const skipBack = summary.skippedBacklog ? `, bỏ qua ${summary.skippedBacklog} đơn tồn đọng (về trước khi bật auto)` : '';
        console.log(`[auto-notify:${trigger}] gửi ${summary.sent} ✅ / ${summary.failed} ❌ (quét ${summary.scanned} đơn chưa báo${skipNo}${skipOff}${skipNoAcc}${skipBrand}${skipBack})`);
      }
    });
  } catch (err) {
    summary.error = err.message;
    console.error(`[auto-notify:${trigger}] lỗi:`, err.message);
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
    state.lastResult = summary;
  }
  return summary;
}

/** Bật/tắt poller lúc runtime (không cần restart). */
function setEnabled(enabled) {
  const on = !!enabled;
  if (on === state.enabled && (!on || timer)) return getStatus();
  state.enabled = on;
  if (on) startTimer(); else stopTimer();
  console.log(`[auto-notify] ${on ? 'BẬT' : 'TẮT'} (mỗi ${Math.round(cfg.intervalMs / 1000)}s)`);
  return getStatus();
}

function startTimer() {
  if (timer) return;
  state.startedAt = new Date().toISOString();
  if (state.scheduleTime) {
    // HẸN GIỜ: chỉ kiểm tra đồng hồ định kỳ (rẻ), tới giờ mới quét & gửi 1 lượt/ngày.
    // Kiểm tra sớm sau 5s để "gửi bù" nếu khởi động lại khi đã qua giờ hẹn mà hôm đó chưa chạy.
    setTimeout(scheduleTick, 5000);
    timer = setInterval(scheduleTick, cfg.scheduleCheckMs);
  } else {
    // GỬI NGAY (không hẹn giờ): chạy 1 lượt sau 5s rồi lặp theo interval như trước.
    setTimeout(() => { runAutoNotify({ trigger: 'interval' }); }, 5000);
    timer = setInterval(() => { runAutoNotify({ trigger: 'interval' }); }, cfg.intervalMs);
  }
  if (timer.unref) timer.unref();
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  state.startedAt = null;
}

/** Khởi động cùng server (nếu AUTO_NOTIFY=true). */
function startAutoNotify() {
  if (state.enabled) {
    startTimer();
    if (state.scheduleTime) {
      const pc = state.precheckMinutes > 0 ? `, nhắc soạn ND trước ${state.precheckMinutes} phút` : '';
      console.log(`[auto-notify] BẬT — HẸN GIỜ gửi lúc ${state.scheduleTime} (${cfg.timezone}) mỗi ngày${pc}, profile=${cfg.profile}`);
    } else {
      console.log(`[auto-notify] BẬT — GỬI NGAY, quét đơn "Chưa báo" mỗi ${Math.round(cfg.intervalMs / 1000)}s, profile=${cfg.profile}`);
    }
  } else {
    console.log('[auto-notify] TẮT (đặt AUTO_NOTIFY=true để bật, hoặc bật trên dashboard)');
  }
}

/**
 * Đặt GIỜ GỬI CỐ ĐỊNH lúc runtime (admin đổi trên trang Cài đặt). Lưu bền vào DB để giữ qua
 * restart. '' hoặc trống -> tắt hẹn giờ (quay lại gửi ngay theo interval). Ném lỗi .code='BAD_TIME'
 * nếu sai định dạng. Áp dụng NGAY: khởi động lại timer theo chế độ mới.
 */
function setScheduleTime(value) {
  const norm = normalizeTime(value);
  if (norm === null) {
    const e = new Error('Giờ không hợp lệ — cần định dạng HH:MM (00:00–23:59), vd 17:00. Để trống = gửi ngay.');
    e.code = 'BAD_TIME';
    throw e;
  }
  state.scheduleTime = norm;
  try { setSetting(SCHEDULE_SETTING_KEY, norm); } catch (err) {
    console.warn('[auto-notify] không lưu được giờ gửi vào DB:', err.message);
  }
  // Đổi giờ -> reset mốc "đã chạy hôm nay" (nếu đổi sang giờ đã qua & hôm nay chưa gửi, lượt kế
  // sẽ nổ; nếu hôm nay đã gửi rồi thì scheduleTick vẫn chặn theo lastScheduledDay lần kế đặt lại).
  // Thực tế: chỉ reset khi chuyển giờ để không kẹt trạng thái cũ.
  state.lastScheduledDay = null;
  // Áp dụng ngay: dựng lại timer theo chế độ mới (hẹn giờ <-> interval).
  if (state.enabled && timer) { stopTimer(); startTimer(); }
  console.log(`[auto-notify] đặt giờ gửi cố định = ${norm || '(trống → gửi ngay theo interval)'}`);
  return getStatus();
}

/**
 * Đặt SỐ PHÚT NHẮC SOẠN ND trước giờ gửi (0 = tắt nhắc). Lưu bền vào DB. Ném lỗi .code='BAD_PRECHECK'
 * nếu không hợp lệ (cần số nguyên 0–1439). Reset mốc "đã nhắc hôm nay" để áp dụng ngay hôm nay.
 */
function setPrecheckMinutes(value) {
  const n = normalizeMinutes(value);
  if (n === null) {
    const e = new Error('Số phút nhắc trước không hợp lệ — cần số nguyên 0–1439 (0 = tắt nhắc).');
    e.code = 'BAD_PRECHECK';
    throw e;
  }
  state.precheckMinutes = n;
  try { setSetting(PRECHECK_SETTING_KEY, String(n)); } catch (err) {
    console.warn('[auto-notify] không lưu được số phút nhắc vào DB:', err.message);
  }
  state.lastPrecheckDay = null; // cho phép nhắc lại hôm nay theo mốc mới
  console.log(`[auto-notify] đặt nhắc soạn ND trước giờ gửi = ${n} phút${n === 0 ? ' (TẮT nhắc)' : ''}`);
  return getStatus();
}

/**
 * XEM TRƯỚC (không gửi): quét "Chưa báo" và đếm bao nhiêu đơn ĐÃ đủ nội dung báo hàng (sẵn sàng
 * gửi) vs CHƯA có ND (sẽ bị bỏ qua tới giờ gửi). Dùng cho nút "Kiểm tra" trên Cài đặt để người
 * phụ trách soạn nốt ND trước giờ hẹn. Đọc TƯƠI (bỏ cache) để phản ánh đúng hiện trạng.
 */
async function previewAutoNotify() {
  const online = await checkLocalHealth().catch(() => false);
  const orders = await fetchAllNotSent({ fresh: true });
  let ready = 0;
  let missingContent = 0;
  let alreadyHandled = 0;
  const missingList = [];
  for (const o of orders) {
    const rec = getAutoRecord(autoKey(o));
    if (rec && (rec.status === 'success' || rec.status === 'manual')) { alreadyHandled += 1; continue; }
    const hasContent = o.noiDungBaoHang && String(o.noiDungBaoHang).trim();
    if (!hasContent) {
      missingContent += 1;
      if (missingList.length < 100) {
        missingList.push({ customerName: o.customerName || '', orderCode: o.orderCode || o.orderId || null, staff: o.staff || '' });
      }
      continue;
    }
    ready += 1;
  }
  return {
    scanned: orders.length,
    ready,
    missingContent,
    alreadyHandled,
    missingList,
    runnerOnline: online,
    scheduleTime: state.scheduleTime,
    timezone: cfg.timezone,
  };
}

function getStatus() {
  return {
    enabled: state.enabled,
    running: state.running,
    intervalMs: cfg.intervalMs,
    profile: cfg.profile,
    maxRetries: cfg.maxRetries,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    scheduleTime: state.scheduleTime,
    timezone: cfg.timezone,
    precheckMinutes: state.precheckMinutes,
    lastPrecheck: state.lastPrecheck,
    schedule: scheduleInfo(),
  };
}

module.exports = { runAutoNotify, startAutoNotify, setEnabled, setScheduleTime, setPrecheckMinutes, previewAutoNotify, getStatus, autoKey };
