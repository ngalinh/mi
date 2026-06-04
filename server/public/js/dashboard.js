(() => {
  let orders = [];
  let tabUsers = [];
  let currentStaff = ''; // user_id đang lọc ('' = tất cả)
  const openRows = new Set();

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  const DONE = new Set(['notified_arrival', 'notified_ship']);
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

  function contentCell(text, id, kind) {
    if (!text || !String(text).trim()) return '<span class="muted">—</span>';
    return `<button class="link-btn view-content" data-id="${App.esc(id)}" data-kind="${kind}">Xem nội dung</button>`;
  }

  function rowHtml(o) {
    const open = openRows.has(String(o.id));
    const noZalo = o.hasZalo === false
      ? ' <span class="muted" title="Khách chưa có Zalo — có thể gửi lỗi">⚠️</span>' : '';
    const main = `<tr class="main-row" data-id="${App.esc(o.id)}">
      <td class="center"><button class="expand-btn ${open ? 'open' : ''}" data-id="${App.esc(o.id)}">›</button></td>
      <td class="center">${App.esc(o.stt ?? '')}</td>
      <td>${App.esc(o.warehouseDate)}</td>
      <td class="cust">${App.esc(o.customerName)}${noZalo}</td>
      <td>${App.esc(o.phone)}</td>
      <td class="center">${contentCell(o.noiDungBaoHang, o.id, 'hang')}</td>
      <td class="center">${contentCell(o.noiDungBaoShip, o.id, 'ship')}</td>
      <td>${statusSelect(o)}</td>
      <td><div class="note-cell">
        <input class="note-input" data-id="${App.esc(o.id)}" value="${App.esc(o.note)}" placeholder="Ghi chú..." />
        <button class="save-note" data-id="${App.esc(o.id)}" title="Lưu ghi chú">💾</button>
      </div></td>
      <td>${App.esc(o.staff)}</td>
    </tr>`;

    const detail = `<tr class="detail-row ${open ? '' : 'hidden'}" data-detail="${App.esc(o.id)}">
      <td colspan="10"><div class="detail-box">
        <div><h4>ND báo hàng</h4><pre>${App.esc(o.noiDungBaoHang) || '(trống)'}</pre></div>
        <div><h4>ND báo ship</h4><pre>${App.esc(o.noiDungBaoShip) || '(trống)'}</pre></div>
        <div class="full detail-actions">
          <button class="btn small send-zalo" data-id="${App.esc(o.id)}" data-kind="hang">📣 Gửi báo hàng qua Zalo</button>
          ${o.noiDungBaoShip && o.noiDungBaoShip.trim()
            ? `<button class="btn small send-zalo" data-id="${App.esc(o.id)}" data-kind="ship">📦 Gửi báo ship qua Zalo</button>` : ''}
          <button class="btn small secondary edit-content" data-id="${App.esc(o.id)}">✏️ Sửa nội dung rồi gửi</button>
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
  }

  function updateCount() {
    const chua = orders.filter((o) => !DONE.has(o.statusCode)).length;
    $('countInfo').textContent = `${orders.length} đơn · ${chua} chưa báo`;
    $('bulkBtn').disabled = chua === 0;
  }

  // ---------------- Mở rộng dòng ----------------
  function toggleDetail(id) {
    const key = String(id);
    if (openRows.has(key)) openRows.delete(key); else openRows.add(key);
    const detail = rowsEl.querySelector(`tr.detail-row[data-detail="${cssEsc(key)}"]`);
    const btn = rowsEl.querySelector(`.expand-btn[data-id="${cssEsc(key)}"]`);
    if (detail) detail.classList.toggle('hidden', !openRows.has(key));
    if (btn) btn.classList.toggle('open', openRows.has(key));
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
    $('modalSend').textContent = isShip ? '📦 Gửi báo ship qua Zalo' : '📣 Gửi báo hàng qua Zalo';
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
    const ids = orders.filter((o) => !DONE.has(o.statusCode)).map((o) => String(o.id));
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
      btn.innerHTML = '📣 Báo hàng loạt (chưa báo)';
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
    } catch { /* ignore */ }
  }

  // ---------------- Events ----------------
  $('syncBtn').addEventListener('click', load);
  $('fStatus').addEventListener('change', load);
  $('fStaff').addEventListener('change', (e) => { currentStaff = e.target.value; load(); });
  ['fFrom', 'fTo'].forEach((id) => $(id).addEventListener('change', load));
  let qTimer;
  $('fQ').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(load, 400); });
  $('bulkBtn').addEventListener('click', bulkSend);

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
