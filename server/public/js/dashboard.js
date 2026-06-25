(() => {
  let orders = [];
  let tabUsers = [];
  let currentStaff = ''; // user_id đang lọc ('' = tất cả)
  let currentGroup = 'todo'; // thẻ trạng thái đang xem ('todo' | 'arrival' | 'ship' | 'failed')
  let currentGroupBy = ''; // gom dòng: '' = không gom | 'date' = theo ngày | 'customer' = theo khách | 'channel' = theo kênh (NV)
  let currentPage = 1;     // trang hiện tại (server-side)
  const PAGE_SIZE = 20;    // số đơn mỗi trang (giống Basso: ~20/trang -> 1193 đơn = 60 trang)
  let serverTotal = 0;     // tổng số đơn của trạng thái đang xem (do server trả)
  // Số đếm thật cho 4 thẻ trạng thái (lấy từ /api/order-counts, không chỉ trang hiện tại).
  let counts = { todo: 0, arrival: 0, ship: 0, failed: 0, total: 0 };
  // Nhóm trạng thái trên thẻ -> mã trạng thái Basso để lọc/phân trang server-side.
  const STATUS_FOR_GROUP = { todo: 'not_sent', arrival: 'notified_arrival', ship: 'notified_ship', failed: 'send_failed' };
  const openRows = new Set();
  const excluded = new Set(); // id các đơn bị TICK loại trừ (Delay) khỏi "Báo hàng loạt"
  // Ghi chú đã GÕ nhưng CHƯA bấm lưu (id -> text). Giữ lại để auto-sync/đồng bộ
  // từ Basso không xoá mất phần đang soạn dở. Xoá khỏi map ngay khi lưu thành công.
  const dirtyNotes = new Map();

  // Bộ lọc nâng cao (popover): khoảng ngày (server-side) + loại trừ/ghi chú (client-side)
  const F = { from: '', to: '', exclude: 'all', note: 'all' };

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
  function renderTabs() {
    const el = $('staffTabs');
    const list = tabUsers.slice().sort((a, b) =>
      String(a.name).localeCompare(String(b.name), 'vi', { sensitivity: 'base' }));
    const allTab = `<button class="tab ${currentStaff === '' ? 'active' : ''}" data-staff="">Tất cả</button>`;
    el.innerHTML = allTab + list.map((t) =>
      `<button class="tab ${String(t.user_id) === String(currentStaff) ? 'active' : ''}" data-staff="${App.esc(t.user_id)}">${App.esc(t.name)}</button>`
    ).join('');
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

  function botTag(o) {
    const a = o.autoNotified;
    if (!a) return '';
    const when = a.at ? App.fmtDateTime(a.at) : '';
    if (a.status === 'success') {
      return `<span class="bot-tag" title="Bot tự động đã gửi${when ? ' lúc ' + when : ''}">🤖 Bot đã gửi</span>`;
    }
    if (a.status === 'manual') {
      return `<span class="bot-tag bot-manual" title="Đã báo thủ công trong mi${when ? ' lúc ' + when : ''}">${App.icon('hand')} Báo thủ công</span>`;
    }
    return `<span class="bot-tag bot-fail" title="Bot gửi lỗi ${a.attempts} lần${when ? ' · ' + when : ''}">🤖 Bot lỗi (${a.attempts})</span>`;
  }

  function contentCell(text, id, kind) {
    if (!text || !String(text).trim()) return '<span class="muted">—</span>';
    return `<button class="link-btn view-content" data-id="${App.esc(id)}" data-kind="${kind}">Xem nội dung</button>`;
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
    if (!o.customerId) return name;
    const href = CUSTOMER_DETAIL_BASE + encodeURIComponent(o.customerId);
    return `<a href="${href}" target="_blank" rel="noopener">${name}</a>`;
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
      if (o.id != null && String(o.id) !== '' && String(o.id) !== '0') params.set('id', o.id);
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
      <td class="center">${contentCell(o.noiDungBaoHang, o.id, 'hang')}</td>
      <td class="center">${contentCell(o.noiDungBaoShip, o.id, 'ship')}</td>
      <td><div class="status-cell">${statusSelect(o)}${botTag(o)}</div></td>
      <td><div class="note-cell">
        <input class="note-input${noteDirty ? ' dirty' : ''}" list="notePresets" data-id="${App.esc(o.id)}" value="${App.esc(noteVal)}" placeholder="Ghi chú..." />
        <button class="save-note${noteDirty ? ' dirty' : ''}" data-id="${App.esc(o.id)}" title="${noteDirty ? 'Ghi chú chưa lưu — bấm để lưu' : 'Lưu ghi chú'}">${App.icon('save')}</button>
      </div></td>
      <td>${actionsCell}</td>
      <td class="center">${excludeCell}</td>
      <td>${App.esc(o.staff)}</td>
    </tr>`;

    const detail = `<tr class="detail-row${gc} ${open ? '' : 'hidden'}" data-detail="${App.esc(o.id)}">
      <td colspan="12"><div class="detail-box">
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
      <td colspan="11"><span class="group-name">${App.esc(o0.customerName || '—')}</span><span class="group-meta">${phone} · ${items.length} đơn · <span class="group-sp">${productText(items)}</span></span></td>
    </tr>`;
  }

  // Header nhóm theo NGÀY: ngày + số đơn + số chưa báo.
  function dateHeaderHtml(key, items) {
    const chua = items.filter((o) => !isNotified(o)).length;
    const sub = `${items.length} đơn` + (chua ? ` · ${chua} chưa báo` : '');
    return `<tr class="group-row" data-group-key="${App.esc(key)}">
      <td colspan="12"><span class="group-name">${App.esc(key)}</span><span class="group-meta"> · ${sub}</span></td>
    </tr>`;
  }

  // Header nhóm theo KÊNH (nhân viên): tên kênh + số đơn + số chưa báo.
  function channelHeaderHtml(key, items) {
    const chua = items.filter((o) => !isNotified(o)).length;
    const sub = `${items.length} đơn` + (chua ? ` · ${chua} chưa báo` : '');
    return `<tr class="group-row" data-group-key="${App.esc(key)}">
      <td colspan="12"><span class="group-name">${App.esc(key)}</span><span class="group-meta"> · ${sub}</span></td>
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
  function renderStatusTabs() {
    document.querySelectorAll('#statusTabs .status-tab').forEach((tab) => {
      const key = tab.dataset.filter;
      const num = tab.querySelector('.st-num');
      if (num) num.textContent = counts[key] ?? 0;
      tab.classList.toggle('active', key === currentGroup);
    });
  }

  // Đơn hiển thị = trang hiện tại (server đã lọc theo trạng thái) + bộ lọc nâng cao
  // (loại trừ/ghi chú lọc client-side, chỉ trong phạm vi trang đang xem).
  function visibleOrders() {
    let list = orders.slice();
    if (F.exclude === 'excluded') list = list.filter((o) => excluded.has(String(o.id)));
    if (F.exclude === 'not') list = list.filter((o) => !excluded.has(String(o.id)));
    if (F.note === 'has') list = list.filter((o) => (o.note || '').trim());
    if (F.note === 'none') list = list.filter((o) => !(o.note || '').trim());
    return list;
  }

  function render() {
    renderStatusTabs();
    // `orders` đã là 1 trang do server trả về; chỉ áp thêm lọc client-side (exclude/note).
    const pageList = visibleOrders();
    const totalPages = Math.max(1, Math.ceil(serverTotal / PAGE_SIZE));
    if (!pageList.length) {
      const msg = serverTotal ? 'Không có đơn khớp bộ lọc trên trang này.' : 'Không có dữ liệu';
      rowsEl.innerHTML = `<tr><td colspan="12" class="empty">${msg}</td></tr>`;
      updateCount(pageList);
      renderPager(totalPages);
      return;
    }
    rowsEl.innerHTML = currentGroupBy
      ? groupedRowsHtml(pageList, currentGroupBy)
      : pageList.map((o) => rowHtml(o)).join('');
    updateCount(pageList);
    pageList.forEach((o) => { if (openRows.has(String(o.id))) loadItems(o); });
    if (currentGroupBy === 'customer') fillGroupProductCounts(pageList);
    renderPager(totalPages);
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

  // Nhảy tới 1 trang (kẹp về [1, totalPages]) rồi tải từ server.
  function goToPage(p) {
    const totalPages = Math.max(1, Math.ceil(serverTotal / PAGE_SIZE));
    p = Math.min(Math.max(1, parseInt(p, 10) || 1), totalPages);
    if (p === currentPage) return;
    currentPage = p;
    load({ keepPage: true });
    const tw = document.querySelector('.table-wrap');
    if (tw) tw.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updateCount(list = orders) {
    const ci = $('countInfo');
    // Trang hiện tại + tổng "chưa báo" thật (toàn bộ dữ liệu) lấy từ server.
    if (ci) ci.textContent = `${list.length} đơn (trang ${currentPage}) · ${counts.todo} chưa báo`;
    $('bulkBtn').disabled = counts.todo === 0;
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
      load({ keepPage: true }); // dòng có thể rời nhóm + số đếm thẻ đổi -> tải lại
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
    render(); // vẽ lại để hiện/ẩn dropdown lý do delay theo trạng thái mới
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
      render();
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
  function openModal(id, kind = 'hang') {
    const o = byId(id); if (!o) return;
    modalId = id;
    modalKind = kind === 'ship' ? 'ship' : 'hang';
    const isShip = modalKind === 'ship';
    $('modalTitle').textContent = `${isShip ? 'Báo ship' : 'Báo hàng'} — ${o.customerName}`;
    $('modalSub').textContent = `SĐT: ${o.phone || '—'} · NV: ${o.staff || '—'}`;
    $('modalMsg').value = (isShip ? o.noiDungBaoShip : o.noiDungBaoHang) || '';
    $('modalSend').innerHTML = (isShip ? App.icon('truck') : App.icon('box')) +
      (isShip ? ' Gửi báo ship qua Zalo' : ' Gửi báo hàng qua Zalo');
    $('modalSend').style.display = '';
    $('modalBg').classList.add('show');
    autoGrowMsg();
  }
  function autoGrowMsg() {
    const ta = $('modalMsg');
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }
  function closeModal() { $('modalBg').classList.remove('show'); modalId = null; }

  async function sendFromModal() {
    if (!modalId) return;
    await sendZalo(modalId, $('modalMsg').value.trim(), $('modalSend'), modalKind);
    closeModal();
  }

  // ---------------- Gửi Zalo ----------------
  async function sendZalo(id, messageOverride, btnEl, kind = 'hang') {
    const o = byId(id); if (!o) return;
    const reason = notifiedReason(o, kind);
    if (reason && !confirm(`Đơn của ${o.customerName || id} ${reason}. Vẫn gửi lại?`)) return;
    const btn = btnEl || rowsEl.querySelector(`.send-zalo[data-id="${cssEsc(String(id))}"][data-kind="${kind}"]`);
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang gửi...'; }
    try {
      const res = await App.api('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: [orderPayload(o)], messageOverride: messageOverride || undefined, kind }),
      });
      const r = res.results[0];
      if (r.ok) App.toast(`✅ Đã gửi cho ${r.customerName || id}`);
      else App.toast(`❌ ${r.error}`, 6000);
      await load({ keepPage: true });
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
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

  async function bulkSend() {
    if (!counts.todo) return;
    closeBulkModal();
    const btn = $('bulkBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang gửi...';
    try {
      const q = $('fQ').value;
      const res = await App.api('/api/notify-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: F.from || undefined, to: F.to || undefined,
          staff: currentStaff || undefined, q: q || undefined,
        }),
      });
      App.toast(`Hoàn tất: ✅ ${res.sent} · ❌ ${res.failed}`, 6000);
      await load();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    } finally {
      btn.innerHTML = App.icon('megaphone') + ' Báo hàng loạt (chưa báo)';
    }
  }

  // ---------------- Load ----------------
  // Lấy số đếm 4 thẻ trạng thái, chạy độc lập với bảng để bảng hiện ngay sau 1 call.
  // _countsSeq: nếu có lần load mới hơn chen vào, bỏ kết quả đếm cũ (chống race khi bấm nhanh).
  let _countsSeq = 0;
  async function refreshCounts(query) {
    const seq = ++_countsSeq;
    try {
      const cnt = await App.api('/api/order-counts?' + query);
      if (seq !== _countsSeq) return;
      if (cnt && cnt.counts) counts = cnt.counts;
      if (cnt && cnt.tabUsers && cnt.tabUsers.length) { tabUsers = cnt.tabUsers; renderTabs(); }
      renderStatusTabs();
      updateCount(visibleOrders());
    } catch { /* lỗi đếm -> giữ số cũ, không phá bảng */ }
  }

  async function load(opts = {}) {
    const auto = opts.auto === true;
    const keepPage = auto || opts.keepPage === true; // autosync/pager/refresh: giữ nguyên trang
    if (!keepPage) currentPage = 1;
    if (!auto) rowsEl.innerHTML = '<tr><td colspan="12" class="empty">Đang tải...</td></tr>';
    const q = $('fQ').value;
    // Bộ lọc dùng chung cho cả danh sách lẫn số đếm (ngày/NV/tìm kiếm — lọc server-side).
    const base = new URLSearchParams();
    if (F.from) base.set('from', F.from);
    if (F.to) base.set('to', F.to);
    if (currentStaff) base.set('staff', currentStaff);
    if (q) base.set('q', q);
    const params = new URLSearchParams(base);
    const status = currentGroup ? STATUS_FOR_GROUP[currentGroup] : undefined;
    if (status) params.set('status', status);
    params.set('page', currentPage);
    params.set('pageSize', PAGE_SIZE);
    const prevTodo = new Set(orders.filter((o) => groupOf(o) === 'todo').map((o) => String(o.id)));
    // Số đếm 4 thẻ chạy ĐỘC LẬP (5 call) — không chặn bảng; bảng chỉ cần 1 call /api/orders.
    refreshCounts(base.toString());
    try {
      const res = await App.api('/api/orders?' + params.toString());
      orders = res.orders || [];
      serverTotal = res.total != null ? res.total : orders.length;
      if (res.tabUsers && res.tabUsers.length) tabUsers = res.tabUsers;
      // Trang hiện tại vượt quá tổng (vd sau khi báo loạt làm đơn rời nhóm) -> nhảy về trang cuối.
      if (!orders.length && currentPage > 1 && serverTotal > 0) {
        currentPage = Math.max(1, Math.ceil(serverTotal / PAGE_SIZE));
        return load({ keepPage: true });
      }
      // LƯU Ý phân trang: `orders` giờ chỉ là 1 trang, nên KHÔNG xoá openRows/dirtyNotes
      // chỉ vì đơn không có mặt ở trang hiện tại (đơn đó có thể ở trang khác) — nếu không
      // sẽ mất trạng thái mở rộng & ghi chú đang soạn dở khi chuyển trang.
      // Chỉ dọn ghi chú "chưa lưu" khi nội dung trên Basso đã trùng phần đang gõ (đã lưu nơi khác).
      orders.forEach((o) => {
        const id = String(o.id);
        if (dirtyNotes.has(id) && (o.note || '') === dirtyNotes.get(id)) dirtyNotes.delete(id);
      });
      // Cờ Delay / Loại trừ lấy từ server (lưu ở mi) — giữ được sau khi reload.
      excluded.clear();
      orders.forEach((o) => { if (o.delayed) excluded.add(String(o.id)); });
      if (auto) {
        const fresh = orders.filter((o) => groupOf(o) === 'todo' && !prevTodo.has(String(o.id)));
        if (fresh.length) App.toast(`🆕 ${fresh.length} khách mới cần báo`, 5000);
      }
      $('syncInfo').textContent = `Cập nhật ${App.fmtDateTime(new Date().toISOString())}`;
      renderTabs();
      render();
    } catch (e) {
      if (!auto) rowsEl.innerHTML = `<tr><td colspan="12" class="empty">Lỗi tải: ${App.esc(e.message)}</td></tr>`;
    }
  }

  function autoSync() {
    if (document.hidden) return;
    if ($('modalBg').classList.contains('show')) return;
    if ($('bulkModalBg').classList.contains('show')) return;
    if (!$('filterPop').hidden) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    load({ auto: true });
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
    } catch { /* ignore */ }
  }

  // ---------------- Bộ lọc nâng cao (popover) ----------------
  function activeFilterCount() {
    let n = 0;
    if (F.from || F.to) n++;
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
  $('syncBtn').addEventListener('click', () => load());

  // Gom nhóm chỉ là cách hiển thị TRONG trang hiện tại -> không đổi trang, không tải lại.
  $('fGroupBy').addEventListener('change', (e) => { currentGroupBy = e.target.value; render(); });

  let qTimer;
  $('fQ').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(load, 400); });
  $('bulkBtn').addEventListener('click', openBulkModal);

  // Thẻ trạng thái: bấm để lọc; bấm lại thẻ đang chọn để bỏ lọc (xem tất cả).
  $('statusTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.status-tab');
    if (!tab) return;
    const key = tab.dataset.filter;
    currentGroup = (key === currentGroup) ? '' : key;
    currentPage = 1;
    load(); // đổi trạng thái -> lọc lại phía server
  });

  $('staffTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    currentStaff = tab.dataset.staff || '';
    load();
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
  filterBtn.addEventListener('click', (e) => { e.stopPropagation(); filterPop.hidden = !filterPop.hidden; });
  filterPop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { filterPop.hidden = true; });

  filterPop.querySelectorAll('.fp-seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  $('fApply').addEventListener('click', () => {
    const prevFrom = F.from, prevTo = F.to;
    F.from = $('fFrom').value;
    F.to = $('fTo').value;
    F.exclude = filterPop.querySelector('.fp-seg[data-key=exclude] .active').dataset.v;
    F.note = filterPop.querySelector('.fp-seg[data-key=note] .active').dataset.v;
    updateFilterBadge();
    filterPop.hidden = true;
    // Khoảng ngày lọc ở server -> tải lại (về trang 1); loại trừ/ghi chú lọc client -> chỉ render (giữ trang).
    if (F.from !== prevFrom || F.to !== prevTo) { currentPage = 1; load(); } else render();
  });
  $('fClear').addEventListener('click', () => {
    const hadDate = F.from || F.to;
    F.from = ''; F.to = ''; F.exclude = 'all'; F.note = 'all';
    $('fFrom').value = ''; $('fTo').value = '';
    filterPop.querySelectorAll('.fp-seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((x, i) => x.classList.toggle('active', i === 0));
    });
    updateFilterBadge();
    if (hadDate) { currentPage = 1; load(); } else render();
  });

  // Delegation cho bảng
  rowsEl.addEventListener('click', (e) => {
    const t = e.target;
    const ge = t.closest('.group-expand'); if (ge) return toggleGroup(ge.dataset.groupKey);
    const exp = t.closest('.expand-btn'); if (exp) return toggleDetail(exp.dataset.id);
    const vc = t.closest('.view-content'); if (vc) return openModal(vc.dataset.id, vc.dataset.kind);
    const sz = t.closest('.send-zalo'); if (sz) return sendZalo(sz.dataset.id, undefined, sz, sz.dataset.kind || 'hang');
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
  $('modalSend').addEventListener('click', sendFromModal);
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

  loadHealth();
  setInterval(loadHealth, 15000);
  setInterval(autoSync, AUTO_SYNC_MS);
  load();
})();
