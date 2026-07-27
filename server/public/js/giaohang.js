/* Trang "Quản lý giao hàng" — gọi /api/shipping (Basso web admin). */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = {
    page: 1,
    branch: '',
    orders: [],
    pagination: null,
    carriers: new Map(), // shipping_id -> tên ĐVVC (gom dần để đổ dropdown lọc)
    staff: new Set(),     // tên NV duyệt (lọc client-side)
    expanded: new Set(),  // id đơn đang mở chi tiết
  };

  // ---- Nhãn/format ------------------------------------------------------
  const STATUS_CLASS = { waiting: 'waiting', exported: 'exported', completed: 'completed' };
  function statusBadge(o) {
    const cls = STATUS_CLASS[o.statusCode] || 'unknown';
    // "Chưa soạn" (chờ giao) khi chưa prepared, dù status vẫn waiting.
    const label = (!o.isPrepared && o.statusCode === 'waiting') ? 'Chờ giao hàng' : (o.status || o.statusCode);
    return `<span class="ship-badge ${cls}">${App.esc(label)}</span>`;
  }

  // Nút thao tác theo trạng thái đơn (bám theo giao diện Basso).
  function actionButtons(o) {
    if (!o.isPrepared && o.statusCode === 'waiting') {
      return `<button class="btn accent" data-act="prepared" data-id="${o.id}">✔ Đã soạn hàng</button>`;
    }
    if (o.statusCode === 'waiting') {
      return `<button class="btn accent" data-act="ship" data-id="${o.id}">✔ Giao shipper</button>
              <button class="btn secondary" data-act="revert" data-id="${o.id}">← Chưa giao hàng</button>`;
    }
    if (o.statusCode === 'exported') {
      return `<button class="btn accent" data-act="complete" data-id="${o.id}">✔ Đã giao hàng</button>
              <button class="btn secondary" data-act="revert" data-id="${o.id}">← Chưa giao hàng</button>`;
    }
    if (o.statusCode === 'completed') {
      return `<button class="btn secondary" data-act="revert" data-id="${o.id}">← Hoàn tác</button>`;
    }
    return '';
  }

  // ---- Render -----------------------------------------------------------
  function render() {
    const tb = $('rows');
    let list = state.orders;
    // Lọc NV phụ trách phía client (theo tên approve_user của SP trong đơn) — API không nhận tên NV.
    const staff = $('fStaff').value;
    if (staff) list = list.filter((o) => o.items.some((it) => it.approveUser === staff));

    if (!list.length) {
      tb.innerHTML = `<tr><td colspan="14" class="empty">${state.mock ? 'Chưa cấu hình BASSO_WEB_COOKIE — chưa đọc được dữ liệu giao hàng thật.' : 'Không có đơn nào.'}</td></tr>`;
      return;
    }

    const rows = [];
    for (const o of list) {
      const codPayer = o.shipPayer === 'company' ? '<div class="ship-sub">Cty trả</div>' : '';
      rows.push(`
        <tr data-id="${o.id}">
          <td class="center"><input type="checkbox" class="rowchk" data-id="${o.id}"></td>
          <td class="center"><span class="ship-eye" data-eye="${o.id}" title="Xem chi tiết">${App.icon('search')}</span></td>
          <td>${App.esc(o.createdAt)}</td>
          <td>${App.esc(o.recipient)}</td>
          <td>${App.esc(o.trackingCode) || '<span class="muted">—</span>'}</td>
          <td>${App.esc(o.phone)}</td>
          <td>${App.esc(o.address)}</td>
          <td>${App.esc(o.note) || ''}</td>
          <td class="center">${App.fmtVnd(o.codAmount) || '0₫'}</td>
          <td class="center">${App.fmtVnd(o.shipFee) || '0₫'}${codPayer}</td>
          <td><span class="ship-carrier">${App.icon('truck')} ${App.esc(o.shipping)}</span></td>
          <td>${statusBadge(o)}</td>
          <td>${App.esc(o.preparedAt) || '<span class="muted">—</span>'}</td>
          <td><div class="ship-actions">${actionButtons(o)}</div></td>
        </tr>`);
      if (state.expanded.has(String(o.id))) rows.push(detailRow(o));
    }
    tb.innerHTML = rows.join('');
  }

  function detailRow(o) {
    const items = o.items.map((it, i) => `
      <tr>
        <td>${App.esc(it.orderCode)}</td>
        <td>${i + 1}</td>
        <td>${it.image ? `<img src="${App.esc(it.image)}" loading="lazy">` : ''}</td>
        <td>${App.esc(it.name)}</td>
        <td>${it.quantity ?? ''}</td>
        <td>${it.variations.map((v) => `${App.esc(v.name)}: ${App.esc(v.value)}`).join(', ')}</td>
        <td>${App.esc(it.approveUser)}</td>
      </tr>`).join('');
    return `<tr class="ship-detail"><td colspan="14">
      <table><thead><tr><th>Mã ĐH</th><th>STT</th><th>Hình ảnh</th><th>Tên SP</th><th>SL</th><th>Variant</th><th>NV duyệt</th></tr></thead>
      <tbody>${items || '<tr><td colspan="7" class="empty">Không có sản phẩm.</td></tr>'}</tbody></table>
    </td></tr>`;
  }

  function fillFilters() {
    // ĐVVC
    const cSel = $('fCarrier');
    const cur = cSel.value;
    const opts = ['<option value="0">Tất cả ĐVVC</option>'];
    for (const [id, name] of state.carriers) opts.push(`<option value="${App.esc(id)}">${App.esc(name)}</option>`);
    cSel.innerHTML = opts.join('');
    cSel.value = cur;
    // NV
    const sSel = $('fStaff');
    const curS = sSel.value;
    const sOpts = ['<option value="">Tất cả nhân viên</option>'];
    [...state.staff].sort().forEach((n) => sOpts.push(`<option value="${App.esc(n)}">${App.esc(n)}</option>`));
    sSel.innerHTML = sOpts.join('');
    sSel.value = curS;
  }

  function renderPager() {
    const p = state.pagination;
    const el = $('pager');
    if (!p || Number(p.total_page) <= 1) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const cur = Number(p.current_page) || state.page;
    const total = Number(p.total_page);
    el.innerHTML = `
      <button class="btn secondary small" ${cur <= 1 ? 'disabled' : ''} id="pgPrev">← Trước</button>
      <span class="muted" style="padding:0 10px">Trang ${cur}/${total} · ${p.total_item} đơn</span>
      <button class="btn secondary small" ${cur >= total ? 'disabled' : ''} id="pgNext">Sau →</button>`;
    $('pgPrev') && ($('pgPrev').onclick = () => { state.page = cur - 1; load(); });
    $('pgNext') && ($('pgNext').onclick = () => { state.page = cur + 1; load(); });
  }

  // ---- Load -------------------------------------------------------------
  async function load() {
    $('rows').innerHTML = '<tr><td colspan="14" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    params.set('page', state.page);
    params.set('shipping_id', $('fCarrier').value || 0);
    params.set('status', $('fStatus').value || 'all');
    if ($('fDate').value) {
      const [y, m, d] = $('fDate').value.split('-');
      params.set('filter_date', `${d}-${m}-${y}`); // API cần DD-MM-YYYY
    }
    if ($('fQ').value.trim()) params.set('key', $('fQ').value.trim());
    if (state.branch) params.set('branch', state.branch);
    try {
      const r = await App.api('/api/shipping?' + params.toString());
      state.orders = r.orders || [];
      state.pagination = r.pagination;
      state.mock = r.source === 'mock';
      $('mockBadge').style.display = state.mock ? '' : 'none';
      // Gom ĐVVC + NV để đổ dropdown lọc
      for (const o of state.orders) {
        if (o.shippingId != null && o.shipping) state.carriers.set(String(o.shippingId), o.shipping);
        o.items.forEach((it) => it.approveUser && state.staff.add(it.approveUser));
      }
      fillFilters();
      const p = state.pagination;
      $('countInfo').textContent = p ? `${p.total_item} đơn · trang ${p.current_page}/${p.total_page}` : `${state.orders.length} đơn`;
      render();
      renderPager();
    } catch (e) {
      $('rows').innerHTML = `<tr><td colspan="14" class="empty">Lỗi: ${App.esc(e.message)}</td></tr>`;
    }
  }

  // ---- Thao tác ---------------------------------------------------------
  async function doAction(id, kind) {
    try {
      const r = await App.api('/api/shipping/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, kind }),
      });
      App.toast(`${r.message || 'Cập nhật thành công'}${r.statusLabel ? ' → ' + r.statusLabel : ''}`);
      load();
    } catch (e) {
      App.toast('Lỗi: ' + App.friendlyError(e.message));
    }
  }

  function checkedIds() {
    return [...document.querySelectorAll('.rowchk:checked')].map((c) => c.dataset.id);
  }
  async function bulk(kind) {
    const ids = checkedIds();
    if (!ids.length) { App.toast('Chưa chọn đơn nào.'); return; }
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      try { await App.api('/api/shipping/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, kind }) }); } catch (_) {}
    }
    App.toast(`Đã xử lý ${ids.length} đơn.`);
    load();
  }

  // ---- Events -----------------------------------------------------------
  function bind() {
    $('btnSearch').onclick = () => { state.page = 1; load(); };
    $('fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.page = 1; load(); } });
    ['fCarrier', 'fStatus', 'fDate'].forEach((id) => $(id).addEventListener('change', () => { state.page = 1; load(); }));
    $('fStaff').addEventListener('change', render); // lọc NV client-side, không gọi lại API
    $('branchTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.branch = b.dataset.branch; state.page = 1;
      $('branchTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      load();
    });
    $('btnBulkShip').onclick = () => bulk('ship');
    $('btnBulkComplete').onclick = () => bulk('complete');
    $('btnPrint').onclick = () => App.toast('In phiếu: chưa bắt được API — bổ sung sau khi lấy endpoint.');
    // Delegation cho nút thao tác + con mắt xem chi tiết
    $('rows').addEventListener('click', (e) => {
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        const id = eye.dataset.eye;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        render();
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (btn) doAction(btn.dataset.id, btn.dataset.act);
    });
  }

  bind();
  load();
})();
