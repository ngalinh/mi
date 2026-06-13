(() => {
  let orders = [];
  let tabUsers = [];
  let currentStaff = ''; // user_id đang lọc ('' = tất cả)
  const openRows = new Set();

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  const DONE = new Set(['notified_arrival', 'notified_ship']);
  // "Đã báo" = web đã đánh dấu, HOẶC mi đã gửi (bot 'success' / đã báo tay 'manual').
  // Dùng để loại khỏi "Báo hàng loạt" -> tránh gửi trùng cho khách đã nhắn.
  const SENT_LOCAL = new Set(['success', 'manual']);
  const isNotified = (o) => DONE.has(o.statusCode) || (o.autoNotified && SENT_LOCAL.has(o.autoNotified.status));
  const STATUS_OPTS = [
    ['not_sent', 'Chưa báo'],
    ['notified_arrival', 'Đã báo hàng'],
    ['notified_ship', 'Đã báo ship'],
    ['send_failed', 'Gửi lỗi'],
  ];

  const byId = (id) => orders.find((o) => String(o.id) === String(id));

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
      return `<span class="bot-tag bot-manual" title="Đã báo tay trong mi${when ? ' lúc ' + when : ''}">✋ Đã báo tay</span>`;
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
        <td>${App.esc(it.orderCode)}</td>
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
    const noZalo = o.hasZalo === false
      ? ` <span class="muted" title="Khách chưa có Zalo — có thể gửi lỗi">${App.icon('alert')}</span>` : '';
    const main = `<tr class="main-row" data-id="${App.esc(o.id)}">
      <td class="center"><button class="expand-btn ${open ? 'open' : ''}" data-id="${App.esc(o.id)}">${App.icon('chevron')}</button></td>
      <td class="center">${App.esc(o.stt ?? '')}</td>
      <td>${App.esc(o.warehouseDate)}</td>
      <td class="cust">${App.esc(o.customerName)}${noZalo}</td>
      <td>${App.esc(o.phone)}</td>
      <td class="center">${contentCell(o.noiDungBaoHang, o.id, 'hang')}</td>
      <td class="center">${contentCell(o.noiDungBaoShip, o.id, 'ship')}</td>
      <td>${statusSelect(o)}${botTag(o)}</td>
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

  function render() {
    if (!orders.length) {
      rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Không có dữ liệu</td></tr>';
      updateCount();
      return;
    }
    rowsEl.innerHTML = orders.map(rowHtml).join('');
    updateCount();
    // Dòng đang mở: load (hoặc render lại) chi tiết sản phẩm
    orders.forEach((o) => { if (openRows.has(String(o.id))) loadItems(o); });
  }

  function updateCount() {
    const chua = orders.filter((o) => !isNotified(o)).length;
    $('countInfo').textContent = `${orders.length} đơn · ${chua} chưa báo`;
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
      // cập nhật màu select + nhãn
      const sel = rowsEl.querySelector(`.status-sel[data-id="${cssEsc(String(id))}"]`);
      if (sel) sel.setAttribute('data-code', code);
      updateCount();
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
    const btn = btnEl || rowsEl.querySelector(`.send-zalo[data-id="${cssEsc(String(id))}"][data-kind="${kind}"]`);
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang gửi...'; }
    try {
      const res = await App.api('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: [id], messageOverride: messageOverride || undefined, kind }),
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
    const ids = orders.filter((o) => !isNotified(o)).map((o) => String(o.id));
    if (!ids.length) return;
    if (!confirm(`Gửi báo hàng cho ${ids.length} khách chưa báo?`)) return;
    const btn = $('bulkBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang gửi...';
    try {
      const res = await App.api('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: ids }),
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
  async function load() {
    rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    const f = $('fFrom').value, t = $('fTo').value, st = $('fStatus').value, q = $('fQ').value;
    if (f) params.set('from', f);
    if (t) params.set('to', t);
    if (st && st !== 'all') params.set('status', st);
    if (currentStaff) params.set('staff', currentStaff);
    if (q) params.set('q', q);
    try {
      const res = await App.api('/api/orders?' + params.toString());
      orders = res.orders || [];
      if (res.tabUsers && res.tabUsers.length) tabUsers = res.tabUsers;
      openRows.clear();
      renderTabs();
      populateStaff();
      render();
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="10" class="empty">Lỗi tải: ${App.esc(e.message)}</td></tr>`;
    }
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
  $('syncBtn').addEventListener('click', load);
  $('fStatus').addEventListener('change', load);
  $('fStaff').addEventListener('change', (e) => { currentStaff = e.target.value; load(); });
  ['fFrom', 'fTo'].forEach((id) => $(id).addEventListener('change', load));
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
  $('modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

  loadHealth();
  setInterval(loadHealth, 15000);
  load();
})();
