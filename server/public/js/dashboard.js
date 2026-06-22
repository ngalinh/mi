(() => {
  let orders = [];
  let tabUsers = [];
  let currentStaff = ''; // user_id đang lọc ('' = tất cả)
  let currentGroup = 'todo'; // thẻ trạng thái đang xem ('todo' | 'arrival' | 'ship' | 'failed')
  let currentGroupBy = ''; // gom dòng: '' = không gom | 'date' = theo ngày | 'customer' = theo khách
  const openRows = new Set();
  const excluded = new Set(); // id các đơn bị TICK loại trừ (Delay) khỏi "Báo hàng loạt"

  // Bộ lọc nâng cao (popover): khoảng ngày (server-side) + loại trừ/ghi chú (client-side)
  const F = { from: '', to: '', exclude: 'all', note: 'all' };

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  const AUTO_SYNC_MS = 120000; // tự động đồng bộ danh sách mỗi 2 phút

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

  const byId = (id) => orders.find((o) => String(o.id) === String(id));

  // Gom đơn về 4 nhóm theo trạng thái báo.
  function groupOf(o) {
    if (o.statusCode === 'send_failed' || o.statusCode === 'error') return 'failed';
    if (o.statusCode === 'notified_ship') return 'ship';
    if (o.statusCode === 'notified_arrival') return 'arrival';
    if (o.autoNotified && SENT_LOCAL.has(o.autoNotified.status)) return 'arrival';
    return 'todo';
  }
  function groupCounts() {
    const c = { todo: 0, arrival: 0, ship: 0, failed: 0 };
    for (const o of orders) c[groupOf(o)]++;
    return c;
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
  // Avatar viết tắt + màu ổn định theo tên (để mỗi NV có 1 màu riêng dễ nhận).
  // Bảng màu avatar — tông trầm ấm, hợp theme navy + cam + kem
  const AV_COLORS = [
    ['#fde7d6', '#d9692a'], // cam
    ['#e9e7f0', '#5b5e7e'], // xám navy
    ['#e9f1ec', '#3a9b71'], // mint trầm
    ['#fbeed9', '#c0871f'], // amber
    ['#f4e7df', '#b5664a'], // terracotta
    ['#e7eef0', '#4f7c86'], // teal trầm
    ['#efe9e0', '#8a7d6a'], // taupe
    ['#fce4ea', '#c45f7e'], // hồng trầm
  ];
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] + parts[parts.length - 1][0]);
  }
  function avColor(name) {
    let h = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AV_COLORS[h % AV_COLORS.length];
  }
  function renderTabs() {
    const el = $('staffTabs');
    const list = tabUsers.slice().sort((a, b) =>
      String(a.name).localeCompare(String(b.name), 'vi', { sensitivity: 'base' }));
    const allTab = `<button class="tab ${currentStaff === '' ? 'active' : ''}" data-staff="">
      <span class="tab-av all"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>Tất cả</button>`;
    el.innerHTML = allTab + list.map((t) => {
      const [bg, fg] = avColor(t.name);
      const ini = App.esc(initials(t.name).toUpperCase());
      return `<button class="tab ${String(t.user_id) === String(currentStaff) ? 'active' : ''}" data-staff="${App.esc(t.user_id)}">
        <span class="tab-av" style="--av-bg:${bg};--av-fg:${fg};">${ini}</span>${App.esc(t.name)}</button>`;
    }).join('');
  }

  // ---------------- Render bảng ----------------
  function statusSelect(o) {
    const opts = STATUS_OPTS.map(([v, l]) =>
      `<option value="${v}" ${v === o.statusCode ? 'selected' : ''}>${l}</option>`).join('');
    return `<select class="status-sel" data-code="${App.esc(o.statusCode)}" data-id="${App.esc(o.id)}">${opts}</select>`;
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
      const tinhTrang = it.shippedDate
        ? `${App.esc(it.shipStatusLabel)}<br><span class="muted">${App.esc(it.shippedDate)}</span>`
        : App.esc(it.shipStatusLabel);
      return `<tr>
        <td>${tinhTrang}</td>
        <td>${orderCodeCell(it)}</td>
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
    const hasShip = o.noiDungBaoShip && o.noiDungBaoShip.trim();
    const excludeCell = canBulk
      ? `<label class="excl-wrap" title="Tick để đánh dấu Delay — loại khỏi Báo hàng loạt"><input type="checkbox" class="excl-cb" data-id="${App.esc(o.id)}" ${isExcl ? 'checked' : ''} /></label>`
      : '';
    const actionsCell = `<div class="action-cell">
      <div class="action-btns">
        <button class="btn small send-zalo" data-id="${App.esc(o.id)}" data-kind="hang" title="Gửi báo hàng qua Zalo">${App.icon('send')} Báo hàng</button>
        ${hasShip ? `<button class="btn small outline send-zalo" data-id="${App.esc(o.id)}" data-kind="ship" title="Gửi báo ship qua Zalo">${App.icon('box')} Báo ship</button>` : ''}
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
        <input class="note-input" data-id="${App.esc(o.id)}" value="${App.esc(o.note)}" placeholder="Ghi chú..." />
        <button class="save-note" data-id="${App.esc(o.id)}" title="Lưu ghi chú">${App.icon('save')}</button>
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

  // Gom danh sách theo khoá; sắp xếp nhóm (khách → tên A-Z, ngày → mới nhất trước).
  function groupListBy(list, mode) {
    const keyFn = mode === 'date' ? (o) => o.warehouseDate || '—' : customerKey;
    const groups = new Map();
    for (const o of list) {
      const k = keyFn(o);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    const entries = [...groups.entries()];
    if (mode === 'date') {
      entries.sort((a, b) => parseDMY(b[0]) - parseDMY(a[0]));
    } else {
      entries.sort((a, b) => String(a[1][0].customerName || '').localeCompare(String(b[1][0].customerName || ''), 'vi'));
    }
    return entries;
  }

  function groupedRowsHtml(list, mode) {
    if (mode === 'date') {
      return groupListBy(list, 'date')
        .map(([k, items]) => dateHeaderHtml(k, items) + items.map((o) => rowHtml(o, true)).join(''))
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
    const counts = groupCounts();
    document.querySelectorAll('#statusTabs .status-tab').forEach((tab) => {
      const key = tab.dataset.filter;
      const num = tab.querySelector('.st-num');
      if (num) num.textContent = counts[key] ?? 0;
      tab.classList.toggle('active', key === currentGroup);
    });
  }

  // Đơn hiển thị = lọc theo nhóm trạng thái + bộ lọc nâng cao (client-side).
  function visibleOrders() {
    let list = orders.filter((o) => groupOf(o) === currentGroup);
    if (F.exclude === 'excluded') list = list.filter((o) => excluded.has(String(o.id)));
    if (F.exclude === 'not') list = list.filter((o) => !excluded.has(String(o.id)));
    if (F.note === 'has') list = list.filter((o) => (o.note || '').trim());
    if (F.note === 'none') list = list.filter((o) => !(o.note || '').trim());
    return list;
  }

  function render() {
    renderStatusTabs();
    const list = visibleOrders();
    if (!list.length) {
      const msg = orders.length ? 'Không có đơn nào ở trạng thái này.' : 'Không có dữ liệu';
      rowsEl.innerHTML = `<tr><td colspan="12" class="empty">${msg}</td></tr>`;
      updateCount(list);
      return;
    }
    rowsEl.innerHTML = currentGroupBy
      ? groupedRowsHtml(list, currentGroupBy)
      : list.map((o) => rowHtml(o)).join('');
    updateCount(list);
    list.forEach((o) => { if (openRows.has(String(o.id))) loadItems(o); });
    if (currentGroupBy === 'customer') fillGroupProductCounts(list);
  }

  function bulkTargets() {
    return orders.filter((o) => !isNotified(o) && !excluded.has(String(o.id)));
  }
  function updateCount(list = orders) {
    const chua = orders.filter((o) => !isNotified(o)).length;
    const willSend = bulkTargets().length;
    const exclNote = chua - willSend > 0 ? ` (loại ${chua - willSend})` : '';
    $('countInfo').textContent = `${list.length} đơn · ${chua} chưa báo${exclNote}`;
    $('bulkBtn').disabled = willSend === 0;
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
      render();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
      const sel = rowsEl.querySelector(`.status-sel[data-id="${cssEsc(String(id))}"]`);
      if (sel) sel.value = prev;
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
      if (btn) { btn.classList.add('saved'); setTimeout(() => btn.classList.remove('saved'), 1200); }
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
    $('modalSend').innerHTML = (isShip ? App.icon('box') : App.icon('send')) +
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
      await load();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }

  function openBulkModal() {
    const willSend = bulkTargets().length;
    if (!willSend) { App.toast('Không có khách nào để báo', 4000); return; }
    const chua = orders.filter((o) => !isNotified(o)).length;
    const exclN = chua - willSend;
    $('bulkSummary').innerHTML = `Sẽ gửi báo hàng cho <strong>${willSend}</strong> khách chưa báo`
      + (exclN > 0 ? ` <span class="muted">(đã loại trừ ${exclN} khách)</span>` : '') + '.';
    $('bulkConfirm').innerHTML = App.icon('megaphone') + ` Báo hàng (${willSend})`;
    $('bulkModalBg').classList.add('show');
  }
  function closeBulkModal() { $('bulkModalBg').classList.remove('show'); }

  async function bulkSend() {
    const sel = bulkTargets();
    if (!sel.length) return;
    closeBulkModal();
    const btn = $('bulkBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang gửi...';
    try {
      const res = await App.api('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: sel.map(orderPayload) }),
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
  async function load(opts = {}) {
    const auto = opts.auto === true;
    if (!auto) rowsEl.innerHTML = '<tr><td colspan="12" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    const q = $('fQ').value;
    if (F.from) params.set('from', F.from);
    if (F.to) params.set('to', F.to);
    if (currentStaff) params.set('staff', currentStaff);
    if (q) params.set('q', q);
    const prevTodo = new Set(orders.filter((o) => groupOf(o) === 'todo').map((o) => String(o.id)));
    try {
      const res = await App.api('/api/orders?' + params.toString());
      orders = res.orders || [];
      if (res.tabUsers && res.tabUsers.length) tabUsers = res.tabUsers;
      const existing = new Set(orders.map((o) => String(o.id)));
      [...openRows].forEach((id) => { if (!existing.has(id)) openRows.delete(id); });
      const stillTodo = new Set(orders.filter((o) => !isNotified(o)).map((o) => String(o.id)));
      [...excluded].forEach((id) => { if (!stillTodo.has(id)) excluded.delete(id); });
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

  $('fGroupBy').addEventListener('change', (e) => { currentGroupBy = e.target.value; render(); });

  let qTimer;
  $('fQ').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(load, 400); });
  $('bulkBtn').addEventListener('click', openBulkModal);

  // Thẻ trạng thái: chọn 1 (luôn có 1 thẻ active).
  $('statusTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.status-tab');
    if (!tab) return;
    currentGroup = tab.dataset.filter;
    render();
  });

  $('staffTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    currentStaff = tab.dataset.staff || '';
    load();
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
    // Khoảng ngày lọc ở server -> cần load lại; loại trừ/ghi chú lọc client -> chỉ render.
    if (F.from !== prevFrom || F.to !== prevTo) load(); else render();
  });
  $('fClear').addEventListener('click', () => {
    const hadDate = F.from || F.to;
    F.from = ''; F.to = ''; F.exclude = 'all'; F.note = 'all';
    $('fFrom').value = ''; $('fTo').value = '';
    filterPop.querySelectorAll('.fp-seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((x, i) => x.classList.toggle('active', i === 0));
    });
    updateFilterBadge();
    if (hadDate) load(); else render();
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
  rowsEl.addEventListener('change', (e) => {
    const sel = e.target.closest('.status-sel');
    if (sel) return changeStatus(sel.dataset.id, sel.value);
    const cb = e.target.closest('.excl-cb');
    if (cb) {
      const id = String(cb.dataset.id);
      if (cb.checked) excluded.add(id); else excluded.delete(id);
      const tr = cb.closest('.main-row');
      if (tr) tr.classList.toggle('row-excluded', cb.checked);
      updateCount();
    }
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

  loadHealth();
  setInterval(loadHealth, 15000);
  setInterval(autoSync, AUTO_SYNC_MS);
  load();
})();
