(() => {
  let orders = [];
  let tabUsers = [];
  let currentStaff = ''; // user_id đang lọc ('' = tất cả)
  let currentGroup = 'all'; // nhóm trạng thái đang xem ('all' | 'todo' | 'arrival' | 'ship' | 'failed')
  const openRows = new Set();

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  const AUTO_SYNC_MS = 120000; // tự động đồng bộ danh sách mỗi 2 phút

  const DONE = new Set(['notified_arrival', 'notified_ship']);
  // "Đã báo" = web đã đánh dấu, HOẶC mi đã gửi (bot 'success' / đã báo tay 'manual').
  // Dùng để loại khỏi "Báo hàng loạt" -> tránh gửi trùng cho khách đã nhắn.
  const SENT_LOCAL = new Set(['success', 'manual']);
  const isNotified = (o) => DONE.has(o.statusCode) || (o.autoNotified && SENT_LOCAL.has(o.autoNotified.status));
  // Vì sao 1 đơn bị coi là "đã báo" cho loại tin đang gửi (để cảnh báo khi gửi lẻ) — null nếu chưa báo.
  // Báo ship: chỉ chặn khi đã báo ship; đơn mới "Đã báo hàng" vẫn được báo ship bình thường.
  const notifiedReason = (o, kind = 'hang') => {
    const done = kind === 'ship' ? o.statusCode === 'notified_ship' : DONE.has(o.statusCode);
    if (done) return `web đang ở trạng thái "${o.status}"`;
    if (kind === 'ship') return null; // dấu auto_notified là của báo hàng, không áp cho báo ship
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

  // Gom đơn về 4 nhóm theo trạng thái báo. "arrival" gộp cả khi bot/tay đã gửi
  // báo hàng nhưng web vẫn 'not_sent' (coi như đã báo hàng).
  const GROUPS = [
    ['todo', 'Chưa báo'],
    ['arrival', 'Đã báo hàng'],
    ['ship', 'Đã báo ship'],
    ['failed', 'Lỗi - Báo lại'],
  ];
  function groupOf(o) {
    if (o.statusCode === 'send_failed' || o.statusCode === 'error') return 'failed';
    if (o.statusCode === 'notified_ship') return 'ship';
    if (o.statusCode === 'notified_arrival') return 'arrival';
    if (o.autoNotified && SENT_LOCAL.has(o.autoNotified.status)) return 'arrival';
    return 'todo';
  }
  // Map nhanh từ mã trạng thái (dropdown) sang nhóm, không cần cả object.
  function groupOfCode(code) {
    if (code === 'notified_ship') return 'ship';
    if (code === 'notified_arrival') return 'arrival';
    if (code === 'send_failed' || code === 'error') return 'failed';
    return 'todo';
  }
  function groupCounts() {
    const c = { todo: 0, arrival: 0, ship: 0, failed: 0 };
    for (const o of orders) c[groupOf(o)]++;
    return c;
  }

  // Gửi đơn đầy đủ field lên server (không để server tra lại theo id -> tránh lỗi
  // "Không tìm thấy đơn" khi dữ liệu nhiều/phân trang/đang lọc theo nhân viên).
  // Mã ĐH (orderCode) nằm trên từng SP — nếu đã mở rộng/đã tải SP thì gửi kèm để report
  // hiển thị đúng mã đơn mà server khỏi phải tra lại. Chưa tải thì để server tự tra.
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
    const tabs = [{ user_id: '', name: 'Tất cả' }, ...tabUsers];
    el.innerHTML = tabs.map((t) =>
      `<button class="tab ${String(t.user_id) === String(currentStaff) ? 'active' : ''}" data-staff="${App.esc(t.user_id)}">${App.esc(t.name)}</button>`
    ).join('');
  }
  function populateStaff() {
    const sel = $('fStaff');
    const list = tabUsers.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sel.innerHTML = '<option value="">Tất cả</option>' +
      list.map((u) => `<option value="${App.esc(u.user_id)}">${App.esc(u.name)}</option>`).join('');
    sel.value = currentStaff;
  }

  // ---------------- Render bảng ----------------
  function statusSelect(o) {
    const opts = STATUS_OPTS.map(([v, l]) =>
      `<option value="${v}" ${v === o.statusCode ? 'selected' : ''}>${l}</option>`).join('');
    return `<select class="status-sel" data-code="${App.esc(o.statusCode)}" data-id="${App.esc(o.id)}">${opts}</select>`;
  }

  // Dấu "bot tự động đã gửi" — lưu local trong mi (không phụ thuộc trạng thái web Basso)
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

  // Mã ĐH dẫn tới trang chi tiết đơn trên web Basso (giống hệ thống basso).
  const ORDER_DETAIL_BASE = 'https://basso.vn/basso/customer_order/detail/';
  // Tên khách dẫn tới trang profile khách hàng trên web Basso.
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

  // Render khối sản phẩm theo trạng thái load của dòng (idle/loading/loaded/error)
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

  function rowHtml(o) {
    const open = openRows.has(String(o.id));
    const main = `<tr class="main-row" data-id="${App.esc(o.id)}">
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
      <td>${App.esc(o.staff)}</td>
    </tr>`;

    const detail = `<tr class="detail-row ${open ? '' : 'hidden'}" data-detail="${App.esc(o.id)}">
      <td colspan="10"><div class="detail-box">
        <div><h4>ND báo hàng</h4><pre>${App.esc(o.noiDungBaoHang) || '(trống)'}</pre></div>
        <div><h4>ND báo ship</h4><pre>${App.esc(o.noiDungBaoShip) || '(trống)'}</pre></div>
        ${itemsSection(o)}
        <div class="full detail-actions">
          <button class="btn small send-zalo" data-id="${App.esc(o.id)}" data-kind="hang">${App.icon('send')} Gửi báo hàng qua Zalo</button>
          ${o.noiDungBaoShip && o.noiDungBaoShip.trim()
            ? `<button class="btn small send-zalo" data-id="${App.esc(o.id)}" data-kind="ship">${App.icon('box')} Gửi báo ship qua Zalo</button>` : ''}
          <button class="btn small secondary edit-content" data-id="${App.esc(o.id)}">${App.icon('edit')} Sửa nội dung rồi gửi</button>
        </div>
      </div></td>
    </tr>`;
    return main + detail;
  }

  // ---------------- Nhóm trạng thái ----------------
  function renderGroupBar() {
    const counts = groupCounts();
    $('groupBar').innerHTML = GROUPS.map(([key, label]) =>
      `<button class="group-card g-${key} ${currentGroup === key ? 'active' : ''}" data-group="${key}">
         <span class="gc-label"><span class="gc-dot"></span>${label}</span>
         <span class="gc-num">${counts[key]}</span>
       </button>`).join('');
  }

  // Đơn hiển thị = lọc theo nhóm + theo dropdown trạng thái (đều client-side)
  function visibleOrders() {
    let list = orders;
    if (currentGroup !== 'all') list = list.filter((o) => groupOf(o) === currentGroup);
    const st = $('fStatus').value;
    if (st && st !== 'all') list = list.filter((o) => o.statusCode === st);
    return list;
  }

  function render() {
    renderGroupBar();
    const list = visibleOrders();
    if (!list.length) {
      const msg = orders.length ? 'Không có đơn trong nhóm này' : 'Không có dữ liệu';
      rowsEl.innerHTML = `<tr><td colspan="10" class="empty">${msg}</td></tr>`;
      updateCount(list);
      return;
    }
    rowsEl.innerHTML = list.map(rowHtml).join('');
    updateCount(list);
    // Dòng đang mở: load (hoặc render lại) chi tiết sản phẩm
    list.forEach((o) => { if (openRows.has(String(o.id))) loadItems(o); });
  }

  function updateCount(list = orders) {
    const chua = orders.filter((o) => !isNotified(o)).length;
    $('countInfo').textContent = `Hiển thị ${list.length} đơn · ${chua} chưa báo`;
    $('bulkBtn').disabled = chua === 0;
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
      // Render lại: cập nhật số đếm nhóm + lọc dòng theo nhóm đang xem
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
  // Cho textarea cao vừa đủ nội dung (trong giới hạn max-height của CSS) để khỏi phải scroll.
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
    // Chốt chặn báo trùng: gửi lẻ không tự loại đơn đã báo như "Báo hàng loạt",
    // nên nếu đơn đã báo (web/bot/tay) thì hỏi lại trước khi gửi tiếp.
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

  async function bulkSend() {
    const sel = orders.filter((o) => !isNotified(o));
    if (!sel.length) return;
    if (!confirm(`Gửi báo hàng cho ${sel.length} khách chưa báo?`)) return;
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
  // opts.auto = true: đồng bộ nền — không hiện "Đang tải...", giữ dòng đang mở, báo khách mới.
  async function load(opts = {}) {
    const auto = opts.auto === true;
    if (!auto) rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Đang tải...</td></tr>';
    // Không lọc trạng thái ở server nữa (để đếm đủ 3 nhóm); chỉ lọc staff/ngày/tìm kiếm.
    const params = new URLSearchParams();
    const f = $('fFrom').value, t = $('fTo').value, q = $('fQ').value;
    if (f) params.set('from', f);
    if (t) params.set('to', t);
    if (currentStaff) params.set('staff', currentStaff);
    if (q) params.set('q', q);
    const prevTodo = new Set(orders.filter((o) => groupOf(o) === 'todo').map((o) => String(o.id)));
    try {
      const res = await App.api('/api/orders?' + params.toString());
      orders = res.orders || [];
      if (res.tabUsers && res.tabUsers.length) tabUsers = res.tabUsers;
      // Giữ các dòng đang mở, bỏ id không còn tồn tại
      const existing = new Set(orders.map((o) => String(o.id)));
      [...openRows].forEach((id) => { if (!existing.has(id)) openRows.delete(id); });
      if (auto) {
        const fresh = orders.filter((o) => groupOf(o) === 'todo' && !prevTodo.has(String(o.id)));
        if (fresh.length) App.toast(`🆕 ${fresh.length} khách mới cần báo`, 5000);
      }
      $('syncInfo').textContent = `Cập nhật ${App.fmtDateTime(new Date().toISOString())}`;
      renderTabs();
      populateStaff();
      render();
    } catch (e) {
      if (!auto) rowsEl.innerHTML = `<tr><td colspan="10" class="empty">Lỗi tải: ${App.esc(e.message)}</td></tr>`;
    }
  }

  // Đồng bộ nền định kỳ: bỏ qua khi đang gõ / mở modal / tab ẩn để không phá thao tác.
  function autoSync() {
    if (document.hidden) return;
    if ($('modalBg').classList.contains('show')) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    load({ auto: true });
  }

  async function loadHealth() {
    try {
      const h = await App.api('/api/health');
      const lb = $('localBadge');
      lb.textContent = 'Local-runner: ' + (h.localRunner.online ? 'online' : 'offline');
      lb.className = 'badge-status ' + (h.localRunner.online ? 'badge-online' : 'badge-offline');
      $('mockBadge').style.display = h.mock ? '' : 'none';
      const tb = $('testBadge');
      if (h.localRunner.testMode) {
        tb.style.display = '';
        tb.textContent = '🧪 TEST: chỉ gửi ' + ((h.localRunner.testPhones || []).join(', ') || '(trống)');
      } else {
        tb.style.display = 'none';
      }
      if (h.autoNotify) renderAutoBadge(h.autoNotify);
    } catch { /* ignore */ }
  }

  // ---------------- Tự động báo hàng ----------------
  let autoEnabled = false;
  function renderAutoBadge(a) {
    autoEnabled = !!a.enabled;
    const el = $('autoBadge');
    const every = Math.round((a.intervalMs || 0) / 1000);
    el.textContent = 'Tự động: ' + (autoEnabled ? `Bật (mỗi ${every}s)` : 'Tắt');
    el.className = 'badge-status badge-clickable ' + (autoEnabled ? 'badge-online' : 'badge-offline');
    const last = a.lastResult;
    el.title = autoEnabled
      ? `Tự gửi báo hàng cho đơn "Chưa báo".${last ? ` Lần gần nhất: ✅${last.sent || 0} ❌${last.failed || 0}` : ''} · Bấm để tắt`
      : 'Bấm để BẬT tự động báo hàng khi có đơn về';
  }

  async function toggleAuto() {
    const next = !autoEnabled;
    if (next && !confirm('Bật TỰ ĐỘNG báo hàng? Hệ thống sẽ tự gửi tin cho mọi đơn "Chưa báo".')) return;
    try {
      const a = await App.api('/api/auto-notify/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      renderAutoBadge(a);
      App.toast(next ? '✅ Đã bật tự động báo hàng' : 'Đã tắt tự động báo hàng');
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
    }
  }

  // ---------------- Test kết nối Basso ----------------
  async function pingBasso() {
    const btn = $('bassoBtn');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang kiểm tra...';
    try {
      const r = await App.api('/api/basso/ping');
      if (r.connected) {
        const s = r.sample ? ` · đơn mẫu: ${r.sample.customerName}` : ' · danh sách trống';
        App.toast(`✅ Basso OK (${r.ms}ms · ${r.total ?? 0} đơn${s})`, 6000);
      } else if (r.mock) {
        App.toast('⚠️ Đang ở chế độ MOCK — chưa nối Basso thật (đặt BASSO_API_BASE_URL, USE_MOCK=false).', 7000);
      } else {
        App.toast(`❌ Không kết nối được Basso: ${r.error}`, 8000);
      }
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  }

  // ---------------- Events ----------------
  $('bassoBtn').addEventListener('click', pingBasso);
  $('syncBtn').addEventListener('click', () => load());
  // Dropdown trạng thái lọc client-side (đã có đủ đơn) + đồng bộ highlight nhóm
  $('fStatus').addEventListener('change', (e) => {
    const v = e.target.value;
    currentGroup = (v && v !== 'all') ? groupOfCode(v) : 'all';
    render();
  });
  $('fStaff').addEventListener('change', (e) => { currentStaff = e.target.value; load(); });
  ['fFrom', 'fTo'].forEach((id) => $(id).addEventListener('change', load));

  // Bộ lọc nâng cao: thu gọn mặc định, ô tìm kiếm luôn hiện.
  // Đếm số filter đang bật để hiện badge -> tránh "ẩn rồi quên đang lọc".
  function updateFilterCount() {
    let n = 0;
    if ($('fFrom').value) n++;
    if ($('fTo').value) n++;
    if ($('fStatus').value && $('fStatus').value !== 'all') n++;
    if ($('fStaff').value) n++;
    const badge = $('filterCount');
    badge.textContent = n;
    badge.hidden = n === 0;
  }
  $('filterToggle').addEventListener('click', () => {
    const panel = $('advFilters');
    const open = panel.hidden;
    panel.hidden = !open;
    $('filterToggle').setAttribute('aria-expanded', String(open));
  });
  ['fFrom', 'fTo', 'fStatus', 'fStaff'].forEach((id) => $(id).addEventListener('change', updateFilterCount));
  updateFilterCount();
  let qTimer;
  $('fQ').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(load, 400); });
  $('bulkBtn').addEventListener('click', bulkSend);
  $('autoBadge').addEventListener('click', toggleAuto);

  $('staffTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    currentStaff = tab.dataset.staff || '';
    load();
  });

  // Bấm thẻ nhóm = lọc client-side (bấm lại để bỏ lọc). Reset dropdown trạng thái.
  $('groupBar').addEventListener('click', (e) => {
    const card = e.target.closest('.group-card');
    if (!card) return;
    const key = card.dataset.group;
    currentGroup = (currentGroup === key) ? 'all' : key;
    $('fStatus').value = 'all';
    render();
  });

  // Delegation cho bảng
  rowsEl.addEventListener('click', (e) => {
    const t = e.target;
    const exp = t.closest('.expand-btn'); if (exp) return toggleDetail(exp.dataset.id);
    const vc = t.closest('.view-content'); if (vc) return openModal(vc.dataset.id, vc.dataset.kind);
    const sz = t.closest('.send-zalo'); if (sz) return sendZalo(sz.dataset.id, undefined, sz, sz.dataset.kind || 'hang');
    const ec = t.closest('.edit-content'); if (ec) return openModal(ec.dataset.id, 'hang');
    const sn = t.closest('.save-note'); if (sn) return saveNote(sn.dataset.id);
  });
  rowsEl.addEventListener('change', (e) => {
    const sel = e.target.closest('.status-sel');
    if (sel) changeStatus(sel.dataset.id, sel.value);
  });

  $('modalCancel').addEventListener('click', closeModal);
  $('modalSend').addEventListener('click', sendFromModal);
  $('modalMsg').addEventListener('input', autoGrowMsg);
  $('modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

  loadHealth();
  setInterval(loadHealth, 15000);
  setInterval(autoSync, AUTO_SYNC_MS);
  load();
})();
