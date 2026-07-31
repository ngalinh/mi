/* Trang "Quản lý giao hàng" — gọi Partner API qua /api/shipping* (mục 8.10 tài liệu Basso). */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = {
    page: 1,
    branch: '',
    orders: [],
    total: 0,
    pageSize: 20,
    meta: null,
    shipperLinkIds: new Set(), // ĐVVC bắt buộc shipper_link (AhaMove/Grab)
    expanded: new Set(),
  };

  // "DD/MM/YYYY HH:MM" -> ngày trên, giờ dưới (mờ) cho cột hẹp.
  function splitDateTime(s) {
    const [d, t] = String(s || '').split(' ');
    if (!d) return '<span class="muted">—</span>';
    return `<div>${App.esc(d)}</div>${t ? `<div class="ship-sub">${App.esc(t)}</div>` : ''}`;
  }

  // ISO string (server) -> "DD/MM HH:MM" gọn cho dòng nhỏ dưới nút "Xem".
  function fmtSentAt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  const STATUS_CLASS = { waiting: 'waiting', waiting_prepared: 'waiting', exported: 'exported', carrier_submitted: 'exported', completed: 'completed' };
  function statusBadge(o) {
    const cls = STATUS_CLASS[o.statusCode] || (o.isPrepared ? 'waiting' : 'unknown');
    return `<span class="ship-badge ${cls}">${App.esc(o.status || o.statusCode)}</span>`;
  }

  // Nút thao tác theo trạng thái (bám luồng: waiting → đã soạn → exported → completed).
  function actionButtons(o) {
    if (o.statusCode === 'completed') {
      return `<button class="btn secondary" data-act="revert" data-id="${o.id}">${App.icon('undo')} Hoàn tác</button>`;
    }
    if (o.statusCode === 'exported' || o.statusCode === 'carrier_submitted') {
      return `<button class="btn accent" data-act="complete" data-id="${o.id}">${App.icon('check')} Đã giao hàng</button>`;
    }
    // waiting
    if (!o.isPrepared) {
      return `<button class="btn accent" data-act="prepared" data-id="${o.id}">${App.icon('check')} Đã soạn hàng</button>`;
    }
    return `<button class="btn accent" data-act="ship" data-id="${o.id}">${App.icon('check')} Giao shipper</button>
            <button class="btn secondary" data-act="revert" data-id="${o.id}">${App.icon('undo')} Chưa giao hàng</button>`;
  }

  // Đơn có thể xem trước tin báo ship: đã có link, hoặc đã giao shipper/đã giao/lên đơn vận.
  function canPreviewMsg(o) {
    return !!o.shipperLink || ['exported', 'completed', 'carrier_submitted'].includes(o.statusCode);
  }

  // ---- Render -----------------------------------------------------------
  function render() {
    const tb = $('rows');
    if (!state.orders.length) {
      tb.innerHTML = `<tr><td colspan="14" class="empty">${state.mock ? 'Chưa cấu hình Partner API — đang hiển thị dữ liệu mẫu.' : 'Không có đơn nào.'}</td></tr>`;
      return;
    }
    const rows = [];
    for (const o of state.orders) {
      const codPayer = o.shipPayerLabel ? `<div class="ship-sub">${App.esc(o.shipPayerLabel)}</div>` : '';
      rows.push(`
        <tr data-id="${o.id}">
          <td class="center"><input type="checkbox" class="rowchk" data-id="${o.id}"></td>
          <td class="center"><span class="ship-eye" data-eye="${o.id}" title="Xem chi tiết">${App.icon('eye')}</span></td>
          <td class="gh-datecell">${splitDateTime(o.createdAt)}</td>
          <td>
            <div>${App.esc(o.recipient)}</div>
            ${o.phone ? `<div class="ship-sub gh-nowrap" title="${App.esc(o.phone)}">${App.esc(o.phone)}</div>` : ''}
          </td>
          <td>
            <div class="gh-nowrap" title="${App.esc(o.trackingCode)}">${App.esc(o.trackingCode) || '<span class="muted">—</span>'}</div>
            ${o.shipperLink ? `<a class="ship-link" href="${App.esc(o.shipperLink)}" target="_blank" rel="noopener" title="${App.esc(o.shipperLink)}">${App.icon('link')} ${App.esc(o.shipperLink)}</a>` : ''}
          </td>
          <td>${App.esc(o.address)}</td>
          <td>${App.esc(o.note) || ''}</td>
          <td class="center">${App.fmtVnd(o.codAmount) || '0₫'}</td>
          <td class="center">${App.fmtVnd(o.shipFee) || '0₫'}${codPayer}</td>
          <td><span class="ship-carrier">${App.icon('truck')} ${App.esc(o.shipping)}</span></td>
          <td>${statusBadge(o)}</td>
          <td class="gh-datecell">${splitDateTime(o.preparedAt)}</td>
          <td class="center">${canPreviewMsg(o) ? `<button class="btn secondary small" data-msg="${o.id}">${App.icon('message')} Xem</button>${o.shipSentAt ? `<div class="ship-sub ship-sent-at">${App.icon('clock')} ${App.esc(fmtSentAt(o.shipSentAt))}</div>` : ''}` : '<span class="muted">—</span>'}</td>
          <td><div class="ship-actions">${actionButtons(o)}</div></td>
        </tr>`);
      if (state.expanded.has(String(o.id))) rows.push(detailRow(o));
    }
    tb.innerHTML = rows.join('');
  }

  function detailRow(o) {
    const items = o.items.map((it, i) => `
      <tr>
        <td class="center ship-list-stt">${i + 1}</td>
        <td>${it.image ? `<img class="ship-list-thumb" src="${App.esc(it.image)}" loading="lazy" alt="">` : `<span class="ship-list-thumb">${App.icon('box')}</span>`}</td>
        <td>${it.orderCode ? `<span class="ship-chip code">${App.esc(it.orderCode)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="ship-list-name">${App.esc(it.name) || '(không tên)'}</td>
        <td>${it.variations.length ? it.variations.map((v) => `<span class="ship-chip">${App.esc(v.name)}: ${App.esc(v.value)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
        <td class="center ship-list-qty">${it.quantity ?? 1}</td>
        <td>${App.esc(it.approveUser) || '<span class="muted">—</span>'}</td>
      </tr>`).join('');
    return `<tr class="ship-detail"><td colspan="14">
      <div class="ship-detail-wrap">
        <div class="ship-detail-head">${App.icon('box')} Sản phẩm trong đơn (${o.items.length})</div>
        <table class="ship-list">
          <thead><tr>
            <th style="width:36px" class="center">STT</th><th style="width:52px">Ảnh</th>
            <th style="width:120px">Mã ĐH</th><th>Tên sản phẩm</th><th>Phân loại</th>
            <th style="width:44px" class="center">SL</th><th style="width:110px">NV duyệt</th>
          </tr></thead>
          <tbody>${items || '<tr><td colspan="7" class="muted" style="padding:12px">Không có sản phẩm.</td></tr>'}</tbody>
        </table>
      </div>
    </td></tr>`;
  }

  // ---- Meta (dropdown filter) -------------------------------------------
  async function loadMeta() {
    try {
      const m = await App.api('/api/shipping/meta');
      state.meta = m;
      (m.shipper_link_shipping_ids || []).forEach((id) => state.shipperLinkIds.add(String(id)));
      // ĐVVC
      const c = $('fCarrier');
      c.innerHTML = ['<option value="0">Tất cả ĐVVC</option>']
        .concat((m.shipping_agencies || []).map((a) => `<option value="${App.esc(a.id)}">${App.esc(a.name)}</option>`)).join('');
      // Trạng thái
      const s = $('fStatus');
      s.innerHTML = ['<option value="all">Tất cả trạng thái</option>']
        .concat((m.statuses || []).map((x) => `<option value="${App.esc(x.code)}">${App.esc(x.name)}</option>`)).join('');
      // Nhân viên phụ trách (lọc server-side qua user_approve)
      const st = $('fStaff');
      st.innerHTML = ['<option value="">Tất cả nhân viên</option>']
        .concat((m.approve_users || []).map((u) => `<option value="${App.esc(u.id)}">${App.esc(u.name)}</option>`)).join('');
    } catch (_) { /* để nguyên option tĩnh nếu meta lỗi */ }
  }

  function renderPager() {
    const el = $('pager');
    const totalPage = Math.max(1, Math.ceil((state.total || 0) / (state.pageSize || 20)));
    if (totalPage <= 1) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `
      <button class="btn secondary small" ${state.page <= 1 ? 'disabled' : ''} id="pgPrev">← Trước</button>
      <span class="muted" style="padding:0 10px">Trang ${state.page}/${totalPage} · ${state.total} đơn</span>
      <button class="btn secondary small" ${state.page >= totalPage ? 'disabled' : ''} id="pgNext">Sau →</button>`;
    if ($('pgPrev')) $('pgPrev').onclick = () => { state.page -= 1; load(); };
    if ($('pgNext')) $('pgNext').onclick = () => { state.page += 1; load(); };
  }

  // ---- Load list --------------------------------------------------------
  async function load() {
    $('rows').innerHTML = '<tr><td colspan="14" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    params.set('page', state.page);
    params.set('shipping_id', $('fCarrier').value || 0);
    params.set('status', $('fStatus').value || 'all');
    if ($('fStaff').value) params.set('user_approve', $('fStaff').value);
    if ($('fDate').value) params.set('filter_date', $('fDate').value); // YYYY-MM-DD (Partner nhận trực tiếp)
    if ($('fQ').value.trim()) params.set('key', $('fQ').value.trim());
    if (state.branch) params.set('branch', state.branch);
    try {
      const r = await App.api('/api/shipping?' + params.toString());
      state.orders = r.orders || [];
      state.total = r.total || 0;
      state.pageSize = r.pageSize || 20;
      state.mock = r.source === 'mock';
      $('mockBadge').style.display = state.mock ? '' : 'none';
      $('countInfo').textContent = `${state.total} đơn · trang ${state.page}/${Math.max(1, Math.ceil(state.total / state.pageSize))}`;
      render();
      renderPager();
    } catch (e) {
      $('rows').innerHTML = `<tr><td colspan="14" class="empty">Lỗi: ${App.esc(e.message)}</td></tr>`;
    }
  }

  // ---- Thao tác ---------------------------------------------------------
  async function doAction(id, kind) {
    let shipperLink;
    if (kind === 'ship') {
      const o = state.orders.find((x) => String(x.id) === String(id));
      if (o && state.shipperLinkIds.has(String(o.shippingId))) {
        shipperLink = prompt(`Nhập link theo dõi shipper (${o.shipping}):`, o.shipperLink || '');
        if (shipperLink === null) return;            // huỷ
        if (!shipperLink.trim()) { App.toast('Cần link shipper cho ' + o.shipping); return; }
      }
    }
    try {
      const r = await App.api('/api/shipping/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, kind, shipperLink }),
      });
      App.toast(`Cập nhật thành công${r.statusLabel ? ' → ' + r.statusLabel : ''}`);
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
    try {
      const r = await App.api('/api/shipping/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, kind }),
      });
      const n = (r.ids && r.ids.length) || ids.length;
      App.toast(`Đã xử lý ${n} đơn${r.statusLabel ? ' → ' + r.statusLabel : ''}.`);
      load();
    } catch (e) {
      App.toast('Lỗi: ' + App.friendlyError(e.message));
    }
  }

  // In phiếu: mở cửa sổ in gọn từ các đơn đang chọn.
  function printSelected() {
    const ids = checkedIds();
    const list = state.orders.filter((o) => ids.includes(String(o.id)));
    if (!list.length) { App.toast('Chưa chọn đơn nào để in.'); return; }
    const rows = list.map((o) => `
      <div class="slip">
        <h3>${App.esc(o.recipient)} — ${App.esc(o.phone)}</h3>
        <p>${App.esc(o.address)}</p>
        <p><b>MVĐ:</b> ${App.esc(o.trackingCode || '—')} · <b>ĐVVC:</b> ${App.esc(o.shipping)} · <b>COD:</b> ${App.fmtVnd(o.codAmount) || '0₫'}</p>
        <ul>${o.items.map((it) => `<li>${App.esc(it.name)} ×${it.quantity ?? 1} ${it.variations.map((v) => App.esc(v.value)).join(' / ')}</li>`).join('')}</ul>
      </div>`).join('');
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Phiếu giao hàng</title><style>
      body{font-family:sans-serif;padding:16px} .slip{border:1px solid #ccc;border-radius:8px;padding:12px;margin-bottom:12px;page-break-inside:avoid}
      h3{margin:0 0 4px} p{margin:2px 0} ul{margin:6px 0 0 18px}</style></head><body>${rows}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  // ---- Xem + gửi tin báo ship (Pha 1) -------------------------------------
  // Payload gọn cho API: đủ field shippingNotify + shippingSendService cần (id/phone/items để
  // dedup, resolve account theo NV duyệt, khớp brand theo mã ĐH).
  function toApiOrder(o) {
    return {
      id: o.id, recipient: o.recipient, phone: o.phone, shipping: o.shipping, shippingId: o.shippingId,
      trackingCode: o.trackingCode, codAmount: o.codAmount, shipperLink: o.shipperLink,
      items: (o.items || []).map((it) => ({ approveUser: it.approveUser, orderCode: it.orderCode })),
    };
  }

  let msgCurrentId = null;

  async function showMessage(id) {
    const o = state.orders.find((x) => String(x.id) === String(id));
    if (!o) return;
    msgCurrentId = id;
    try {
      const r = await App.api('/api/shipping/message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: toApiOrder(o) }),
      });
      $('msgSub').textContent = `${o.recipient} · ${o.shipping} · ${o.trackingCode || ''}`;
      const t = $('msgText');
      const sentNote = $('msgSentNote');
      const sendBtn = $('msgSend');
      if (r.sendable) {
        t.value = r.message; t.disabled = false; $('msgCopy').style.display = '';
        if (r.alreadySent) {
          sentNote.style.display = ''; sentNote.innerHTML = `${App.icon('check')} Đã gửi lúc ${App.esc(fmtSentAt(r.sentAt))}`;
          sendBtn.style.display = 'none';
        } else {
          sentNote.style.display = 'none';
          sendBtn.style.display = ''; sendBtn.disabled = false; sendBtn.innerHTML = `${App.icon('send')} Gửi Zalo`;
        }
      } else {
        t.value = '⚠️ ' + (r.reasonLabel || 'Chưa gửi được.'); t.disabled = true; $('msgCopy').style.display = 'none';
        sentNote.style.display = 'none'; sendBtn.style.display = 'none';
      }
      $('msgModalBg').classList.add('show');
    } catch (e) { App.toast('Lỗi: ' + e.message); }
  }
  function closeMsg() { $('msgModalBg').classList.remove('show'); msgCurrentId = null; }

  async function sendMessage() {
    const id = msgCurrentId;
    const o = state.orders.find((x) => String(x.id) === String(id));
    if (!o) return;
    const sendBtn = $('msgSend');
    sendBtn.disabled = true; sendBtn.textContent = 'Đang gửi...';
    try {
      const r = await App.api('/api/shipping/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: toApiOrder(o) }),
      });
      if (r.ok) {
        App.toast('✅ Đã gửi báo ship.');
        const sentAtRaw = r.sentAt || new Date().toISOString();
        $('msgSentNote').style.display = ''; $('msgSentNote').innerHTML = `${App.icon('check')} Đã gửi lúc ${App.esc(fmtSentAt(sentAtRaw))}`;
        sendBtn.style.display = 'none';
        o.shipSentAt = sentAtRaw; render();
      } else {
        App.toast('Lỗi: ' + App.friendlyError(r.error || 'Gửi thất bại.'));
        sendBtn.disabled = false; sendBtn.innerHTML = `${App.icon('send')} Gửi Zalo`;
      }
    } catch (e) {
      App.toast('Lỗi: ' + App.friendlyError(e.message));
      sendBtn.disabled = false; sendBtn.innerHTML = `${App.icon('send')} Gửi Zalo`;
    }
  }

  // ---- Gửi báo ship hàng loạt (tick nhiều) --------------------------------
  async function bulkNotify() {
    const ids = checkedIds();
    if (!ids.length) { App.toast('Chưa chọn đơn nào.'); return; }
    const orders = state.orders.filter((o) => ids.includes(String(o.id))).map(toApiOrder);
    if (!confirm(`Gửi báo ship qua Zalo cho ${orders.length} đơn đã tick?`)) return;
    try {
      const r = await App.api('/api/shipping/send-bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders }),
      });
      App.toast(`Đã gửi ${r.sent}/${r.total} đơn${r.failed ? `, ${r.failed} lỗi` : ''}.`);
      load();
    } catch (e) {
      App.toast('Lỗi: ' + App.friendlyError(e.message));
    }
  }

  // ---- Events -----------------------------------------------------------
  function bind() {
    $('btnBulkNotify').innerHTML = `${App.icon('message')} Gửi báo ship`;
    $('msgCopy').innerHTML = `${App.icon('copy')} Copy`;
    $('msgSend').innerHTML = `${App.icon('send')} Gửi Zalo`;
    $('msgClose').onclick = closeMsg;
    $('msgModalBg').addEventListener('click', (e) => { if (e.target.id === 'msgModalBg') closeMsg(); });
    $('msgCopy').onclick = () => {
      const t = $('msgText'); t.select();
      const done = () => App.toast('Đã copy nội dung');
      if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(done).catch(() => { document.execCommand('copy'); done(); });
      else { document.execCommand('copy'); done(); }
    };
    $('msgSend').onclick = sendMessage;
    $('btnBulkNotify').onclick = bulkNotify;
    $('btnSearch').onclick = () => { state.page = 1; load(); };
    $('fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.page = 1; load(); } });
    ['fCarrier', 'fStatus', 'fDate', 'fStaff'].forEach((id) => $(id).addEventListener('change', () => { state.page = 1; load(); }));
    $('branchTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.branch = b.dataset.branch; state.page = 1;
      $('branchTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      load();
    });
    $('btnBulkShip').onclick = () => bulk('ship');
    $('btnBulkComplete').onclick = () => bulk('complete');
    $('btnPrint').onclick = printSelected;
    $('rows').addEventListener('click', (e) => {
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        const id = eye.dataset.eye;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        render();
        return;
      }
      const msg = e.target.closest('[data-msg]');
      if (msg) { showMessage(msg.dataset.msg); return; }
      const btn = e.target.closest('[data-act]');
      if (btn) doAction(btn.dataset.id, btn.dataset.act);
    });
  }

  bind();
  loadMeta();
  load();
})();
