(() => {
  let orders = [];        // đơn của TRANG đang hiển thị (đã lọc + phân trang)
  let allOrders = [];     // (client-mode) TOÀN BỘ đơn của khoảng ngày — để lọc NV/trạng thái/trang tại client
  let clientMode = false; // true = đã kéo đủ tập, lọc/phân trang tại client (click tức thì);
                          // false = fallback phân trang server (tập quá lớn / chưa kéo xong)
  let tabUsers = [];
  let currentStaff = ''; // user_id đang lọc ('' = tất cả)
  let currentGroup = 'todo'; // thẻ trạng thái đang xem ('todo' | 'arrival' | 'ship' | 'failed')
  let currentSendStatus = ''; // lọc theo TRẠNG THÁI GỬI TIN (lastReport): '' = tất cả | success | pending | failed | none
  let currentGroupBy = ''; // gom dòng: '' = không gom | 'date' = theo ngày | 'customer' = theo khách | 'channel' = theo kênh (NV)
  let currentPage = 1;     // trang hiện tại (server-side)
  const PAGE_SIZE = 20;    // số đơn mỗi trang (giống Basso: ~20/trang -> 1193 đơn = 60 trang)
  const COLSPAN = 13;      // số cột cho dòng full-width (chi tiết/nhóm/rỗng)
  const COLSPAN_CUST = 12; // nhóm theo KHÁCH: đã có 1 ô nút mở ở đầu
  let serverTotal = 0;     // tổng số đơn của trạng thái đang xem (do server trả)
  let pageCount = 1;       // tổng số trang hiện tại (client-mode: đếm theo NHÓM khi đang gom)
  // Chỉ còn dùng counts.todo (số "Chưa báo" all-time) cho nút Báo hàng loạt + dòng thông tin.
  // Các nhóm khác giữ lại cho tương thích code cũ (client-mode) nhưng không hiển thị nữa.
  let counts = { todo: 0, arrival: 0, ship: 0, failed: 0, total: 0 };
  // Nhóm trạng thái -> mã trạng thái Basso để lọc/phân trang server-side.
  const STATUS_FOR_GROUP = { todo: 'not_sent', arrival: 'notified_arrival', ship: 'notified_ship', failed: 'send_failed' };
  // Nhãn hiển thị của từng nhóm (dùng cho dòng thông tin + popover Bộ lọc).
  const GROUP_LABELS = { todo: 'Chưa báo', arrival: 'Đã báo hàng', ship: 'Đã báo ship', failed: 'Lỗi - Báo lại' };
  const openRows = new Set();
  const excluded = new Set(); // id các đơn bị TICK loại trừ (Delay) khỏi "Báo hàng loạt"
  // Đang có 1 phiên báo loạt chạy trên server hay không. Khi true, nút "Báo hàng loạt" đổi vai thành
  // nút "Dừng" (bấm -> /api/notify-all/stop) và render KHÔNG đè nhãn/disable của nút đó.
  let bulkSending = false;
  // Tab này "nhận" một phiên báo loạt đang chạy trên server mà KHÔNG phải do chính nó khởi động
  // (vd: vừa reload trang trong lúc loạt đang gửi). Khác `bulkSending` ở chỗ không có promise
  // bulkSend() đang await để tự khôi phục nút -> việc reset nút do health poll đảm nhiệm khi server
  // báo loạt đã xong. Khi bulkSending HOẶC bulkAdopted, nút "Báo hàng loạt" đóng vai nút "Dừng".
  let bulkAdopted = false;
  // Ghi chú đã GÕ nhưng CHƯA bấm lưu (id -> text). Giữ lại để auto-sync/đồng bộ
  // từ Basso không xoá mất phần đang soạn dở. Xoá khỏi map ngay khi lưu thành công.
  const dirtyNotes = new Map();

  // Bộ lọc nâng cao (popover): khoảng ngày + loại trừ/ghi chú (client-side).
  const F = { from: '', to: '', exclude: 'all', note: 'all' };

  // Phạm vi thời gian chọn qua selector #fScope trên toolbar (đầu ô tìm kiếm).
  // scopeDays = số ngày gần đây; 0 = "Tất cả" (mặc định). Khoảng ngày tường minh (F.from/F.to)
  // trong Bộ lọc nâng cao sẽ ghi đè scope.
  let scopeDays = 0; // mặc định: Tất cả (mọi ngày)

  // Gắn phạm vi ngày vào query gửi server: ưu tiên khoảng ngày tường minh (F.from/F.to);
  // nếu không có thì gửi ?days=scopeDays (bỏ qua khi =0 -> all-time).
  function applyScope(p) {
    if (F.from) p.set('from', F.from);
    if (F.to) p.set('to', F.to);
    if (!F.from && !F.to && scopeDays > 0) p.set('days', scopeDays);
    return p;
  }

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  const AUTO_SYNC_MS = 60000; // tự động đồng bộ danh sách mỗi 60 giây

  const DONE = new Set(['notified_arrival', 'notified_ship']);
  // "Đã báo" = web đã đánh dấu, HOẶC mi đã gửi (bot 'success' / đã báo tay 'manual').
  const SENT_LOCAL = new Set(['success', 'manual']);
  const isNotified = (o) => DONE.has(o.statusCode) || (o.autoNotified && SENT_LOCAL.has(o.autoNotified.status));
  // Vì sao 1 đơn bị coi là "đã báo" cho loại tin đang gửi (để cảnh báo khi gửi lẻ) — null nếu chưa báo.
  const notifiedReason = (o, kind = 'hang') => {
    const done = kind === 'ship' ? o.statusCode === 'notified_ship' : DONE.has(o.statusCode);
    if (done) return `web đang ở trạng thái "${o.status}"`;
    if (kind === 'ship') return null;
    if (o.autoNotified && o.autoNotified.status === 'success') return 'bot đã tự gửi';
    if (o.autoNotified && o.autoNotified.status === 'manual') return 'đã báo tay trước đó';
    return null;
  };
  const STATUS_OPTS = [
    ['not_sent', 'Chưa báo'],
    ['notified_arrival', 'Đã báo hàng'],
    ['notified_ship', 'Đã báo ship'],
    ['send_failed', 'Gửi lỗi'],
  ];
  // Lý do delay (lưu ở mi cùng cờ Loại trừ) cho đơn chưa báo ngay.
  // Các lý do dựng sẵn; ngoài ra có "Khác" cho phép nhập tự do.
  const DELAY_REASONS = ['Đợi bank', 'Đợi hàng về thêm', 'Khách hẹn'];
  const DELAY_OTHER = 'Khác';

  const byId = (id) => orders.find((o) => String(o.id) === String(id));

  // Gom đơn về 4 nhóm theo trạng thái báo.
  function groupOf(o) {
    if (o.statusCode === 'send_failed' || o.statusCode === 'error') return 'failed';
    if (o.statusCode === 'notified_ship') return 'ship';
    if (o.statusCode === 'notified_arrival') return 'arrival';
    if (o.autoNotified && SENT_LOCAL.has(o.autoNotified.status)) return 'arrival';
    return 'todo';
  }

  // Gửi đơn đầy đủ field lên server (không để server tra lại theo id).
  const orderCodeOf = (o) => {
    const items = o._items || [];
    const codes = [...new Set(items.map((it) => it.orderCode).filter(Boolean))];
    return codes.length ? codes.join(', ') : undefined;
  };
  const orderPayload = (o) => ({
    id: o.id, customerId: o.customerId, dateInventory: o.dateInventory,
    customerName: o.customerName, phone: o.phone, note: o.note, staff: o.staff,
    warehouseDate: o.warehouseDate, orderCode: orderCodeOf(o),
    noiDungBaoHang: o.noiDungBaoHang, noiDungBaoShip: o.noiDungBaoShip,
  });

  // ---------------- Tabs nhân viên ----------------
  // Đổ danh sách nhân viên vào dropdown #fStaff (thay hàng pill cũ cho gọn).
  function renderTabs() {
    const el = $('fStaff');
    if (!el) return;
    const list = tabUsers.slice().sort((a, b) =>
      String(a.name).localeCompare(String(b.name), 'vi', { sensitivity: 'base' }));
    const cur = String(currentStaff || '');
    el.innerHTML = `<option value="">Tất cả nhân viên</option>` + list.map((t) =>
      `<option value="${App.esc(t.user_id)}"${String(t.user_id) === cur ? ' selected' : ''}>${App.esc(t.name)}</option>`
    ).join('');
    el.value = cur; // giữ đúng lựa chọn kể cả khi option của NV đang chọn chưa có trong list
  }

  // ---------------- Render bảng ----------------
  function statusSelect(o) {
    const opts = STATUS_OPTS.map(([v, l]) =>
      `<option value="${v}" ${v === o.statusCode ? 'selected' : ''}>${l}</option>`).join('');
    return `<select class="status-sel" data-code="${App.esc(o.statusCode)}" data-id="${App.esc(o.id)}">${opts}</select>`;
  }

  // Dropdown lý do delay — chỉ hiện khi đơn đang bị Loại trừ (tick Delay).
  // Lý do không nằm trong danh sách dựng sẵn => coi là "Khác" (nhập tự do).
  function delayReasonTag(o) {
    if (!excluded.has(String(o.id))) return '';
    const cur = o.delayReason || '';
    const isPreset = DELAY_REASONS.includes(cur);
    const isOther = o._delayOther || (cur !== '' && !isPreset);
    const selVal = isPreset ? cur : (isOther ? DELAY_OTHER : '');
    const opts = DELAY_REASONS.map((r) =>
      `<option value="${App.esc(r)}" ${r === selVal ? 'selected' : ''}>${App.esc(r)}</option>`).join('');
    const otherInput = isOther
      ? `<input class="delay-other" data-id="${App.esc(o.id)}" value="${App.esc(isPreset ? '' : cur)}" placeholder="Nhập lý do..." title="Nhập lý do tạm hoãn" />`
      : '';
    return `<select class="delay-reason" data-id="${App.esc(o.id)}" title="Lý do tạm hoãn báo hàng">
      <option value="" ${selVal ? '' : 'selected'}>— Lý do delay —</option>${opts}<option value="${DELAY_OTHER}" ${selVal === DELAY_OTHER ? 'selected' : ''}>${DELAY_OTHER}</option></select>${otherInput}`;
  }

  // Mốc thời gian ĐÃ GỬI nằm DƯỚI dropdown trạng thái — mỗi loại 1 chip có màu:
  //   báo hàng (box, xanh dương) / báo ship (truck, xanh lá) từ Lịch sử báo (server enrich `sentAt`).
  // "Cách báo" (bot/thủ công/lỗi) vẫn xem được ở cột NGƯỜI GỬI + KẾT QUẢ GỬI + tooltip — nên bỏ icon
  // tay/bot ở đây cho gọn. Chưa có mốc nào từ lịch sử nhưng đã có hành động báo -> hiện mốc `at`.
  function reportMetaCell(o) {
    const a = o.autoNotified;
    const s = o.sentAt;
    // Tooltip cho mốc fallback (khi chỉ có dấu autoNotified, chưa có mốc từ Lịch sử báo).
    let title = '';
    if (a) {
      const when = a.at ? App.fmtDateTime(a.at) : '';
      if (a.status === 'success') title = `Bot tự động đã gửi${when ? ' lúc ' + when : ''}`;
      else if (a.status === 'manual') title = `Đã báo thủ công trong mi${when ? ' lúc ' + when : ''}`;
      else title = `Bot gửi lỗi ${a.attempts} lần${when ? ' · ' + when : ''}`;
    }
    const line = (ic, label, at, kind) => at
      ? `<span class="sent-time ${kind}" title="${label} lúc ${App.esc(App.fmtDateTime(at))}">${App.icon(ic)} ${App.esc(App.fmtShort(at))}</span>`
      : '';
    let times = s ? `${line('box', 'Đã gửi báo hàng', s.hang, 'hang')}${line('truck', 'Đã gửi báo ship', s.ship, 'ship')}` : '';
    // Chưa có mốc từ Lịch sử báo nhưng đã có hành động báo (thủ công/bot) -> vẫn hiện mốc `at`.
    if (!times && a && a.at) {
      times = `<span class="sent-time" title="${App.esc(title)}">${App.esc(App.fmtShort(a.at))}</span>`;
    }
    if (!times) return '';
    return `<div class="sent-times">${times}</div>`;
  }

  // ---- Người gửi / Tài khoản (gộp từ Lịch sử báo) ----
  // Lấy từ lượt báo đại diện của đơn (server enrich `lastReport`): ưu tiên lượt gửi thành công
  // mới nhất, chưa có thì lượt gần nhất. Đơn chưa từng báo -> ô trống "—".
  function chanTag(channel) {
    const fb = channel === 'facebook';
    return `<span class="chan-tag ${fb ? 'fb' : 'zalo'}" title="${fb ? 'Facebook' : 'Zalo'}">${fb ? 'FB' : 'Zalo'}</span>`;
  }
  // Người gửi: 'bot' = luồng tự động; chuỗi khác = danh tính nhân viên (email do gateway forward).
  // Text dài (email) rút gọn 1 dòng bằng ellipsis, xem đầy đủ qua tooltip.
  function senderCell(o) {
    const v = String((o.lastReport && o.lastReport.sender) || '').trim();
    if (!v) return '<span class="muted">—</span>';
    if (v === 'bot') return `<span class="pill pill-bot">${App.icon('bot')} Bot</span>`;
    // Email -> chỉ lấy phần trước @ cho gọn (vd tram@gmail.com -> Tram); email đầy đủ ở tooltip.
    const short = v.includes('@') ? v.split('@')[0] : v;
    return `<span class="sender-name" title="${App.esc(v)}">${App.icon('user', 'sender-ic')}<span class="txt">${App.esc(short)}</span></span>`;
  }
  // Trạng thái GỬI TIN của lượt báo đại diện (khác cột "Trạng thái" là trạng thái đơn):
  // pending = đang gửi · success = đã gửi · failed = lỗi. Đơn chưa từng báo -> "—".
  function sendStatusCell(o) {
    const s = o.lastReport && o.lastReport.status;
    if (!s) return '<span class="muted">—</span>';
    if (s === 'pending') return `<span class="pill pending">${App.icon('hourglass')} Đang gửi</span>`;
    if (s === 'success') return `<span class="pill success">${App.icon('check')} Đã gửi</span>`;
    // Đã gửi cho khách nhưng cập nhật trạng thái web lỗi -> cần kiểm tra/sửa tay (không phải "Lỗi").
    if (s === 'sent_check') return `<span class="pill check" title="Đã gửi tin cho khách nhưng cập nhật trạng thái trên web lỗi — hãy kiểm tra và đổi trạng thái tay">${App.icon('alert')} Đã gửi · cần KT</span>`;
    // Lỗi "không tìm thấy cuộc trò chuyện Zalo" (KHONG_THAY_HOI_THOAI) -> nhãn RIÊNG "Không Zalo"
    // để phân biệt với lỗi gửi khác (mạng/timeout/…). Khách chưa có hội thoại trên Zalo -> cần
    // kết bạn / mở chat trước, không phải lỗi hệ thống.
    if (isNoConversationError(o.lastReport && o.lastReport.error)) {
      return `<span class="pill noconv" title="Không tìm thấy cuộc trò chuyện của khách trên Zalo — kiểm tra khách đã có hội thoại/kết bạn chưa">${App.icon('search')} Không Zalo</span>`;
    }
    return `<span class="pill failed">${App.icon('alert')} Lỗi</span>`;
  }
  // Gom trạng thái GỬI TIN của lượt báo đại diện về nhãn để LỌC (khớp sendStatusCell ở trên):
  // none = chưa từng báo · pending = đang gửi · success = đã gửi · sent_check = đã gửi cần KT · failed = lỗi.
  function sendStatusOf(o) {
    const s = o.lastReport && o.lastReport.status;
    if (!s) return 'none';
    if (s === 'pending') return 'pending';
    if (s === 'success') return 'success';
    if (s === 'sent_check') return 'sent_check';
    return 'failed';
  }

  // Tài khoản Zalo/FB đã dùng để gửi, kèm chip kênh trước tên (tên dài -> ellipsis + tooltip).
  function accountCell(o) {
    const acct = String((o.lastReport && o.lastReport.account) || '').trim();
    if (!acct) return '<span class="muted">—</span>';
    return `<span class="acct-with-ic" title="${App.esc(acct)}">${chanTag(o.lastReport.channel)}<span class="acct-name">${App.esc(acct)}</span></span>`;
  }

  // Gom "Người gửi" + "Tài khoản" về 1 ô: người gửi ở trên, chip tài khoản Zalo/FB ở dòng dưới.
  // Đơn chưa từng báo -> 1 ô trống "—" (không hiện 2 dấu "—" chồng nhau).
  function senderAccountCell(o) {
    if (!o.lastReport) return '<span class="muted">—</span>';
    const acctRaw = String((o.lastReport && o.lastReport.account) || '').trim();
    const acctLine = acctRaw ? `<div class="acct-sub">${accountCell(o)}</div>` : '';
    return `<div class="sender-acct">${senderCell(o)}${acctLine}</div>`;
  }

  function contentCell(text, id, kind) {
    if (text && String(text).trim()) {
      return `<button class="link-btn view-content" data-id="${App.esc(id)}" data-kind="${kind}">Xem nội dung</button>`;
    }
    // ND báo ship chỉ có SAU khi nhân viên tạo đơn giao ship -> đơn chưa tạo ship thì trống là
    // bình thường, KHÔNG mời "Tải nội dung" (tránh hiểu nhầm là thiếu dữ liệu). Chỉ ND báo hàng
    // mới cho tải riêng: Basso có thể đã soạn sẵn nhưng danh sách (đã cache) chưa kèm.
    if (kind === 'ship') return '<span class="muted">—</span>';
    return `<button class="link-btn muted view-content" data-id="${App.esc(id)}" data-kind="${kind}" title="Chưa có sẵn — bấm để lấy nội dung báo hàng của đơn từ Basso">Tải nội dung</button>`;
  }

  // Gom "ND báo hàng" + "ND báo ship" về 1 ô: 2 dòng có nhãn Hàng / Ship, mỗi dòng là nút
  // "Xem/Tải nội dung" như cũ (giữ nguyên data-id/data-kind để updateHangCellDom & handler khớp).
  function contentCombinedCell(o) {
    // Bỏ icon nhãn hộp/xe: dòng trên (hàng) / dòng dưới (ship) đã căn thẳng hàng đúng với
    // nút Gửi tin hộp/xe ngay cạnh nên nút gửi đã tự chỉ rõ hàng/ship — nhãn ở đây thừa.
    // Giữ tooltip trên từng dòng để vẫn tra được khi cần.
    return `<div class="content-pair">
      <div class="content-line" title="Nội dung báo hàng">${contentCell(o.noiDungBaoHang, o.id, 'hang')}</div>
      <div class="content-line" title="Nội dung báo ship">${contentCell(o.noiDungBaoShip, o.id, 'ship')}</div>
    </div>`;
  }

  // ---- Tự lấp "ND báo hàng" cho dòng đang trống (ngầm, sau khi render) ----
  // Nội dung do Basso sinh (không tức thì), danh sách có thể cache bản chưa có ND. Sau mỗi lần
  // render, kéo NGẦM nội dung riêng cho các dòng trống trên TRANG đang xem để tự điền — không
  // phải bấm "Tải nội dung". Giới hạn 3 request đồng thời + tối đa 3 lần thử/đơn (dòng Basso
  // chưa sinh sẽ vẫn trống; lần sync sau thử lại tới khi hết lượt) để không dội Basso đang chậm.
  const CONTENT_CONCURRENCY = 3;
  const CONTENT_MAX_ATTEMPTS = 3;
  const contentInflight = new Set();   // id đang fetch (chặn trùng giữa các lần render)
  const contentAttempts = new Map();   // id -> số lần đã thử

  function updateHangCellDom(o) {
    const key = cssEsc(String(o.id));
    const btn = rowsEl.querySelector(`.view-content[data-id="${key}"][data-kind="hang"]`);
    if (btn) btn.outerHTML = contentCell(o.noiDungBaoHang, o.id, 'hang');
    const send = rowsEl.querySelector(`.send-zalo[data-id="${key}"][data-kind="hang"]`);
    if (send && o.noiDungBaoHang && o.noiDungBaoHang.trim()) {
      send.disabled = false;
      send.title = 'Gửi báo hàng qua Zalo';
    }
  }

  async function autoFillContent(list) {
    const targets = (list || []).filter((o) =>
      o && o.customerId != null && o.dateInventory != null &&
      (!o.noiDungBaoHang || !String(o.noiDungBaoHang).trim()) &&
      !contentInflight.has(String(o.id)) &&
      (contentAttempts.get(String(o.id)) || 0) < CONTENT_MAX_ATTEMPTS);
    if (!targets.length) return;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const o = targets[idx]; idx += 1;
        const id = String(o.id);
        contentInflight.add(id);
        contentAttempts.set(id, (contentAttempts.get(id) || 0) + 1);
        try {
          const qs = new URLSearchParams({
            customerId: o.customerId ?? '', dateInventory: o.dateInventory ?? '', phone: o.phone || '',
          });
          const res = await App.api(`/api/order-content?${qs.toString()}`);
          if (res.noiDungBaoHang) o.noiDungBaoHang = res.noiDungBaoHang;
          if (res.noiDungBaoShip) o.noiDungBaoShip = res.noiDungBaoShip;
          if (res.noiDungBaoHang && String(res.noiDungBaoHang).trim()) updateHangCellDom(o);
        } catch (_) {
          // Im lặng: Basso chậm/lỗi hoặc chưa sinh ND -> để lần sync sau thử lại (tới hết lượt).
        } finally {
          contentInflight.delete(id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONTENT_CONCURRENCY, targets.length) }, worker));
  }

  // ---- Bảng sản phẩm đã về (load lazy qua /api/arrived-items) ----
  function variationsCell(vs) {
    if (!vs || !vs.length) return '<span class="muted">—</span>';
    return vs.map((v) => `<b>${App.esc(v.name)}</b>: ${App.esc(v.value)}`).join('<br>');
  }

  function infoCell(it) {
    const lines = [];
    const arrived = (it.arrivedQty != null && it.totalQty != null)
      ? ` - Đã về: ${App.esc(it.arrivedQty)}/${App.esc(it.totalQty)}` : '';
    lines.push(`SL về: ${App.esc(it.quantity ?? '')}${arrived}`);
    if (it.weight != null) lines.push(`Cân nặng: ${Number(it.weight).toFixed(2)} (kg)`);
    lines.push(`Phí VC: ${App.fmtVnd(it.shipFee)}`);
    lines.push(`Giá sp: ${App.esc(it.currencySymbol)}${Number(it.priceValue).toFixed(2)}`);
    lines.push(`Phụ thu: ${App.fmtVnd(it.termFee)}`);
    return lines.join('<br>');
  }

  const ORDER_DETAIL_BASE = 'https://basso.vn/basso/customer_order/detail/';
  const CUSTOMER_DETAIL_BASE = 'https://basso.vn/management/customer/detail/';
  function customerNameCell(o) {
    const name = App.esc(o.customerName);
    const nameHtml = o.customerId
      ? `<a href="${CUSTOMER_DETAIL_BASE + encodeURIComponent(o.customerId)}" target="_blank" rel="noopener">${name}</a>`
      : name;
    // Tên hội thoại Zalo/FB (từ Danh bạ, khớp SĐT) hiện thành 1 dòng nhỏ dưới tên khách. Có ->
    // khi gửi sẽ tìm nhóm theo tên này; không có -> không hiện gì (thêm ở trang Danh bạ).
    const zalo = o.zaloName
      ? `<div class="zalo-sub" title="Đã liên kết Danh bạ Zalo — khi gửi tìm nhóm theo tên: ${App.esc(o.zaloName)}"><svg class="zalo-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span class="zalo-txt">${App.esc(o.zaloName)}</span></div>`
      : '';
    return nameHtml + zalo;
  }
  function orderCodeCell(it) {
    const code = App.esc(it.orderCode);
    if (!it.orderId) return code;
    const href = ORDER_DETAIL_BASE + encodeURIComponent(it.orderId);
    return `<a href="${href}" target="_blank" rel="noopener">${code}</a>`;
  }

  function itemsTableRows(items) {
    return items.map((it, i) => {
      const nameCell = it.link
        ? `<a href="${App.esc(it.link)}" target="_blank" rel="noopener">${App.esc(it.name)}</a>`
        : App.esc(it.name);
      const img = it.image
        ? `<img class="sp-thumb" src="${App.esc(it.image)}" alt="" loading="lazy" />`
        : '<span class="muted">—</span>';
      const shipped = !!it.shippedDate;
      const statusTag = `<span class="pill ${shipped ? 'da' : 'chua'}">${App.esc(it.shipStatusLabel)}</span>`;
      const tinhTrang = shipped
        ? `${statusTag}<div class="muted" style="margin-top:5px;">${App.esc(it.shippedDate)}</div>`
        : statusTag;
      return `<tr>
        <td>${tinhTrang}</td>
        <td class="code-cell">${orderCodeCell(it)}</td>
        <td class="center">${i + 1}</td>
        <td class="center">${img}</td>
        <td>${nameCell}</td>
        <td>${variationsCell(it.variations)}</td>
        <td class="info-cell">${infoCell(it)}</td>
        <td class="num">${App.esc(App.fmtVnd(it.totalVnd))}</td>
      </tr>`;
    }).join('');
  }

  function itemsSection(o) {
    const st = o._itemsState || 'idle';
    let body;
    if (st === 'loading') {
      body = '<p class="muted">Đang tải sản phẩm…</p>';
    } else if (st === 'error') {
      body = `<p class="muted">Lỗi tải sản phẩm: ${App.esc(o._itemsError || '')}</p>`;
    } else if (st === 'loaded') {
      const items = o._items || [];
      body = items.length
        ? `<table class="items-table">
            <thead><tr>
              <th>Tình trạng</th><th>Mã ĐH</th><th class="center">STT</th><th class="center">Hình SP</th>
              <th>Tên/link sp</th><th>Size/Màu</th><th>Thông tin</th><th class="num">Tổng giá sp(VND)</th>
            </tr></thead>
            <tbody>${itemsTableRows(items)}</tbody>
          </table>`
        : '<p class="muted">Không có chi tiết sản phẩm cho ngày này.</p>';
    } else {
      body = '<p class="muted">Mở rộng để xem sản phẩm…</p>';
    }
    const count = st === 'loaded' ? ` (${(o._items || []).length})` : '';
    return `<div class="full" data-items="${App.esc(o.id)}"><h4>Sản phẩm đã về${count}</h4>${body}</div>`;
  }

  function refreshItemsSection(o) {
    const wrap = rowsEl.querySelector(`div[data-items="${cssEsc(String(o.id))}"]`);
    if (wrap) wrap.outerHTML = itemsSection(o);
  }

  async function loadItems(o) {
    if (o._itemsState === 'loading' || o._itemsState === 'loaded') return;
    o._itemsState = 'loading';
    refreshItemsSection(o);
    try {
      const params = new URLSearchParams();
      // Chỉ gửi `id` khi là id số thật của Basso. id tổng hợp dạng "c<cid>-<date>" (do
      // normalizeOrder dựng khi Basso không trả id) thì bỏ qua, dùng customerId+dateInventory.
      if (o.id != null && /^[0-9]+$/.test(String(o.id)) && String(o.id) !== '0') params.set('id', o.id);
      if (o.customerId != null) params.set('customerId', o.customerId);
      if (o.dateInventory != null) params.set('dateInventory', o.dateInventory);
      const r = await App.api('/api/arrived-items?' + params.toString());
      o._items = r.items || [];
      o._itemsState = 'loaded';
    } catch (e) {
      o._itemsError = e.message;
      o._itemsState = 'error';
    }
    refreshItemsSection(o);
  }

  // grouped = dòng thuộc nhóm có ≥2 đơn (thêm class để kẻ vạch nối + thụt lề).
  function rowHtml(o, grouped = false) {
    const open = openRows.has(String(o.id));
    const canBulk = !isNotified(o); // chỉ đơn chưa báo mới được loại trừ
    const isExcl = excluded.has(String(o.id));
    const gc = grouped ? ' grouped-child' : '';
    const hasHang = o.noiDungBaoHang && o.noiDungBaoHang.trim();
    const hasShip = o.noiDungBaoShip && o.noiDungBaoShip.trim();
    // Nếu đang có ghi chú soạn dở (chưa lưu) thì hiển thị lại text đó, không để
    // giá trị từ Basso đè lên khi render lại sau đồng bộ.
    const noteDirty = dirtyNotes.has(String(o.id));
    const noteVal = noteDirty ? dirtyNotes.get(String(o.id)) : o.note;
    const excludeCell = canBulk
      ? `<label class="excl-wrap" title="Tick để đánh dấu Delay — loại khỏi Báo hàng loạt"><input type="checkbox" class="excl-cb" data-id="${App.esc(o.id)}" ${isExcl ? 'checked' : ''} /></label>`
      : '';
    // Luôn hiện cả 2 nút; nút nào chưa có nội dung thì disable, không cho gửi.
    const actionsCell = `<div class="action-cell">
      <div class="action-btns">
        <button class="btn small icon-only send-zalo" data-id="${App.esc(o.id)}" data-kind="hang" ${hasHang ? '' : 'disabled'} aria-label="Báo hàng" title="${hasHang ? 'Gửi báo hàng qua Zalo' : 'Chưa có nội dung báo hàng'}">${App.icon('box')}</button>
        <button class="btn small icon-only send-zalo" data-id="${App.esc(o.id)}" data-kind="ship" ${hasShip ? '' : 'disabled'} aria-label="Báo ship" title="${hasShip ? 'Gửi báo ship qua Zalo' : 'Chưa có nội dung báo ship'}">${App.icon('truck')}</button>
      </div>
    </div>`;
    const main = `<tr class="main-row${gc} ${isExcl ? 'row-excluded' : ''}" data-id="${App.esc(o.id)}">
      <td class="center"><button class="expand-btn ${open ? 'open' : ''}" data-id="${App.esc(o.id)}">${App.icon('chevron')}</button></td>
      <td class="center">${App.esc(o.stt ?? '')}</td>
      <td>${App.esc(o.warehouseDate)}</td>
      <td class="cust">${customerNameCell(o)}</td>
      <td>${App.esc(o.phone)}</td>
      <td class="center content-col">${contentCombinedCell(o)}</td>
      <td>${actionsCell}</td>
      <td><div class="status-cell">${statusSelect(o)}${reportMetaCell(o)}</div></td>
      <td>${sendStatusCell(o)}</td>
      <td><div class="note-cell">
        <input class="note-input${noteDirty ? ' dirty' : ''}" list="notePresets" data-id="${App.esc(o.id)}" value="${App.esc(noteVal)}" placeholder="Ghi chú..." />
        <button class="save-note${noteDirty ? ' dirty' : ''}" data-id="${App.esc(o.id)}" title="${noteDirty ? 'Ghi chú chưa lưu — bấm để lưu' : 'Lưu ghi chú'}">${App.icon('save')}</button>
      </div></td>
      <td class="center">${excludeCell}</td>
      <td class="staff-col">${App.esc(o.staff)}</td>
      <td class="sender-col">${senderAccountCell(o)}</td>
    </tr>`;

    const detail = `<tr class="detail-row${gc} ${open ? '' : 'hidden'}" data-detail="${App.esc(o.id)}">
      <td colspan="${COLSPAN}"><div class="detail-box">
        ${itemsSection(o)}
      </div></td>
    </tr>`;
    return main + detail;
  }

  // ---------------- Gom dòng (theo khách / theo ngày) ----------------
  function customerKey(o) {
    if (o.customerId != null && String(o.customerId) !== '') return 'id:' + o.customerId;
    return 'name:' + String(o.customerName || '').trim().toLowerCase();
  }

  function groupProductCount(items) {
    let n = 0, allLoaded = true;
    for (const o of items) {
      if (o._itemsState === 'loaded') n += (o._items || []).length;
      else allLoaded = false;
    }
    return { n, allLoaded };
  }
  function productText(items) {
    const { n, allLoaded } = groupProductCount(items);
    return allLoaded ? `${n} sản phẩm` : '… sản phẩm';
  }

  // Header nhóm theo KHÁCH: tên + SĐT + số đơn + SL sản phẩm.
  function customerHeaderHtml(key, items) {
    const o0 = items[0];
    const allOpen = items.every((o) => openRows.has(String(o.id)));
    const phone = o0.phone ? ` · ${App.esc(o0.phone)}` : '';
    return `<tr class="group-row" data-group-key="${App.esc(key)}">
      <td class="center"><button class="group-expand ${allOpen ? 'open' : ''}" data-group-key="${App.esc(key)}" title="Mở/đóng tất cả đơn của khách">${App.icon('chevron')}</button></td>
      <td colspan="${COLSPAN_CUST}"><span class="group-name">${App.esc(o0.customerName || '—')}</span><span class="group-meta">${phone} · ${items.length} đơn · <span class="group-sp">${productText(items)}</span></span></td>
    </tr>`;
  }

  // Header nhóm theo NGÀY: ngày + số đơn + số chưa báo.
  function dateHeaderHtml(key, items) {
    const chua = items.filter((o) => !isNotified(o)).length;
    const sub = `${items.length} đơn` + (chua ? ` · ${chua} chưa báo` : '');
    return `<tr class="group-row" data-group-key="${App.esc(key)}">
      <td colspan="${COLSPAN}"><span class="group-name">${App.esc(key)}</span><span class="group-meta"> · ${sub}</span></td>
    </tr>`;
  }

  // Header nhóm theo KÊNH (nhân viên): tên kênh + số đơn + số chưa báo.
  function channelHeaderHtml(key, items) {
    const chua = items.filter((o) => !isNotified(o)).length;
    const sub = `${items.length} đơn` + (chua ? ` · ${chua} chưa báo` : '');
    return `<tr class="group-row" data-group-key="${App.esc(key)}">
      <td colspan="${COLSPAN}"><span class="group-name">${App.esc(key)}</span><span class="group-meta"> · ${sub}</span></td>
    </tr>`;
  }

  // Gom danh sách theo khoá; sắp xếp nhóm (khách/kênh → tên A-Z, ngày → mới nhất trước).
  function groupListBy(list, mode) {
    const keyFn = mode === 'date' ? (o) => o.warehouseDate || '—'
      : mode === 'channel' ? (o) => o.staff || '—'
      : customerKey;
    const groups = new Map();
    for (const o of list) {
      const k = keyFn(o);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    const entries = [...groups.entries()];
    if (mode === 'date') {
      entries.sort((a, b) => parseDMY(b[0]) - parseDMY(a[0]));
    } else if (mode === 'channel') {
      entries.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'vi', { sensitivity: 'base' }));
    } else {
      entries.sort((a, b) => String(a[1][0].customerName || '').localeCompare(String(b[1][0].customerName || ''), 'vi'));
    }
    return entries;
  }

  function groupedRowsHtml(list, mode) {
    if (mode === 'date' || mode === 'channel') {
      const headerFn = mode === 'date' ? dateHeaderHtml : channelHeaderHtml;
      return groupListBy(list, mode)
        .map(([k, items]) => headerFn(k, items) + items.map((o) => rowHtml(o, true)).join(''))
        .join('');
    }
    // theo khách: chỉ khách ≥2 đơn mới có header gom
    return groupListBy(list, 'customer')
      .map(([k, items]) => items.length > 1
        ? customerHeaderHtml(k, items) + items.map((o) => rowHtml(o, true)).join('')
        : rowHtml(items[0]))
      .join('');
  }

  function fillGroupProductCounts(list) {
    for (const [key, items] of groupListBy(list, 'customer')) {
      if (items.length < 2) continue;
      if (items.every((o) => o._itemsState === 'loaded')) { updateGroupSp(key, items); continue; }
      Promise.all(items.map((o) => loadItems(o))).then(() => updateGroupSp(key, items));
    }
  }
  function updateGroupSp(key, items) {
    const span = rowsEl.querySelector(`.group-row[data-group-key="${cssEsc(key)}"] .group-sp`);
    if (span) span.textContent = productText(items);
  }

  function toggleGroup(key) {
    const list = visibleOrders().filter((o) => customerKey(o) === key);
    if (!list.length) return;
    const allOpen = list.every((o) => openRows.has(String(o.id)));
    list.forEach((o) => { if (allOpen) openRows.delete(String(o.id)); else openRows.add(String(o.id)); });
    render();
  }

  // ---------------- Thẻ lọc trạng thái ----------------
  function periodLabel() {
    if (!F.from && !F.to) return '';
    if (F.from) {
      const [y, m] = F.from.split('-');
      return `T${parseInt(m, 10)}/${y}`;
    }
    return '';
  }

  // Thanh thẻ trạng thái (có đếm) đã BỎ — lọc trạng thái nằm trong popover "Bộ lọc" cho nhẹ
  // (không còn 4 call /api/order-counts mỗi lần tải). Giữ hàm rỗng để các nơi gọi khỏi lỗi.
  function renderStatusTabs() { /* no-op */ }

  // Bộ lọc client-side (Trạng thái gửi tin + Loại trừ/Ghi chú) — tách riêng để dùng được cả khi
  // lọc cả tập (client-mode, trước khi phân trang) lẫn trong phạm vi 1 trang (server-mode).
  // Khách có ND báo ship nhưng CHƯA gửi báo ship lần nào (kể cả 'sent_check' tính là đã gửi vì tin
  // đã tới khách). Dùng cho bộ lọc "Có ND ship chưa gửi" -> soi nhanh đơn cần bấm 🚚.
  function hasUnsentShipContent(o) {
    const has = o.noiDungBaoShip && String(o.noiDungBaoShip).trim();
    const shipSent = o.sentAt && o.sentAt.ship;
    return !!has && !shipSent;
  }

  function applyExcludeNote(list) {
    if (currentSendStatus === 'ship_pending') list = list.filter(hasUnsentShipContent);
    else if (currentSendStatus) list = list.filter((o) => sendStatusOf(o) === currentSendStatus);
    if (F.exclude === 'excluded') list = list.filter((o) => excluded.has(String(o.id)));
    else if (F.exclude === 'not') list = list.filter((o) => !excluded.has(String(o.id)));
    if (F.note === 'has') list = list.filter((o) => (o.note || '').trim());
    else if (F.note === 'none') list = list.filter((o) => !(o.note || '').trim());
    return list;
  }

  // Đơn hiển thị trên trang hiện tại + bộ lọc nâng cao. Trong client-mode `orders` đã được
  // applyView lọc/phân trang sẵn nên applyExcludeNote ở đây là vô hại (idempotent).
  function visibleOrders() {
    return applyExcludeNote(orders.slice());
  }

  // Kẻ sọc xen kẽ: tô nền nhạt cho các dòng chính lẻ (0-based) — làm sau render để đúng
  // dù đang gom nhóm (dòng nhóm/chi tiết không tính). Dòng loại trừ/hover có nền riêng đè lên.
  function applyZebra() {
    const rows = rowsEl.querySelectorAll('tr.main-row');
    rows.forEach((r, i) => r.classList.toggle('zebra', i % 2 === 1));
  }

  function render() {
    renderStatusTabs();
    // `orders` đã là 1 trang do server trả về; chỉ áp thêm lọc client-side (exclude/note).
    const pageList = visibleOrders();
    const totalPages = pageCount;
    if (!pageList.length) {
      const msg = serverTotal ? 'Không có đơn khớp bộ lọc trên trang này.' : 'Không có dữ liệu';
      rowsEl.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty">${msg}</td></tr>`;
      updateCount(pageList);
      renderPager(totalPages);
      return;
    }
    rowsEl.innerHTML = currentGroupBy
      ? groupedRowsHtml(pageList, currentGroupBy)
      : pageList.map((o) => rowHtml(o)).join('');
    applyZebra();
    updateCount(pageList);
    pageList.forEach((o) => { if (openRows.has(String(o.id))) loadItems(o); });
    if (currentGroupBy === 'customer') fillGroupProductCounts(pageList);
    renderPager(totalPages);
    autoFillContent(pageList); // ngầm: tự điền ND báo hàng cho dòng trống (không chặn render)
  }

  // ---------------- Phân trang ----------------
  // Danh sách nút trang dạng cửa sổ: 1 … (cur-1) cur (cur+1) … N.
  function pageItems(total, cur) {
    const out = [];
    for (let p = 1; p <= total; p++) {
      if (p === 1 || p === total || (p >= cur - 1 && p <= cur + 1)) out.push(p);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  }
  function renderPager(totalPages) {
    const el = $('pager');
    if (!el) return;
    if (!serverTotal) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const cur = currentPage;
    // Trái: tổng bản ghi + trang hiện tại (giống Basso "Tổng 1193 bản ghi — Trang 1 / 60").
    const info = `<span class="pg-info">Tổng <b>${serverTotal}</b> bản ghi — Trang <b>${cur}</b> / <b>${totalPages}</b></span>`;
    let pages = '';
    let jump = '';
    if (totalPages > 1) {
      const parts = [`<button class="pg-btn" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''}>Trước</button>`];
      for (const p of pageItems(totalPages, cur)) {
        parts.push(p === '…'
          ? '<span class="pg-ellip">…</span>'
          : `<button class="pg-btn ${p === cur ? 'active' : ''}" data-page="${p}">${p}</button>`);
      }
      parts.push(`<button class="pg-btn" data-page="${cur + 1}" ${cur === totalPages ? 'disabled' : ''}>Sau</button>`);
      pages = `<span class="pg-pages">${parts.join('')}</span>`;
      // Phải: ô nhảy nhanh tới trang (giống Basso "Đến trang [ ] Đi").
      jump = `<span class="pg-jump">Đến trang <input class="pg-jump-input" type="number" min="1" max="${totalPages}" value="${cur}" aria-label="Đến trang" /> <button class="pg-btn pg-go" id="pgGo">Đi</button></span>`;
    }
    el.innerHTML = info + pages + jump;
  }

  // Nhảy tới 1 trang (kẹp về [1, pageCount]). Client-mode: phân trang ngay tại client (đã gom
  // cả tập nên trang nào cũng chứa trọn nhóm); server-mode: kéo đúng trang từ server.
  function goToPage(p) {
    p = Math.min(Math.max(1, parseInt(p, 10) || 1), pageCount);
    if (p === currentPage) return;
    currentPage = p;
    if (clientMode) applyView({ keepPage: true });
    else load({ keepPage: true }); // server-mode: kéo đúng trang (đếm không đổi khi chỉ lật trang)
    const tw = document.querySelector('.table-wrap');
    if (tw) tw.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updateCount() {
    const ci = $('countInfo');
    // "<Trạng thái> · <tổng> đơn · trang X/Y"; chỉ thêm "· N chưa báo" khi đang xem trạng thái
    // KHÁC "Chưa báo" (lúc đó số backlog mới là thông tin phụ cho nút Báo hàng loạt).
    if (ci) {
      const scope = currentGroup ? GROUP_LABELS[currentGroup] : 'Tất cả trạng thái';
      let txt = `${scope} · ${serverTotal} đơn · trang ${currentPage}/${pageCount}`;
      if (currentGroup !== 'todo') txt += ` · ${counts.todo} chưa báo`;
      ci.textContent = txt;
    }
    // Đang gửi loạt (tab này chạy HOẶC vừa reload nhận từ server): nút đóng vai "Dừng" -> KHÔNG để
    // render đè disable/nhãn của nó.
    if (!bulkSending && !bulkAdopted) $('bulkBtn').disabled = counts.todo === 0;
  }

  // ---------------- Mở rộng dòng ----------------
  function toggleDetail(id) {
    const key = String(id);
    const opening = !openRows.has(key);
    if (opening) openRows.add(key); else openRows.delete(key);
    const detail = rowsEl.querySelector(`tr.detail-row[data-detail="${cssEsc(key)}"]`);
    const btn = rowsEl.querySelector(`.expand-btn[data-id="${cssEsc(key)}"]`);
    if (detail) detail.classList.toggle('hidden', !openRows.has(key));
    if (btn) btn.classList.toggle('open', openRows.has(key));
    if (opening) { const o = byId(id); if (o) loadItems(o); }
  }
  const cssEsc = (s) => String(s).replace(/"/g, '\\"');

  // ---------------- Cập nhật trạng thái / ghi chú (sync về web) ----------------
  async function updateRow(o, fields) {
    return App.api('/api/update-row', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: o.customerId, dateInventory: o.dateInventory, ...fields,
      }),
    });
  }

  async function changeStatus(id, code) {
    const o = byId(id); if (!o) return;
    const prev = o.statusCode;
    try {
      await updateRow(o, { status: code, note: o.note || '' });
      o.statusCode = code;
      App.toast('✅ Đã cập nhật trạng thái');
      afterMutation(); // dòng rời nhóm + số đếm thẻ đổi -> cập nhật ngay (client) / tải lại (server)
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
      const sel = rowsEl.querySelector(`.status-sel[data-id="${cssEsc(String(id))}"]`);
      if (sel) sel.value = prev;
    }
  }

  // Bật/tắt cờ Delay (Loại trừ) — lưu lên server mi để giữ sau khi reload.
  async function toggleDelay(cb) {
    const id = String(cb.dataset.id);
    const o = byId(id); if (!o) return;
    const want = cb.checked;
    const prevReason = o.delayReason || '';
    if (want) { excluded.add(id); } else { excluded.delete(id); o.delayReason = ''; o._delayOther = false; }
    o.delayed = want;
    rerender(); // vẽ lại để hiện/ẩn dropdown lý do delay (client-mode lọc lại nếu đang lọc theo Loại trừ)
    updateCount();
    try {
      await App.api('/api/delay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: o.customerId, dateInventory: o.dateInventory, id: o.id, delayed: want, reason: want ? o.delayReason : '' }),
      });
    } catch (e) {
      // Lỗi lưu -> hoàn tác trạng thái trên UI để khớp với server.
      if (want) excluded.delete(id); else excluded.add(id);
      o.delayed = !want;
      o.delayReason = prevReason;
      rerender();
      updateCount();
      App.toast(`❌ Không lưu được Loại trừ: ${e.message}`, 5000);
    }
  }

  // Chọn lý do từ dropdown. "Khác" -> hiện ô nhập tự do (chưa lưu tới khi gõ).
  function changeDelayReason(id, value) {
    const o = byId(id); if (!o) return;
    if (value === DELAY_OTHER) {
      o._delayOther = true;
      if (DELAY_REASONS.includes(o.delayReason)) o.delayReason = ''; // xoá preset cũ để nhập mới
      render();
      const inp = rowsEl.querySelector(`.delay-other[data-id="${cssEsc(String(id))}"]`);
      if (inp) inp.focus();
      return;
    }
    o._delayOther = false;
    saveDelayReason(id, value);
  }

  // Lưu lý do delay (preset, chuỗi tự do, hoặc '' để xoá lý do).
  async function saveDelayReason(id, reason) {
    const o = byId(id); if (!o) return;
    const prev = o.delayReason || '';
    o.delayReason = reason;
    try {
      await App.api('/api/delay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: o.customerId, dateInventory: o.dateInventory, id: o.id, delayed: true, reason }),
      });
      App.toast('✅ Đã lưu lý do delay');
    } catch (e) {
      o.delayReason = prev;
      const sel = rowsEl.querySelector(`.delay-reason[data-id="${cssEsc(String(id))}"]`);
      if (sel) sel.value = prev;
      App.toast(`❌ Không lưu được lý do: ${e.message}`, 5000);
    }
  }

  async function saveNote(id) {
    const o = byId(id); if (!o) return;
    const input = rowsEl.querySelector(`.note-input[data-id="${cssEsc(String(id))}"]`);
    const btn = rowsEl.querySelector(`.save-note[data-id="${cssEsc(String(id))}"]`);
    const val = input ? input.value : '';
    try {
      await updateRow(o, { status: o.statusCode, note: val });
      o.note = val;
      dirtyNotes.delete(String(id)); // đã lưu -> không còn "chưa lưu"
      if (input) input.classList.remove('dirty');
      if (btn) { btn.classList.remove('dirty'); btn.classList.add('saved'); setTimeout(() => btn.classList.remove('saved'), 1200); }
      App.toast('✅ Đã lưu ghi chú');
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
    }
  }

  // ---------------- Modal ----------------
  let modalId = null;
  let modalKind = 'hang';

  // Danh sách tài khoản Zalo (để CHỌN account khi gửi thử). Nạp 1 lần; runner offline ->
  // chỉ còn "Tự động (theo nhân viên)" như mặc định.
  let zaloAccounts = [];
  async function loadZaloAccounts() {
    try {
      const r = await App.api('/api/accounts');
      zaloAccounts = (r && Array.isArray(r.zalo)) ? r.zalo : [];
    } catch { zaloAccounts = []; }
    populateAccountSelect();
  }
  function populateAccountSelect() {
    const sel = $('modalAccount');
    if (!sel) return;
    const cur = sel.value;
    const opts = ['<option value="">Tự động (theo nhân viên)</option>'];
    for (const a of zaloAccounts) {
      const label = a.saleworkName ? `${a.name} — ${a.saleworkName}` : (a.name || a.key);
      const off = a.loggedIn === false ? ' (chưa đăng nhập)' : '';
      opts.push(`<option value="${App.esc(a.key)}">${App.esc(label)}${off}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = cur; // giữ lựa chọn cũ nếu populate lại
  }

  function openModal(id, kind = 'hang') {
    const o = byId(id);
    if (!o) { App.toast('Không tìm thấy đơn để xem nội dung', 4000); return; }
    modalId = id;
    modalKind = kind === 'ship' ? 'ship' : 'hang';
    const isShip = modalKind === 'ship';
    // "Chống đạn": mở popup + đổ nội dung TRƯỚC (phần thiết yếu) rồi mới làm phần phụ (chọn
    // tài khoản, icon). Mỗi truy cập element đều được kiểm tra null, và phần phụ bọc trong
    // try/catch — để 1 element thiếu/lỗi KHÔNG chặn việc hiện nội dung (trước đây lỗi giữa
    // chừng khiến popup không bao giờ mở).
    const set = (elId, prop, val) => { const el = $(elId); if (el) el[prop] = val; };
    set('modalTitle', 'textContent', `${isShip ? 'Báo ship' : 'Báo hàng'} — ${o.customerName || ''}`);
    set('modalSub', 'textContent', `SĐT: ${o.phone || '—'} · NV: ${o.staff || '—'}`);
    const warn = $('modalStale'); if (warn) { warn.style.display = 'none'; warn.textContent = ''; } // reset cảnh báo mỗi lần mở
    const current = (isShip ? o.noiDungBaoShip : o.noiDungBaoHang) || '';
    set('modalMsg', 'value', current);
    set('modalMsg', 'disabled', false); // reset nếu lần trước đóng modal giữa lúc đang tải
    set('modalMsg', 'placeholder', '');
    const bg = $('modalBg');
    if (bg) bg.classList.add('show'); // hiện popup NGAY khi đã có nội dung
    autoGrowMsg();
    // LUÔN đối chiếu nội dung MỚI NHẤT trên Basso (bỏ cache) khi mở modal:
    //   - Chưa có ND -> lấy về đổ vào ô (như trước).
    //   - ĐÃ có ND  -> so với bản mới; nếu LỆCH (vd khách về thêm sản phẩm, Basso soạn lại) thì
    //                  cảnh báo + tự cập nhật ô soạn bằng bản mới (nếu người dùng chưa sửa tay).
    // Bỏ qua đúng 1 trường hợp: báo ship mà đang trống (chưa tạo đơn ship, không có gì để tải).
    if (!(isShip && !current.trim())) refreshContentIntoModal(o, isShip, id, current);
    try {
      const sendBtn = $('modalSend');
      if (sendBtn) {
        sendBtn.innerHTML = (isShip ? App.icon('truck') : App.icon('box')) +
          (isShip ? ' Gửi báo ship qua Zalo' : ' Gửi báo hàng qua Zalo');
        sendBtn.style.display = '';
      }
      populateAccountSelect();
      const acc = $('modalAccount');
      if (acc) acc.value = ''; // mặc định Tự động mỗi lần mở
    } catch (err) {
      console.error('[openModal] lỗi phần phụ (đã bỏ qua, popup vẫn mở):', err);
    }
  }
  function autoGrowMsg() {
    const ta = $('modalMsg');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }
  // Lấy ND MỚI NHẤT của đơn từ Basso (bỏ cache) rồi đồng bộ vào modal đang mở.
  //  - `original` = nội dung ĐANG hiển thị lúc mở modal (từ danh sách, có thể là bản cache cũ).
  //  - Trống -> đổ nội dung lấy về vào ô (như trước).
  //  - Có sẵn & LỆCH so với bản mới -> hiện cảnh báo "ND lệch" + cập nhật ô (nếu chưa sửa tay).
  // Cập nhật luôn đơn trong bộ nhớ + render lại bảng để bật nút gửi và đổi cell "Tải" -> "Xem".
  async function refreshContentIntoModal(o, isShip, id, original = '') {
    const ta = $('modalMsg');
    const warn = $('modalStale');
    const stillOpen = () => modalId === id && modalKind === (isShip ? 'ship' : 'hang');
    const hadContent = !!(original && original.trim());
    const showWarn = (cls, text) => { if (warn && stillOpen()) { warn.className = 'stale-warn' + (cls ? ' ' + cls : ''); warn.textContent = text; warn.style.display = ''; } };
    const hideWarn = () => { if (warn) warn.style.display = 'none'; };
    // Trống -> chặn ô + báo "đang lấy". Có sẵn -> kiểm tra NGẦM (không khoá ô), hiện dòng "đang kiểm tra".
    if (!hadContent && ta) { ta.placeholder = 'Đang lấy nội dung từ Basso…'; ta.disabled = true; }
    else if (hadContent) showWarn('checking', 'Đang kiểm tra nội dung mới nhất trên Basso…');
    try {
      const qs = new URLSearchParams({
        customerId: o.customerId ?? '', dateInventory: o.dateInventory ?? '', phone: o.phone || '',
      });
      const res = await App.api(`/api/order-content?${qs.toString()}`);
      // Cập nhật đơn trong bộ nhớ dù modal đã đóng — lần mở sau đỡ phải gọi lại.
      if (res.noiDungBaoHang) o.noiDungBaoHang = res.noiDungBaoHang;
      if (res.noiDungBaoShip) o.noiDungBaoShip = res.noiDungBaoShip;
      const val = (isShip ? o.noiDungBaoShip : o.noiDungBaoHang) || '';
      if (stillOpen()) {
        if (!hadContent) {
          // Đổ nội dung mới lấy về vào ô đang trống.
          if (ta) { ta.value = val; ta.placeholder = val ? '' : 'Basso chưa có nội dung cho đơn này.'; autoGrowMsg(); }
          hideWarn();
        } else {
          const changed = !!(val && val.trim() && val.trim() !== original.trim());
          const edited = ta && ta.value.trim() !== original.trim(); // người dùng đã sửa tay chưa?
          if (changed && !edited) {
            if (ta) { ta.value = val; autoGrowMsg(); }
            showWarn('', '⚠️ Nội dung trên Basso đã THAY ĐỔI so với bản đang hiển thị (có thể khách vừa về thêm sản phẩm). Đã cập nhật ô soạn bên dưới bằng nội dung MỚI NHẤT — kiểm tra rồi hãy gửi.');
          } else if (changed && edited) {
            showWarn('', '⚠️ Nội dung trên Basso đã THAY ĐỔI (có thể khách về thêm sản phẩm), nhưng bạn đã sửa tay nên KHÔNG tự ghi đè. Đối chiếu lại trước khi gửi.');
          } else {
            hideWarn(); // trùng khớp -> không cảnh báo
          }
        }
      }
      if (res.noiDungBaoHang || res.noiDungBaoShip) render(); // đồng bộ cell + nút gửi trong bảng
    } catch (err) {
      if (stillOpen()) {
        if (!hadContent && ta) ta.placeholder = 'Lỗi lấy nội dung: ' + (err && err.message || 'thử lại');
        else hideWarn(); // kiểm tra ngầm lỗi -> im lặng, giữ bản đang có
      }
      if (!hadContent) App.toast('Không lấy được nội dung đơn: ' + (err && err.message || ''), 4000);
    } finally {
      if (ta) ta.disabled = false; // luôn bật lại (textarea dùng chung, an toàn)
    }
  }
  function closeModal() { const bg = $('modalBg'); if (bg) bg.classList.remove('show'); modalId = null; }

  async function sendFromModal() {
    if (!modalId) return;
    // Chọn account cụ thể -> ép gửi qua account đó (profile=key, account=saleworkName);
    // để trống = Tự động (resolver tự khớp theo nhân viên như thường).
    const acctKey = $('modalAccount').value;
    const acct = acctKey ? zaloAccounts.find((a) => String(a.key) === String(acctKey)) : null;
    const override = acct ? { profile: acct.key, account: acct.saleworkName } : null;
    await sendZalo(modalId, $('modalMsg').value.trim(), $('modalSend'), modalKind, override);
    closeModal();
  }

  // ---------------- Gửi Zalo ----------------
  // Lỗi "không tìm thấy cuộc trò chuyện" do runner ném (KHONG_THAY_HOI_THOAI) khi search SĐT/tên
  // không ra hàng nào trong mục "Trò chuyện". Dùng để hiện thông báo rõ ràng cho người dùng.
  const isNoConversationError = (msg) => /KHONG_THAY_HOI_THOAI/i.test(msg || '');
  // Xác nhận TRƯỚC khi gửi từng đơn qua nút icon gửi nhanh (hộp/xe) — tránh lỡ tay click gửi nhầm.
  // KHÔNG áp cho nút "Gửi" trong modal (bản thân modal đã là bước xem lại nội dung). Nếu đơn đã báo
  // thì hỏi luôn kiểu "vẫn gửi lại?" (gộp với cảnh báo đã-báo để KHÔNG bật 2 popup liên tiếp).
  function confirmSendRow(sz) {
    const id = sz.dataset.id;
    const kind = sz.dataset.kind === 'ship' ? 'ship' : 'hang';
    const o = byId(id);
    const who = (o && o.customerName) ? o.customerName : `đơn ${id}`;
    const kindLabel = kind === 'ship' ? 'báo ship' : 'báo hàng';
    const reason = o ? notifiedReason(o, kind) : '';
    const msg = reason
      ? `Đơn của ${who} ${reason}. Vẫn gửi lại?`
      : `Gửi ${kindLabel} cho ${who}?`;
    if (!confirm(msg)) return;
    return sendZalo(id, undefined, sz, kind, null, { skipConfirm: true });
  }

  // override (tuỳ chọn) = { profile, account } để ép gửi qua 1 tài khoản Zalo cụ thể (gửi thử).
  async function sendZalo(id, messageOverride, btnEl, kind = 'hang', override = null, o2 = {}) {
    const o = byId(id); if (!o) return;
    const reason = notifiedReason(o, kind);
    // o2.skipConfirm = caller đã hỏi xác nhận rồi (vd confirmSendRow) -> KHÔNG hỏi lại lần nữa.
    if (!o2.skipConfirm && reason && !confirm(`Đơn của ${o.customerName || id} ${reason}. Vẫn gửi lại?`)) return;
    const btn = btnEl || rowsEl.querySelector(`.send-zalo[data-id="${cssEsc(String(id))}"][data-kind="${kind}"]`);
    const label = btn ? btn.innerHTML : '';
    const origTitle = btn ? btn.title : '';
    if (btn) {
      // Trong lúc gửi tay, nút ĐỔI VAI thành "Dừng" (vẫn bấm được) để người dùng có thể yêu cầu
      // dừng giữa chừng — giống nút "Dừng báo loạt". dataset.stop báo cho trình xử lý click gọi
      // stopManualSend() thay vì gửi lại. Nút dạng chữ (modal "Gửi") kèm nhãn cho rõ; nút icon tròn
      // (gửi từng dòng) chỉ hiện icon stop để giữ nguyên kích thước, không phình ra chữ.
      btn.dataset.stop = '1';
      btn.classList.add('is-stop');
      btn.title = 'Dừng gửi';
      btn.innerHTML = btn.classList.contains('icon-only')
        ? App.icon('stop')
        : App.icon('stop') + ' Dừng gửi';
    }
    try {
      const res = await App.api('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orders: [orderPayload(o)],
          messageOverride: messageOverride || undefined,
          kind,
          profile: override && override.profile ? override.profile : undefined,
          account: override && override.account ? override.account : undefined,
        }),
      });
      // Người dùng bấm Dừng trong lúc ân hạn / server đang chuẩn bị -> server hủy trước khi gửi,
      // results rỗng. Báo rõ tin CHƯA đi (khác với đã gửi).
      if (res.stopped) { App.toast('⛔ Đã hủy — tin CHƯA được gửi.', 5000); afterMutation(); return; }
      const r = res.results[0];
      if (res.aborted) App.toast('⛔ Zalo chưa đăng nhập — hãy đăng nhập Zalo rồi gửi lại.', 8000);
      else if (!r) App.toast('Không có kết quả trả về — thử lại.', 5000);
      else if (r.ok) App.toast(`✅ Đã gửi cho ${r.customerName || id}`);
      else if (isNoConversationError(r.error)) {
        App.toast(`🔍 Không tìm thấy cuộc trò chuyện của ${r.customerName || o.customerName || id}`
          + ' trong mục "Trò chuyện" trên Zalo — kiểm tra khách đã có hội thoại chưa.', 8000);
      } else App.toast(`❌ ${App.friendlyError(r.error)}`, 7000);
      afterMutation();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    } finally {
      if (btn) {
        delete btn.dataset.stop;
        btn.disabled = false;
        btn.classList.remove('is-loading', 'is-stop');
        btn.innerHTML = label;
        btn.title = origTitle;
      }
    }
  }

  // Người dùng bấm "Dừng" trên 1 lượt gửi tay (modal hoặc nút từng dòng). Đặt cờ dừng ở server
  // (dùng chung endpoint với báo loạt) — nếu lượt đang gửi gồm nhiều đơn thì dừng ở đơn kế tiếp;
  // đơn đang gửi dở vẫn chạy xong. sendZalo() vẫn đang await và sẽ tự khôi phục nút khi xong.
  async function stopManualSend(btn) {
    if (btn) {
      btn.disabled = true; // chặn bấm dừng nhiều lần; sendZalo() khôi phục nút khi lượt gửi kết thúc
      btn.classList.remove('is-stop');
      btn.classList.add('is-loading');
      btn.innerHTML = btn.classList.contains('icon-only')
        ? '<span class="spinner"></span>'
        : '<span class="spinner"></span> Đang dừng...';
    }
    try {
      const res = await App.api('/api/notify-all/stop', { method: 'POST' });
      App.toast(res.stopping
        ? '⏹️ Đã yêu cầu dừng gửi.'
        : 'Không có lượt gửi nào đang chạy để dừng.', 4000);
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
    }
  }

  function openBulkModal() {
    if (!counts.todo) { App.toast('Không có khách nào để báo', 4000); return; }
    // Server gửi cho TẤT CẢ đơn "Chưa báo" (mọi trang), tự bỏ qua đơn đã Delay/đã báo.
    $('bulkSummary').innerHTML = `Sẽ gửi báo hàng cho toàn bộ <strong>${counts.todo}</strong> khách "Chưa báo"`
      + ` <span class="muted">(các đơn đã Delay hoặc đã báo sẽ tự bỏ qua)</span>.`;
    $('bulkConfirm').innerHTML = App.icon('megaphone') + ` Báo hàng (${counts.todo})`;
    $('bulkModalBg').classList.add('show');
  }
  function closeBulkModal() { $('bulkModalBg').classList.remove('show'); }

  // Danh sách đơn "Chưa báo" hiện tại (theo NV + tìm kiếm) để gửi loạt. Client-mode đã có sẵn
  // cả tập nên gửi THẲNG danh sách này lên -> server khỏi phải kéo lại từ Basso (tránh timeout
  // khi Basso chậm). Đơn đã Delay / đã báo sẽ do server tự lọc bỏ như cũ.
  function bulkTodoPayloads() {
    const q = $('fQ').value.trim().toLowerCase();
    return allOrders
      .filter((o) => !currentStaff || String(o.userId) === String(currentStaff))
      .filter((o) => !q || `${o.customerName} ${o.phone}`.toLowerCase().includes(q))
      .filter((o) => groupOf(o) === 'todo')
      .map(orderPayload);
  }

  // Nhãn/nút mặc định của nút báo loạt (khi rảnh). Dùng lại ở nhiều nơi để khỏi lệch chữ.
  function resetBulkBtn() {
    const btn = $('bulkBtn');
    btn.classList.remove('is-loading');
    btn.innerHTML = App.icon('megaphone') + ' Báo hàng loạt (chưa báo)';
    btn.disabled = counts.todo === 0;
  }

  // Người dùng bấm Dừng giữa chừng. Server dừng ở đơn kế tiếp; đơn đang gửi dở vẫn chạy xong.
  // Không đợi loạt kết thúc ở đây — bulkSend() vẫn đang await và sẽ tự hiện tổng kết khi xong.
  async function stopBulk() {
    const btn = $('bulkBtn');
    btn.disabled = true; // chặn bấm dừng nhiều lần; bulkSend() sẽ khôi phục nút khi loạt kết thúc
    btn.innerHTML = '<span class="spinner"></span> Đang dừng...';
    // Banner cũng phản ánh "đang dừng" để rõ ràng (bấm từ nút chính hoặc từ banner đều tới đây).
    const bBtn = $('bulkBannerStop');
    const bTxt = $('bulkBanner') && $('bulkBanner').querySelector('.bulk-banner-text');
    if (bBtn) bBtn.disabled = true;
    if (bTxt) bTxt.textContent = 'Đang dừng báo hàng loạt…';
    try {
      const res = await App.api('/api/notify-all/stop', { method: 'POST' });
      App.toast(res.stopping
        ? '⏹️ Đã yêu cầu dừng — sẽ dừng ngay sau khi gửi xong đơn đang chạy.'
        : 'Không có loạt nào đang chạy để dừng.', 5000);
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
      // Gọi dừng lỗi (mạng...) -> cho bấm lại; nút vẫn ở chế độ "đang gửi".
      if (bulkSending || bulkAdopted) { btn.disabled = false; btn.innerHTML = App.icon('stop') + ' Dừng báo loạt'; }
      if (bBtn) bBtn.disabled = false;
      if (bTxt) bTxt.textContent = 'Đang báo hàng loạt…';
    }
  }

  async function bulkSend() {
    if (!counts.todo) return;
    closeBulkModal();
    const btn = $('bulkBtn');
    // Giữ nút BẤM ĐƯỢC (không disable) để đóng vai nút Dừng trong lúc gửi.
    bulkSending = true;
    btn.disabled = false;
    btn.innerHTML = App.icon('stop') + ' Dừng báo loạt';
    try {
      const q = $('fQ').value;
      const body = {
        from: F.from || undefined, to: F.to || undefined,
        staff: currentStaff || undefined, q: q || undefined,
      };
      // Chỉ gửi kèm `orders` khi client-mode (có đủ tập). Tập quá lớn (server-mode phân trang)
      // -> để server tự kéo toàn bộ như cũ, tránh gửi thiếu đơn ở trang khác.
      if (clientMode) body.orders = bulkTodoPayloads();
      const res = await App.api('/api/notify-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Loạt lớn chạy vài phút (mỗi đơn nghỉ 5–10s) -> nới timeout để client không abort giữa chừng
        // (khiến mất nút Dừng dù server vẫn đang gửi). 30 phút là dư cho các loạt thực tế.
        timeoutMs: 30 * 60 * 1000,
      });
      // Zalo hiện trang login -> server đã DỪNG loạt ngay. Báo rõ để đăng nhập rồi thử lại,
      // thay vì hiện "Hoàn tất" gây hiểu nhầm là đã gửi hết.
      if (res.aborted) {
        App.toast(`⛔ Zalo chưa đăng nhập — đã dừng báo loạt (còn ${res.skipped || 0} đơn chưa gửi).`
          + ' Hãy đăng nhập Zalo rồi báo lại.', 9000);
      } else if (res.stopped) {
        // Người dùng chủ động bấm Dừng -> báo rõ đã gửi bao nhiêu, còn bỏ dở bao nhiêu.
        App.toast(`⏹️ Đã dừng báo loạt: ✅ ${res.sent} đã gửi · còn ${res.skipped || 0} đơn chưa gửi.`, 8000);
      } else {
        // Đếm riêng số khách KHÔNG tìm thấy cuộc trò chuyện để báo rõ (thay vì chỉ "❌ N" chung chung).
        // Chi tiết từng khách vẫn xem được ở Lịch sử báo.
        const notFound = (res.results || []).filter((r) => !r.ok && isNoConversationError(r.error)).length;
        let msg = `Hoàn tất: ✅ ${res.sent} · ❌ ${res.failed}`;
        if (notFound) msg += ` · 🔍 ${notFound} khách không tìm thấy cuộc trò chuyện`;
        App.toast(msg, notFound ? 8000 : 6000);
      }
      afterMutation();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    } finally {
      bulkSending = false;
      resetBulkBtn();
    }
  }

  // ---------------- Load ----------------
  // Merge tabUsers thay vì replace: tránh nhân viên biến khỏi tab khi 1 response trả
  // tab_users thiếu (vd lọc ngày làm tháng này không có đơn của NV đó).
  function mergeTabUsers(list) {
    const map = new Map(tabUsers.map((u) => [String(u.user_id), u]));
    list.forEach((u) => map.set(String(u.user_id), u));
    tabUsers = [...map.values()];
  }

  // Dọn ghi chú "chưa lưu" đã trùng nội dung Basso (đã lưu nơi khác) + dựng lại tập `excluded`
  // (cờ Delay) từ dữ liệu server (lưu ở mi) cho danh sách vừa nhận.
  function syncLocalFlags(list) {
    list.forEach((o) => {
      const id = String(o.id);
      if (dirtyNotes.has(id) && (o.note || '') === dirtyNotes.get(id)) dirtyNotes.delete(id);
    });
    excluded.clear();
    list.forEach((o) => { if (o.delayed) excluded.add(String(o.id)); });
  }

  function setSyncInfo() {
    $('syncInfo').textContent = `Cập nhật ${App.fmtDateTime(new Date().toISOString())}`;
  }

  // ----- CLIENT-MODE: lọc/đếm/phân trang ngay trên tập đầy đủ (không gọi server) -----
  // Đếm 4 nhóm theo groupOf (nhất quán với badge từng dòng: đơn bot đã gửi tính là "arrival").
  function countGroups(list) {
    const c = { todo: 0, arrival: 0, ship: 0, failed: 0, total: list.length };
    for (const o of list) c[groupOf(o)] += 1;
    return c;
  }

  // Chia TOÀN BỘ tập đã lọc thành các trang. Khi KHÔNG gom: cắt đều PAGE_SIZE đơn/trang.
  // Khi ĐANG gom (khách/ngày/kênh): gom cả tập trước rồi phân trang theo NHÓM — giữ trọn mọi
  // đơn của một nhóm trên cùng một trang (dồn lần lượt các nhóm tới khi đủ ~PAGE_SIZE đơn thì
  // sang trang mới, không cắt đôi nhóm). Nhờ vậy tất cả đơn của một khách luôn nằm cùng trang
  // và được gom đúng trên toàn tập, thay vì chỉ gom trong phạm vi 20 đơn của trang đang xem.
  function buildPages(list) {
    if (!currentGroupBy) {
      const pages = [];
      for (let i = 0; i < list.length; i += PAGE_SIZE) pages.push(list.slice(i, i + PAGE_SIZE));
      return pages.length ? pages : [[]];
    }
    const pages = [];
    let cur = [];
    for (const [, items] of groupListBy(list, currentGroupBy)) {
      if (cur.length && cur.length + items.length > PAGE_SIZE) { pages.push(cur); cur = []; }
      cur.push(...items);
    }
    if (cur.length) pages.push(cur);
    return pages.length ? pages : [[]];
  }

  // Lọc allOrders theo NV + tìm kiếm + trạng thái + loại trừ/ghi chú, cập nhật 4 thẻ đếm,
  // rồi phân trang client. Tức thì, KHÔNG round-trip. (Ngày đã lọc lúc kéo tập nên bỏ qua.)
  function applyView(opts = {}) {
    if (!opts.keepPage && opts.resetPage) currentPage = 1;
    let base = allOrders;
    if (currentStaff) base = base.filter((o) => String(o.userId) === String(currentStaff));
    const q = $('fQ').value.trim().toLowerCase();
    if (q) base = base.filter((o) => `${o.customerName} ${o.phone}`.toLowerCase().includes(q));
    counts = countGroups(base); // cả 4 thẻ luôn đúng theo NV + tìm kiếm hiện tại
    let list = currentGroup ? base.filter((o) => groupOf(o) === currentGroup) : base;
    list = applyExcludeNote(list);
    serverTotal = list.length;
    const pages = buildPages(list); // gom cả tập rồi phân trang (theo nhóm nếu đang gom)
    pageCount = pages.length;
    if (currentPage > pageCount) currentPage = pageCount;
    orders = pages[currentPage - 1] || [];
    renderTabs();
    render();
    renderStatusTabs();
    updateCount(visibleOrders());
  }

  // Kéo TOÀN BỘ đơn của khoảng ngày 1 lần rồi chuyển sang lọc client. Cold-start: vẽ nhanh
  // trang 1 (server) trước cho đỡ trống, kéo tập đầy đủ ở nền rồi applyView thay vào. Tập quá
  // lớn (truncated) -> fallback về phân trang server (load()). auto = autosync (không hiện spinner).
  async function loadAll(opts = {}) {
    const auto = opts.auto === true;
    if (!auto && !allOrders.length && !clientMode) load({ fastPaint: true }); // vẽ nhanh, không block
    const prevTodo = new Set(allOrders.filter((o) => groupOf(o) === 'todo').map((o) => String(o.id)));
    const p = new URLSearchParams();
    applyScope(p); // from/to tường minh HOẶC ?days=scopeDays — giữ đúng phạm vi thời gian cả ở client-mode
    try {
      const res = await App.api('/api/orders/all?' + p.toString());
      if (res.truncated) {
        // Tập quá lớn để giữ ở client -> dùng phân trang server như cũ. Đang gom nhóm thì báo
        // cho user biết gom chỉ trong phạm vi trang hiện tại (không đủ chỗ gom cả tập).
        clientMode = false;
        if (!auto && currentGroupBy) {
          App.toast('⚠️ Quá nhiều đơn để gom cả tập — thu hẹp khoảng ngày/bộ lọc để gom đầy đủ.', 6000);
        }
        if (res.tabUsers && res.tabUsers.length) mergeTabUsers(res.tabUsers);
        return load({ keepPage: auto || opts.keepPage });
      }
      clientMode = true;
      allOrders = res.orders || [];
      if (res.tabUsers && res.tabUsers.length) mergeTabUsers(res.tabUsers);
      syncLocalFlags(allOrders);
      if (auto) {
        const fresh = allOrders.filter((o) => groupOf(o) === 'todo' && !prevTodo.has(String(o.id)));
        if (fresh.length) App.toast(`🆕 ${fresh.length} khách mới cần báo`, 5000);
      }
      setSyncInfo();
      applyView({ keepPage: true });
    } catch (e) {
      // Lỗi & chưa có gì để hiện -> KHÔNG xóa trắng kèm lỗi ngay. Tải "tất cả" là truy vấn
      // nặng nhất (login + nhiều trang Basso); nếu nó chậm/timeout thì thử FALLBACK sang
      // phân trang server (chỉ 1 trang nhỏ) — nhẹ hơn nhiều nên thường kịp, và lúc này cache
      // RAM có thể đã ấm. load() tự hiện "Đang tải..." rồi render hoặc báo lỗi của riêng nó.
      if (!auto && !allOrders.length && !orders.length) {
        clientMode = false;
        return load({ keepPage: opts.keepPage });
      }
      // Đang có dữ liệu cũ (auto-sync/refresh) -> giữ nguyên, không phá màn hình.
    }
  }

  // Cập nhật count cho tab đang active từ serverTotal (server-mode/fallback). 3 tab còn lại
  // giữ số cũ đến khi user bấm vào (client-mode thì applyView đã đếm đủ cả 4).
  function updateActiveCount() {
    if (currentGroup) counts[currentGroup] = serverTotal;
  }

  // ----- SERVER-MODE: phân trang phía server (fallback khi tập quá lớn; + vẽ nhanh cold-start) -----
  async function load(opts = {}) {
    const auto = opts.auto === true;
    const fast = opts.fastPaint === true; // vẽ nhanh trang 1 trong lúc loadAll kéo tập đầy đủ
    const keepPage = auto || opts.keepPage === true; // autosync/pager/refresh: giữ nguyên trang
    if (!keepPage) currentPage = 1;
    if (!auto) rowsEl.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty">Đang tải...</td></tr>`;
    const q = $('fQ').value;
    const base = new URLSearchParams();
    applyScope(base); // from/to tường minh, hoặc ?days=scopeDays (cửa sổ mặc định)
    if (currentStaff) base.set('staff', currentStaff);
    if (q) base.set('q', q);
    const params = new URLSearchParams(base);
    const status = currentGroup ? STATUS_FOR_GROUP[currentGroup] : undefined;
    if (status) params.set('status', status);
    params.set('page', currentPage);
    params.set('pageSize', PAGE_SIZE);
    const prevTodo = new Set(orders.filter((o) => groupOf(o) === 'todo').map((o) => String(o.id)));
    try {
      const res = await App.api('/api/orders?' + params.toString());
      // Trong lúc chờ, loadAll đã chuyển sang client-mode -> bỏ kết quả vẽ-nhanh để không đè.
      if (fast && clientMode) return;
      orders = res.orders || [];
      serverTotal = res.total != null ? res.total : orders.length;
      pageCount = Math.max(1, Math.ceil(serverTotal / PAGE_SIZE)); // server-mode: phân trang theo tổng đơn
      if (res.tabUsers && res.tabUsers.length) mergeTabUsers(res.tabUsers);
      // Trang hiện tại vượt quá tổng (vd sau khi báo loạt làm đơn rời nhóm) -> nhảy về trang cuối.
      if (!orders.length && currentPage > 1 && serverTotal > 0) {
        currentPage = Math.max(1, Math.ceil(serverTotal / PAGE_SIZE));
        return load({ keepPage: true });
      }
      // LƯU Ý: `orders` chỉ là 1 trang -> KHÔNG xoá openRows/dirtyNotes vì đơn vắng mặt
      // có thể ở trang khác (tránh mất trạng thái mở rộng & ghi chú đang soạn dở).
      syncLocalFlags(orders);
      if (auto) {
        const fresh = orders.filter((o) => groupOf(o) === 'todo' && !prevTodo.has(String(o.id)));
        if (fresh.length) App.toast(`🆕 ${fresh.length} khách mới cần báo`, 5000);
      }
      if (!fast) setSyncInfo();
      updateActiveCount();
      renderTabs();
      render();
      renderStatusTabs();
      updateCount(visibleOrders());
      // (Bỏ prefetch từng tab NV: server-mode mỗi tab là 1 call sống — prefetch = N call dội
      //  Basso mỗi lần mở, hại nhiều hơn lợi. Tab NV nào bấm mới tải, cache SWR giữ cho lần sau.)
    } catch (e) {
      if (!auto && !fast) {
        rowsEl.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty"><span>Lỗi tải: ${App.esc(e.message)}</span> <button class="btn-retry" onclick="this.closest('tr').remove();window.__miReload&&window.__miReload()">Thử lại</button></td></tr>`;
      }
    }
  }

  // Warm server-side SWR cache cho từng tab nhân viên (chỉ dùng ở fallback server-mode).
  async function prefetchStaffTabs() {
    const base = new URLSearchParams();
    applyScope(base); // warm đúng cache theo phạm vi ngày đang xem (from/to hoặc ?days)
    await new Promise((r) => setTimeout(r, 3000));
    for (const u of tabUsers) {
      if (clientMode) break; // đã chuyển sang client-mode -> không cần warm nữa
      try {
        const p = new URLSearchParams(base);
        p.set('staff', u.user_id);
        p.set('page', '1');
        p.set('pageSize', PAGE_SIZE);
        await App.api('/api/orders?' + p.toString());
        await new Promise((r) => setTimeout(r, 1500));
      } catch {
        break;
      }
    }
  }

  // Đếm "Chưa báo" (cho nút Báo hàng loạt + dòng thông tin) bằng ĐÚNG 1 call nhẹ (pageSize=1 ->
  // chỉ lấy total). ÁP DỤNG ĐÚNG phạm vi đang lọc (applyScope: khoảng ngày from/to tường minh,
  // hoặc ?days) + NV + tìm kiếm -> con số trên nút KHỚP tập thực gửi khi đang lọc theo ngày
  // (trước đây đếm all-time nên nút hiện nhiều hơn số thực gửi khi có lọc ngày).
  async function loadCounts() {
    const p = new URLSearchParams();
    p.set('status', 'not_sent');
    p.set('pageSize', '1');
    if (currentStaff) p.set('staff', currentStaff);
    const q = $('fQ').value.trim();
    if (q) p.set('q', q);
    applyScope(p); // gắn from/to (hoặc days) — đếm đúng phạm vi ngày đang xem
    try {
      const res = await App.api('/api/orders?' + p.toString());
      counts.todo = res.total != null ? res.total : 0;
      if (res.tabUsers && res.tabUsers.length) { mergeTabUsers(res.tabUsers); renderTabs(); }
      updateCount();
    } catch (_) { /* lỗi -> giữ số cũ, không phá màn hình */ }
  }

  // Điều phối: MẶC ĐỊNH server-mode (mỗi thao tác chỉ kéo 1 trang nhẹ + đếm nhẹ -> tải nhanh).
  // Khi đang GOM NHÓM, clientMode=true -> giữ nguyên trên tập đầy đủ (đã kéo) để gom đúng qua
  // mọi trang: lọc/đổi trang tức thì tại client, chỉ kéo lại cả tập khi đổi ngày hoặc đồng bộ.
  function reloadScope(opts = {}) {                               // ngày đổi / Tải lại
    // User chủ động đồng bộ -> cho các dòng đã hết lượt thử lại (Basso có thể đã sinh ND).
    if (opts.auto !== true) contentAttempts.clear();
    if (clientMode) return loadAll(opts); // gom nhóm: kéo lại cả tập rồi gom + phân trang
    loadCounts();
    return load(opts);
  }
  function applyFilters(opts = {}) {                              // NV/trạng thái/trang/tìm kiếm đổi
    if (clientMode) return applyView(opts); // lọc tức thì trên tập đầy đủ (đã có đủ 4 thẻ đếm)
    loadCounts();
    return load(opts);
  }
  // Sau thao tác làm đổi dữ liệu (đổi trạng thái/gửi Zalo/Delay): client-mode phản hồi tức thì
  // rồi resync nền; server-mode tải lại trang + đếm lại.
  function afterMutation() {
    if (clientMode) { applyView({ keepPage: true }); loadAll({ auto: true }); }
    else { load({ keepPage: true }); loadCounts(); }
  }
  // Vẽ lại không gọi server (đổi cách hiển thị/loại trừ/ghi chú): client-mode lọc lại + phân
  // trang cả tập (giữ gom đúng qua mọi trang); server-mode chỉ render lại trang hiện tại.
  function rerender() { if (clientMode) applyView({ keepPage: true }); else render(); }

  // Có bất kỳ bộ lọc CLIENT-SIDE nào đang bật không? (gom nhóm, trạng thái gửi tin, hoặc
  // Loại trừ/Ghi chú trong popover). Các lọc này không làm được ở Basso -> phải lọc tại client.
  function hasClientFilter() {
    return !!currentGroupBy || !!currentSendStatus || F.exclude !== 'all' || F.note !== 'all';
  }
  // Đồng bộ chế độ theo bộ lọc client-side: nếu đang bật mà chưa kéo cả tập -> kéo cả tập rồi
  // lọc/phân trang tại client (để lọc trên TOÀN tập chứ không chỉ 20 đơn của trang đang xem);
  // nếu đã tắt hết mà đang ở client-mode -> quay lại server-mode phân trang nhẹ. Còn lại: chỉ
  // lọc lại + phân trang tức thì trên tập đã kéo.
  function syncClientFilterMode() {
    if (hasClientFilter() && !clientMode) {
      loadAll({ keepPage: true }); // kéo cả tập rồi lọc client (tập quá lớn -> tự fallback server-mode)
    } else if (!hasClientFilter() && clientMode) {
      clientMode = false;
      allOrders = [];
      loadCounts();
      load({ keepPage: true });
    } else {
      rerender(); // đã ở client-mode (đang gom / đã kéo tập) -> lọc lại + phân trang tức thì
    }
  }
  window.__miReload = () => reloadScope();

  function autoSync() {
    if (document.hidden) return;
    if ($('modalBg').classList.contains('show')) return;
    if ($('bulkModalBg').classList.contains('show')) return;
    if (!$('filterPop').hidden) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    if (clientMode) loadAll({ auto: true }); // gom nhóm: resync cả tập ở nền, giữ gom đúng
    else { load({ auto: true }); loadCounts(); }
  }

  // ---------------- Health (chỉ cờ MOCK / TEST trên topbar) ----------------
  async function loadHealth() {
    try {
      const h = await App.api('/api/health');
      $('mockBadge').style.display = h.mock ? '' : 'none';
      const tb = $('testBadge');
      if (h.localRunner && h.localRunner.testMode) {
        tb.style.display = '';
        tb.textContent = '🧪 TEST: chỉ gửi ' + ((h.localRunner.testPhones || []).join(', ') || '(trống)');
      } else {
        tb.style.display = 'none';
      }
      syncBulkButton(h.bulkRunning === true);
    } catch { /* ignore */ }
  }

  // Đồng bộ nút "Báo hàng loạt" với trạng thái server. Nhờ vậy sau khi RELOAD trang (state client bị
  // mất) mà server VẪN đang gửi loạt, nút tự khôi phục về vai "Dừng" để bấm dừng được — và tự trở lại
  // mặc định khi loạt kết thúc. Không đụng tới tab đang tự chạy bulkSend() (bulkSend/stopBulk tự quản).
  function syncBulkButton(running) {
    // Banner luôn phản ánh trạng thái server (kể cả tab đang tự chạy bulkSend()).
    setBulkBanner(running);
    if (bulkSending) return;
    const btn = $('bulkBtn');
    if (running && !bulkAdopted) {
      bulkAdopted = true;
      btn.disabled = false;
      btn.classList.remove('is-loading');
      btn.innerHTML = App.icon('stop') + ' Dừng báo loạt';
    } else if (!running && bulkAdopted) {
      // Server báo loạt đã xong (tự hết hoặc do bấm Dừng) -> trả nút về mặc định.
      bulkAdopted = false;
      resetBulkBtn();
    }
  }

  // Hiện/ẩn banner "Đang báo hàng loạt…" ở đầu bảng. Khi ẩn (loạt đã xong) thì trả nút/nhãn banner về
  // mặc định để lần chạy sau hiện lại sạch sẽ.
  function setBulkBanner(running) {
    const banner = $('bulkBanner');
    if (!banner) return;
    banner.hidden = !running;
    if (!running) {
      const bBtn = $('bulkBannerStop');
      const bTxt = banner.querySelector('.bulk-banner-text');
      if (bBtn) bBtn.disabled = false;
      if (bTxt) bTxt.textContent = 'Đang báo hàng loạt…';
    }
  }

  // ---------------- Bộ lọc nâng cao (popover) ----------------
  function activeFilterCount() {
    let n = 0;
    // Nhân viên / thời gian / trạng thái nằm ở toolbar -> không tính vào badge popover.
    if (F.exclude !== 'all') n++;
    if (F.note !== 'all') n++;
    return n;
  }
  function updateFilterBadge() {
    const cnt = $('filterBtn').querySelector('.cnt');
    const n = activeFilterCount();
    cnt.textContent = n;
    cnt.classList.toggle('zero', n === 0);
  }

  // ---------------- Events ----------------
  $('syncBtn').addEventListener('click', () => reloadScope({ keepPage: true }));

  // Gom nhóm cần TOÀN BỘ tập để gom đúng qua mọi trang (không chỉ 20 đơn của trang đang xem).
  // -> Bật gom = kéo cả tập 1 lần (client-mode) rồi gom + phân trang theo nhóm trên toàn tập.
  // Tập quá lớn -> loadAll tự fallback server-mode (đành gom trong phạm vi trang hiện tại).
  // Bỏ gom -> quay lại server-mode phân trang nhẹ (mặc định, tải nhanh).
  $('fGroupBy').addEventListener('change', (e) => {
    currentGroupBy = e.target.value;
    currentPage = 1; // đổi cách gom -> cách phân trang đổi theo, về trang 1
    if (currentGroupBy) {
      loadAll({ keepPage: true });
    } else if (clientMode) {
      clientMode = false;
      allOrders = [];
      loadCounts();
      load({ keepPage: true });
    } else {
      render();
    }
  });

  // Phạm vi thời gian (toolbar): 0 = Tất cả, hoặc N ngày gần đây -> kéo lại từ server.
  function showCustomRange(on) { const c = $('customRange'); if (c) c.hidden = !on; }
  const fScopeEl = $('fScope');
  if (fScopeEl) fScopeEl.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      // "Tuỳ chỉnh" -> hiện 2 ô ngày NGAY tại toolbar; chờ người dùng nhập rồi mới tải.
      scopeDays = 0;
      showCustomRange(true);
      $('fFrom').focus();
      return;
    }
    F.from = ''; F.to = '';               // bỏ khoảng ngày tuỳ chỉnh để preset có hiệu lực
    scopeDays = parseInt(e.target.value, 10) || 0;
    showCustomRange(false);
    syncDateInputs();
    currentPage = 1;
    reloadScope();
  });
  // Ô ngày inline (chỉ hiện khi chọn "Tuỳ chỉnh") -> đổi là tải lại theo khoảng from/to.
  ['fFrom', 'fTo'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => {
      F.from = $('fFrom').value; F.to = $('fTo').value;
      updateFilterBadge();
      currentPage = 1;
      reloadScope();
    });
  });

  // Lọc trạng thái (toolbar, kế bên thời gian): '' = tất cả, hoặc todo/arrival/ship/failed.
  const fStatusEl = $('fStatus');
  // Tô màu ô lọc theo trạng thái đang chọn (data-v -> CSS): cam/xanh dương/xanh lá/đỏ như badge từng dòng.
  const paintStatusFilter = () => { if (fStatusEl) fStatusEl.dataset.v = fStatusEl.value || ''; };
  paintStatusFilter();
  if (fStatusEl) fStatusEl.addEventListener('change', (e) => {
    currentGroup = e.target.value;
    currentPage = 1;
    paintStatusFilter();
    reloadScope();
  });

  // Bơm ô lọc "Trạng thái gửi tin" + gỡ option "Lỗi - Báo lại" cũ bằng JS nếu trình duyệt/gateway
  // còn giữ index.html BẢN CŨ trong cache (giống renderHeader — miễn nhiễm HTML cache cũ). HTML mới
  // đã có sẵn ô này thì hàm thành no-op.
  function ensureSendStatusFilter() {
    const st = $('fStatus');
    if (st) { const old = st.querySelector('option[value="failed"]'); if (old) old.remove(); }
    if ($('fSendStatus') || !st) return;
    const sel = document.createElement('select');
    sel.id = 'fSendStatus';
    sel.className = 'tb-select';
    sel.title = 'Lọc theo trạng thái gửi tin';
    sel.innerHTML = '<option value="" selected>Tất cả gửi tin</option>'
      + '<option value="ship_pending">Có ND ship chưa gửi</option>'
      + '<option value="success">Đã gửi</option>'
      + '<option value="sent_check">Đã gửi · cần kiểm tra</option>'
      + '<option value="pending">Đang gửi</option>'
      + '<option value="failed">Lỗi gửi</option>'
      + '<option value="none">Chưa gửi</option>';
    st.insertAdjacentElement('afterend', sel);
  }
  ensureSendStatusFilter();

  // Lọc theo TRẠNG THÁI GỬI TIN (toolbar, kế bên trạng thái đơn): '' = tất cả, hoặc
  // success/pending/failed/none. Dữ liệu `lastReport` được server enrich theo TỪNG đơn (không lọc
  // được ở Basso) -> lọc CLIENT-SIDE. Để lọc trên CẢ tập chứ không chỉ 20 đơn/trang, khi bật lọc
  // ta kéo cả tập 1 lần rồi lọc/phân trang tại client (giống bật gom nhóm); bỏ lọc & không gom thì
  // quay lại server-mode phân trang nhẹ (mặc định).
  const fSendStatusEl = $('fSendStatus');
  // Tô màu ô lọc theo giá trị đang chọn (data-v -> CSS): xanh lá/xanh dương/đỏ như pill từng dòng.
  const paintSendStatusFilter = () => { if (fSendStatusEl) fSendStatusEl.dataset.v = fSendStatusEl.value || ''; };
  paintSendStatusFilter();
  if (fSendStatusEl) fSendStatusEl.addEventListener('change', (e) => {
    currentSendStatus = e.target.value || '';
    currentPage = 1;
    paintSendStatusFilter();
    // Lọc trên TOÀN tập: bật -> kéo cả tập (client-mode); tắt & không còn lọc client-side nào ->
    // quay lại server-mode. Dùng chung helper để không "rơi" nhầm mode khi Loại trừ/Ghi chú còn bật.
    syncClientFilterMode();
  });

  // Tìm kiếm: client-mode lọc tức thì (debounce ngắn); server-mode debounce dài hơn rồi gọi API.
  let qTimer;
  $('fQ').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { currentPage = 1; applyFilters({ keepPage: true }); }, clientMode ? 120 : 400);
  });
  // Rảnh -> mở modal báo loạt; đang gửi (tab này chạy HOẶC vừa reload nhận từ server) -> đóng vai nút Dừng.
  $('bulkBtn').addEventListener('click', () => ((bulkSending || bulkAdopted) ? stopBulk() : openBulkModal()));
  // Nút "Dừng ngay" trên banner: dừng loạt đang chạy (dùng chung stopBulk).
  const bulkBannerStop = $('bulkBannerStop');
  if (bulkBannerStop) bulkBannerStop.addEventListener('click', stopBulk);

  // (Thanh thẻ trạng thái đã bỏ — lọc trạng thái nằm trong popover "Bộ lọc", xem xử lý ở fApply.)

  const fStaffEl = $('fStaff');
  if (fStaffEl) fStaffEl.addEventListener('change', (e) => {
    currentStaff = e.target.value || '';
    currentPage = 1;
    applyFilters({ keepPage: true });
  });

  $('pager').addEventListener('click', (e) => {
    const b = e.target.closest('.pg-btn');
    if (!b || b.disabled) return;
    if (b.classList.contains('pg-go')) { // nút "Đi" -> nhảy theo giá trị ô nhập
      const inp = $('pager').querySelector('.pg-jump-input');
      return goToPage(inp ? inp.value : currentPage);
    }
    goToPage(b.dataset.page);
  });
  // Enter trong ô "Đến trang" cũng nhảy trang.
  $('pager').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('pg-jump-input')) {
      e.preventDefault();
      goToPage(e.target.value);
    }
  });

  // Popover bộ lọc
  const filterBtn = $('filterBtn');
  const filterPop = $('filterPop');
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterPop.hidden = !filterPop.hidden;
    if (!filterPop.hidden) syncDateInputs(); // mở -> phản ánh đúng phạm vi/ngày đã áp dụng
  });
  filterPop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { filterPop.hidden = true; });

  filterPop.querySelectorAll('.fp-seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  $('fApply').addEventListener('click', () => {
    F.exclude = filterPop.querySelector('.fp-seg[data-key=exclude] .active').dataset.v;
    F.note = filterPop.querySelector('.fp-seg[data-key=note] .active').dataset.v;
    updateFilterBadge();
    filterPop.hidden = true;
    currentPage = 1; // đổi bộ lọc -> tập kết quả đổi, về trang 1
    // Loại trừ/Ghi chú là lọc CLIENT-SIDE: phải lọc trên TOÀN tập (không chỉ 20 đơn/trang) thì
    // pager + số trang mới đúng -> kéo cả tập rồi lọc client (giống lọc "Trạng thái gửi tin").
    syncClientFilterMode();
  });
  $('fClear').addEventListener('click', () => {
    // Popover giờ chỉ còn Loại trừ + Ghi chú (lọc client-side). "Xoá lọc" đưa 2 cái về mặc định.
    // (Nhân viên / thời gian / trạng thái nằm ở toolbar, không thuộc "Xoá lọc".)
    F.exclude = 'all'; F.note = 'all';
    filterPop.querySelectorAll('.fp-seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((x, i) => x.classList.toggle('active', i === 0));
    });
    updateFilterBadge();
    currentPage = 1;
    syncClientFilterMode(); // tắt hết lọc client-side -> quay lại server-mode phân trang nhẹ
  });

  // Delegation cho bảng
  rowsEl.addEventListener('click', (e) => {
    const t = e.target;
    const ge = t.closest('.group-expand'); if (ge) return toggleGroup(ge.dataset.groupKey);
    const exp = t.closest('.expand-btn'); if (exp) return toggleDetail(exp.dataset.id);
    const vc = t.closest('.view-content'); if (vc) return openModal(vc.dataset.id, vc.dataset.kind);
    const sz = t.closest('.send-zalo'); if (sz) return sz.dataset.stop ? stopManualSend(sz) : confirmSendRow(sz);
    const sn = t.closest('.save-note'); if (sn) return saveNote(sn.dataset.id);
  });
  // Theo dõi ghi chú đang gõ: đánh dấu "chưa lưu" để render lại không làm mất,
  // và để auto-sync biết có nội dung cần giữ.
  rowsEl.addEventListener('input', (e) => {
    const inp = e.target.closest('.note-input');
    if (!inp) return;
    const id = String(inp.dataset.id);
    const o = byId(id);
    const saved = o ? (o.note || '') : '';
    const btn = rowsEl.querySelector(`.save-note[data-id="${cssEsc(id)}"]`);
    if (inp.value === saved) {
      dirtyNotes.delete(id);
      inp.classList.remove('dirty');
      if (btn) btn.classList.remove('dirty');
    } else {
      dirtyNotes.set(id, inp.value);
      inp.classList.add('dirty');
      if (btn) btn.classList.add('dirty');
    }
  });
  rowsEl.addEventListener('change', (e) => {
    const sel = e.target.closest('.status-sel');
    if (sel) return changeStatus(sel.dataset.id, sel.value);
    const rsn = e.target.closest('.delay-reason');
    if (rsn) return changeDelayReason(rsn.dataset.id, rsn.value);
    const other = e.target.closest('.delay-other');
    if (other) return saveDelayReason(other.dataset.id, other.value.trim());
    const cb = e.target.closest('.excl-cb');
    if (cb) return toggleDelay(cb);
  });

  $('modalCancel').addEventListener('click', closeModal);
  $('modalSend').addEventListener('click', () => {
    const b = $('modalSend');
    if (b.dataset.stop) stopManualSend(b); else sendFromModal();
  });
  $('modalMsg').addEventListener('input', autoGrowMsg);
  $('modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeBulkModal(); } });

  $('bulkConfirm').addEventListener('click', bulkSend);
  $('bulkCancel').addEventListener('click', closeBulkModal);
  $('bulkModalBg').addEventListener('click', (e) => { if (e.target.id === 'bulkModalBg') closeBulkModal(); });

  // parseDMY: "19/06/2026" -> Date (cho sắp xếp nhóm theo ngày)
  function parseDMY(s) {
    const m = String(s || '').split('/');
    return m.length === 3 ? new Date(+m[2], +m[1] - 1, +m[0]) : new Date(0);
  }

  // Gợi ý mẫu ghi chú dùng chung cho mọi ô (datalist) — vừa gõ tự do vừa chọn nhanh.
  const notePresetsEl = $('notePresets');
  if (notePresetsEl) notePresetsEl.innerHTML = DELAY_REASONS.map((r) => `<option value="${App.esc(r)}"></option>`).join('');

  // Đồng bộ F.from / F.to + trạng thái vào popover; phạm vi thời gian -> selector #fScope (toolbar).
  function syncDateInputs() {
    $('fFrom').value = F.from || '';
    $('fTo').value = F.to || '';
    const st = $('fStatus'); if (st) { st.value = currentGroup || ''; st.dataset.v = st.value; }
    const custom = !!(F.from || F.to);
    const sc = $('fScope'); if (sc) sc.value = custom ? 'custom' : String(scopeDays);
    showCustomRange(custom);
    updateFilterBadge();
  }

  // Header bảng vẽ bằng JS (nguồn DUY NHẤT, cùng deploy với phần vẽ dòng) để tiêu đề cột LUÔN
  // khớp số/thứ tự ô mỗi dòng — kể cả khi trình duyệt/gateway còn giữ index.html bản CŨ trong
  // cache. HTML tĩnh chỉ là khung tạm; JS ghi đè lại header đúng ngay khi tải trang, nên không
  // còn cảnh "header cũ + body mới" gây lệch cột/thiếu tiêu đề. Thứ tự PHẢI khớp rowHtml().
  function renderHeader() {
    const headRow = document.querySelector('.table-wrap table thead tr');
    if (!headRow) return;
    headRow.innerHTML = `
      <th style="width:34px"></th>
      <th class="center" style="width:50px">STT</th>
      <th title="Ngày nhập kho">Ngày về</th>
      <th>Khách hàng</th>
      <th>SĐT</th>
      <th class="center" title="Nội dung báo hàng & báo ship">Nội dung</th>
      <th class="center" style="width:120px" title="Gửi báo hàng / báo ship qua Zalo">Gửi</th>
      <th>Trạng thái</th>
      <th style="width:120px" title="Kết quả gửi tin của lượt báo gần nhất">Kết quả gửi</th>
      <th>Ghi chú</th>
      <th class="center" style="width:64px" title="Tick để đánh dấu Delay — loại khỏi Báo hàng loạt">Delay</th>
      <th>Nhân viên</th>
      <th style="width:160px" title="Người đã gửi lượt báo (Bot/nhân viên) & tài khoản Zalo/FB đã dùng">Người gửi / TK</th>`;
  }
  renderHeader();

  // Khởi tạo: mặc định tab "Chưa báo" (all-time) nên không set from; lần đầu load
  // currentGroup = 'todo' -> không giới hạn ngày. Sync input để popover hiện đúng.
  if (currentGroup !== 'todo') syncDateInputs();

  // Tải danh sách nhân viên không lọc status ngay khi khởi tạo -> tab staff luôn đầy đủ.
  App.api('/api/tab-users').then((r) => {
    if (r && r.tabUsers && r.tabUsers.length) {
      const map = new Map(tabUsers.map((u) => [String(u.user_id), u]));
      r.tabUsers.forEach((u) => map.set(String(u.user_id), u));
      tabUsers = [...map.values()];
      renderTabs();
    }
  }).catch(() => {});

  loadHealth();
  loadZaloAccounts();
  setInterval(loadHealth, 15000);
  setInterval(autoSync, AUTO_SYNC_MS);
  // Khởi động: mặc định lọc theo NV ĐANG ĐĂNG NHẬP (nếu Admin đã gán user_id trong Cài đặt)
  // -> mỗi người mở lên chỉ thấy đơn của mình (nhẹ hơn); vẫn đổi sang NV khác/Tất cả qua dropdown.
  // Lấy /api/me trước rồi mới load lần đầu (SERVER-MODE: chỉ 1 trang nhẹ + đếm nhẹ, cache ấm).
  App.api('/api/me').then((r) => {
    // defaultUserId = user_id đã gán (Cài đặt) HOẶC tự khớp theo tên (server lo). Không có -> Tất cả.
    const uid = r && r.defaultUserId != null && String(r.defaultUserId) !== '' ? String(r.defaultUserId) : '';
    if (uid) {
      currentStaff = uid;
      const nm = (r.staff && r.staff.name) || ('NV ' + uid);
      if (!tabUsers.some((u) => String(u.user_id) === uid)) tabUsers.push({ user_id: uid, name: nm });
      renderTabs();
    }
  }).catch(() => {}).finally(() => { reloadScope(); });
})();
