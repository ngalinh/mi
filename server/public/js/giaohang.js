/* Trang "Quản lý giao hàng" — gọi Partner API qua /api/shipping* (mục 8.10 tài liệu Basso). */
(function () {
  const $ = (id) => document.getElementById(id);

  // ---- Cột hiển thị (ẩn/hiện tuỳ NV — vd chỉ cần Mã vận đơn + ND ship khi đi báo ship) --------
  // Vị trí `n` PHẢI khớp đúng thứ tự <th>/<td> trong giaohang.html (nth-child) — đổi thứ tự cột ở
  // đó thì sửa lại `n` tương ứng ở đây. Lưu lựa chọn ở localStorage -> nhớ qua lần tải trang sau.
  const COLS = [
    { key: 'date', label: 'Ngày tạo vận đơn', n: 3 },
    { key: 'recipient', label: 'Người nhận', n: 4 },
    { key: 'staff', label: 'Nhân viên', n: 5 },
    { key: 'channel', label: 'Kênh sale', n: 6 },
    { key: 'code', label: 'Mã vận đơn', n: 7 },
    { key: 'address', label: 'Địa chỉ', n: 8 },
    { key: 'note', label: 'Ghi chú', n: 9 },
    { key: 'cod', label: 'Thu COD', n: 10 },
    { key: 'shipfee', label: 'Phí ship', n: 11 },
    { key: 'carrier', label: 'Đơn vị vận chuyển', n: 12 },
    { key: 'status', label: 'Trạng thái', n: 13 },
    { key: 'preparedAt', label: 'Thời gian soạn hàng', n: 14 },
    { key: 'ndship', label: 'ND ship', n: 15 },
  ];
  const COLVIS_LS_KEY = 'mi.giaohang.hiddenCols';
  function loadHiddenCols() {
    try { return new Set(JSON.parse(localStorage.getItem(COLVIS_LS_KEY) || '[]')); } catch { return new Set(); }
  }

  const state = {
    page: 1,
    branch: '',
    orders: [],
    total: 0,
    pageSize: 20,
    meta: null,
    shipperLinkIds: new Set(), // ĐVVC bắt buộc shipper_link (AhaMove/Grab)
    expanded: new Set(),
    addrExpanded: new Set(), // id vận đơn đang mở rộng xem đầy đủ địa chỉ
    hiddenCols: loadHiddenCols(), // Set các key cột đang ẨN (xem "Cột hiển thị" bên dưới)
  };

  // "DD/MM/YYYY HH:MM" -> ngày trên, giờ dưới (mờ) cho cột hẹp.
  function splitDateTime(s) {
    const [d, t] = String(s || '').split(' ');
    if (!d) return '<span class="muted">—</span>';
    return `<div>${App.esc(d)}</div>${t ? `<div class="ship-sub">${App.esc(t)}</div>` : ''}`;
  }

  // Địa chỉ mặc định thu gọn 1 dòng (ellipsis) + nút mở/thu — địa chỉ dài không kéo cao cả hàng.
  function renderAddress(o) {
    const addr = App.esc(o.address);
    if (!addr) return '<span class="muted">—</span>';
    const open = state.addrExpanded.has(String(o.id));
    return `
      <div class="gh-addr-row">
        <span class="gh-addr${open ? '' : ' gh-addr-clamped'}" title="${addr}">${addr}</span>
        <button type="button" class="gh-addr-toggle${open ? ' open' : ''}" data-addr="${o.id}" title="${open ? 'Thu gọn địa chỉ' : 'Xem đầy đủ địa chỉ'}">${App.icon('chevron')}</button>
      </div>`;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // "YYYY-MM-DD" của ngày hôm nay (local) — dùng cho nút "Hôm nay" cạnh #fDate.
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  // Bật màu nút "Hôm nay" khi #fDate đang đúng ngày hôm nay (kể cả khi chọn thủ công qua lịch).
  function syncTodayBtn() {
    $('btnToday').classList.toggle('active', $('fDate').value === todayStr());
  }

  // ISO string (server) -> "HH:MM" — dùng cho dòng nhỏ dưới nút "Xem" (cột hẹp, tránh vỡ dòng).
  // Xem ngày đầy đủ qua tooltip (fmtSentAtFull) khi hover.
  function fmtSentAtShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // ISO string (server) -> "HH:MM DD/MM" đầy đủ — dùng trong modal (đủ chỗ) + tooltip bản rút gọn.
  function fmtSentAtFull(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
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

  // NV phụ trách vận đơn — lấy từ dòng SP đầu tiên có approveUser (thường cả đơn cùng 1 NV duyệt,
  // giống logic firstApproveUser() phía server dùng để chọn tài khoản Zalo gửi báo ship).
  function orderStaff(o) {
    const items = Array.isArray(o.items) ? o.items : [];
    const hit = items.find((it) => it && it.approveUser && String(it.approveUser).trim());
    return hit ? String(hit.approveUser).trim() : '';
  }

  // Kênh sale mà vận đơn "thuộc về" (server enrich `kenhSaleList` theo NV duyệt đơn — xem
  // enrichShippingOrders/db.getOrderKenhSales). NV thuộc nhiều kênh -> hiện đủ, cách nhau dấu phẩy.
  function kenhSaleCell(o) {
    const list = o.kenhSaleList || [];
    return list.length ? App.esc(list.join(', ')) : '<span class="muted">—</span>';
  }

  // Đơn có thể xem trước tin báo ship: đã có link, hoặc đã giao shipper/đã giao/lên đơn vận.
  function canPreviewMsg(o) {
    return !!o.shipperLink || ['exported', 'completed', 'carrier_submitted'].includes(o.statusCode);
  }

  // Cột "ND ship": chưa gửi -> icon "Xem" (mở modal xem/sửa trước khi gửi) + icon "Gửi" (gửi
  // thẳng, không cần mở modal) — icon-only cho gọn, hover ra tooltip tên. Đã gửi -> chỉ còn icon
  // Xem (coi lại nội dung đã gửi) + giờ đã gửi, ẩn nút Gửi để khỏi bấm nhầm gửi trùng (đã có
  // chống trùng phía server, đây là tránh thao tác thừa).
  function renderNdShip(o) {
    if (!canPreviewMsg(o)) return '<span class="muted">—</span>';
    if (o.shipSentAt) {
      return `
        <div class="ship-ndship-actions">
          <button class="btn small icon-only" data-msg="${o.id}" aria-label="Xem nội dung đã gửi" title="Xem nội dung đã gửi">${App.icon('message')}</button>
        </div>
        <div class="ship-sub ship-sent-at" title="Đã gửi lúc ${App.esc(fmtSentAtFull(o.shipSentAt))}">${App.icon('clock')} ${App.esc(fmtSentAtShort(o.shipSentAt))}</div>`;
    }
    return `
      <div class="ship-ndship-actions">
        <button class="btn secondary small icon-only" data-msg="${o.id}" aria-label="Xem trước nội dung" title="Xem trước nội dung">${App.icon('message')}</button>
        <button class="btn accent small icon-only" data-send="${o.id}" aria-label="Gửi báo ship qua Zalo" title="Gửi báo ship qua Zalo">${App.icon('send')}</button>
      </div>`;
  }

  // Tick "Loại trừ" 1 vận đơn khỏi tự động báo ship (Pha 2) — giống Delay bên Hàng về VN, KHÔNG
  // ảnh hưởng gửi tay (nút Xem/Gửi vẫn gửi bình thường). Ẩn nếu đã gửi rồi (loại trừ hết ý nghĩa).
  function renderExclude(o) {
    if (o.shipSentAt) return '';
    return `<label class="excl-wrap" title="Tick để loại vận đơn này khỏi tự động báo ship (Pha 2) — gửi tay ở nút Xem/Gửi vẫn hoạt động bình thường">
      <input type="checkbox" class="excl-cb" data-id="${App.esc(o.id)}" ${o.autoExcluded ? 'checked' : ''} />
    </label>`;
  }

  // ---- Cột hiển thị (tiếp — xem COLS/loadHiddenCols ở đầu file) --------------------------------
  function saveHiddenCols() {
    try { localStorage.setItem(COLVIS_LS_KEY, JSON.stringify([...state.hiddenCols])); } catch { /* private mode -> bỏ qua, chỉ mất nhớ giữa các lần */ }
  }
  function applyColVis() {
    const table = document.querySelector('.gh-table');
    if (!table) return;
    const cols = table.querySelectorAll('colgroup col'); // đúng 15 <col>, cùng thứ tự th/td
    // Ghi nhớ bề rộng GỐC (px) của TỪNG <col> đúng 1 lần (đọc từ style="width:...px" khai trong
    // HTML) trước khi ghi đè — dùng làm TỈ LỆ để tính % mỗi lần ẩn/hiện sau, không mất mốc gốc.
    cols.forEach((col) => {
      if (col.dataset.origWidth === undefined) col.dataset.origWidth = parseFloat(col.style.width) || 0;
    });
    // Tổng bề rộng GỐC của các cột ĐANG HIỆN (bỏ cột đã ẩn) — vừa là mẫu số tính %, vừa dùng làm
    // min-width của <table> (không co hẹp hơn mức đó — còn nhiều cột thì vẫn cuộn ngang như cũ,
    // không ép bóp méo chữ). Cột 1/2/15/16 (checkbox/mở rộng/thao tác/loại trừ) không thuộc COLS
    // -> luôn hiện.
    let sumVisible = 0;
    cols.forEach((col, i) => {
      const cfg = COLS.find((c) => c.n === i + 1);
      if (!cfg || !state.hiddenCols.has(cfg.key)) sumVisible += Number(col.dataset.origWidth);
    });
    // Set % cho từng <col> theo ĐÚNG TỈ LỆ bề rộng gốc/tổng còn hiện — kết hợp .gh-table{width:100%}
    // (CSS) sẽ giãn TỈ LỆ mọi cột lấp đầy khung khi màn rộng hơn sumVisible (responsive), vẫn giữ
    // đúng tỉ lệ tương đối giữa các cột như thiết kế gốc (không cột nào "hút" hết chỗ trống).
    cols.forEach((col, i) => {
      const cfg = COLS.find((c) => c.n === i + 1);
      const hidden = !!(cfg && state.hiddenCols.has(cfg.key));
      if (cfg) table.classList.toggle(`hc-${cfg.n}`, hidden); // ẩn th/td tương ứng (CSS nth-child)
      col.style.width = hidden ? '0' : `${(Number(col.dataset.origWidth) / sumVisible) * 100}%`;
    });
    table.style.minWidth = `${sumVisible}px`; // sàn bề rộng — hẹp hơn thì .table-wrap tự cuộn ngang
  }
  function renderColVisMenu() {
    const box = $('colVisMenu');
    if (!box) return;
    box.innerHTML = COLS.map((c) => `
      <label class="colvis-item">
        <input type="checkbox" data-key="${c.key}" ${state.hiddenCols.has(c.key) ? '' : 'checked'}>
        ${App.esc(c.label)}
      </label>`).join('');
  }

  // ---- Render -----------------------------------------------------------
  function render() {
    const tb = $('rows');
    if (!state.orders.length) {
      tb.innerHTML = `<tr><td colspan="17" class="empty">${state.mock ? 'Chưa cấu hình Partner API — đang hiển thị dữ liệu mẫu.' : 'Không có đơn nào.'}</td></tr>`;
      return;
    }
    const rows = [];
    for (const o of state.orders) {
      const codPayer = o.shipPayerLabel ? `<div class="ship-sub">${App.esc(o.shipPayerLabel)}</div>` : '';
      rows.push(`
        <tr data-id="${o.id}" class="${o.autoExcluded ? 'row-excluded' : ''}">
          <td class="center"><input type="checkbox" class="rowchk" data-id="${o.id}"></td>
          <td class="center"><span class="ship-eye" data-eye="${o.id}" title="Xem chi tiết">${App.icon('eye')}</span></td>
          <td class="gh-datecell">${splitDateTime(o.createdAt)}</td>
          <td>
            <div>${App.esc(o.recipient)}</div>
            ${o.phone ? `<div class="ship-sub gh-nowrap" title="${App.esc(o.phone)}">${App.esc(o.phone)}</div>` : ''}
          </td>
          <td class="gh-nowrap">${App.esc(orderStaff(o)) || '<span class="muted">—</span>'}</td>
          <td>${kenhSaleCell(o)}</td>
          <td>
            <div class="gh-nowrap" title="${App.esc(o.trackingCode)}">${App.esc(o.trackingCode) || '<span class="muted">—</span>'}</div>
            ${o.shipperLink ? `<a class="ship-link" href="${App.esc(o.shipperLink)}" target="_blank" rel="noopener" title="${App.esc(o.shipperLink)}">${App.icon('link')} ${App.esc(o.shipperLink)}</a>` : ''}
          </td>
          <td>${renderAddress(o)}</td>
          <td>${App.esc(o.note) || ''}</td>
          <td class="center">${App.fmtVnd(o.codAmount) || '0₫'}</td>
          <td class="center">${App.fmtVnd(o.shipFee) || '0₫'}${codPayer}</td>
          <td><span class="ship-carrier">${App.icon('truck')} ${App.esc(o.shipping)}</span></td>
          <td>${statusBadge(o)}</td>
          <td class="gh-datecell">${splitDateTime(o.preparedAt)}</td>
          <td class="center">${renderNdShip(o)}</td>
          <td><div class="ship-actions">${actionButtons(o)}</div></td>
          <td class="center">${renderExclude(o)}</td>
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
    return `<tr class="ship-detail"><td colspan="17">
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

  // ---- Kênh sale (dropdown filter) ---------------------------------------
  // Cùng danh sách kênh sale đã cấu hình ở Cài đặt → Kênh Sale (dùng chung cho trang Hàng về VN).
  // Vận đơn "thuộc" 1 kênh nếu NV duyệt đơn (firstApproveUser phía server) có cấu hình kênh đó
  // (server enrich `kenhSaleList`) — 1 NV thuộc nhiều kênh thì khớp mọi kênh NV có mặt.
  async function loadChannelOptions() {
    try {
      const r = await App.api('/api/channel-accounts');
      const names = [...new Set((r.channelAccounts || []).map((c) => c.kenh_sale).filter(Boolean))];
      const sel = $('fChannel');
      if (sel) {
        const cur = sel.value;
        sel.innerHTML = '<option value="">Tất cả kênh</option>'
          + names.map((k) => `<option value="${App.esc(k)}">${App.esc(k)}</option>`).join('');
        sel.value = cur;
      }
    } catch (_) { /* lỗi -> giữ nguyên option tĩnh */ }
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
  // Bộ lọc chung (trừ page/kênh) dùng cho cả 2 đường: phân trang server (mặc định) và
  // kéo-toàn-bộ (khi đang lọc theo Kênh — xem nhánh channel bên dưới).
  function baseParams() {
    const p = new URLSearchParams();
    p.set('shipping_id', $('fCarrier').value || 0);
    p.set('status', $('fStatus').value || 'all');
    if ($('fStaff').value) p.set('user_approve', $('fStaff').value);
    if ($('fDate').value) p.set('filter_date', $('fDate').value); // YYYY-MM-DD (Partner nhận trực tiếp)
    if ($('fQ').value.trim()) p.set('key', $('fQ').value.trim());
    if (state.branch) p.set('branch', state.branch);
    return p;
  }

  async function load() {
    $('rows').innerHTML = '<tr><td colspan="17" class="empty">Đang tải...</td></tr>';
    const channel = $('fChannel') ? $('fChannel').value : '';
    try {
      if (channel) {
        // Kênh sale: Partner API không trả field này theo vận đơn -> không lọc được ở server.
        // Kéo TOÀN BỘ vận đơn khớp các bộ lọc còn lại rồi lọc + phân trang tại client.
        const r = await App.api('/api/shipping/all?' + baseParams().toString());
        const all = (r.orders || []).filter((o) => (o.kenhSaleList || []).includes(channel));
        state.pageSize = 20;
        state.total = all.length;
        const start = (state.page - 1) * state.pageSize;
        state.orders = all.slice(start, start + state.pageSize);
        state.mock = r.source === 'mock';
      } else {
        const params = baseParams();
        params.set('page', state.page);
        const r = await App.api('/api/shipping?' + params.toString());
        state.orders = r.orders || [];
        state.total = r.total || 0;
        state.pageSize = r.pageSize || 20;
        state.mock = r.source === 'mock';
      }
      $('mockBadge').style.display = state.mock ? '' : 'none';
      $('countInfo').textContent = `${state.total} đơn · trang ${state.page}/${Math.max(1, Math.ceil(state.total / state.pageSize))}`;
      render();
      renderPager();
    } catch (e) {
      $('rows').innerHTML = `<tr><td colspan="17" class="empty">Lỗi: ${App.esc(e.message)}</td></tr>`;
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
      shipFee: o.shipFee, shipPayer: o.shipPayer,
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
      const fbNote = $('msgFallbackNote');
      if (fbNote) fbNote.style.display = r.usedFallback ? '' : 'none';
      if (r.sendable) {
        t.value = r.message; t.disabled = false; $('msgCopy').style.display = '';
        if (r.alreadySent) {
          sentNote.style.display = ''; sentNote.innerHTML = `${App.icon('check')} Đã gửi lúc ${App.esc(fmtSentAtFull(r.sentAt))}`;
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
        $('msgSentNote').style.display = ''; $('msgSentNote').innerHTML = `${App.icon('check')} Đã gửi lúc ${App.esc(fmtSentAtFull(sentAtRaw))}`;
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

  // ---- Gửi thẳng 1 đơn từ bảng (nút "Gửi" cạnh "Xem", không cần mở modal) ------------------
  async function quickSend(id, btn) {
    const o = state.orders.find((x) => String(x.id) === String(id));
    if (!o) return;
    if (!confirm(`Gửi báo ship qua Zalo cho ${o.recipient}?`)) return;
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await App.api('/api/shipping/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: toApiOrder(o) }),
      });
      if (r.ok) {
        App.toast('✅ Đã gửi báo ship.');
        o.shipSentAt = r.sentAt || new Date().toISOString();
        render();
      } else {
        App.toast('Lỗi: ' + App.friendlyError(r.error || 'Gửi thất bại.'));
        btn.disabled = false; btn.innerHTML = orig;
      }
    } catch (e) {
      App.toast('Lỗi: ' + App.friendlyError(e.message));
      btn.disabled = false; btn.innerHTML = orig;
    }
  }

  // ---- Loại trừ khỏi tự động báo ship (Pha 2) — tick checkbox ở cột "Loại trừ" ------------
  async function toggleExclude(id, checked, cb) {
    const o = state.orders.find((x) => String(x.id) === String(id));
    try {
      await App.api('/api/shipping-auto/exclude', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, excluded: checked }),
      });
      if (o) o.autoExcluded = checked;
      App.toast(checked ? 'Đã loại khỏi tự động báo ship (Pha 2).' : 'Đã bỏ loại trừ — tự động báo ship lại bình thường.');
      render();
    } catch (e) {
      App.toast('Lỗi: ' + App.friendlyError(e.message));
      if (cb) cb.checked = !checked; // khôi phục vì lưu thất bại
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
    ['fCarrier', 'fStatus', 'fDate', 'fStaff', 'fChannel'].forEach((id) => $(id).addEventListener('change', () => { state.page = 1; load(); }));
    $('fDate').addEventListener('change', syncTodayBtn);
    $('btnToday').onclick = () => {
      $('fDate').value = $('fDate').value === todayStr() ? '' : todayStr();
      syncTodayBtn();
      state.page = 1; load();
    };
    syncTodayBtn();
    $('branchTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.branch = b.dataset.branch; state.page = 1;
      $('branchTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      load();
    });
    $('btnBulkShip').onclick = () => bulk('ship');
    $('btnBulkComplete').onclick = () => bulk('complete');
    $('btnPrint').onclick = printSelected;

    // Popover "Cột hiển thị" — tái dùng đúng kiểu mở/đóng của popover "Bộ lọc" (dashboard.js).
    applyColVis(); // phản ánh lựa chọn đã lưu (localStorage) ngay từ lần render đầu tiên
    const colVisBtn = $('colVisBtn');
    const colVisPop = $('colVisPop');
    colVisBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      colVisPop.hidden = !colVisPop.hidden;
      if (!colVisPop.hidden) renderColVisMenu();
    });
    colVisPop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { colVisPop.hidden = true; });
    $('colVisMenu').addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
      if (cb.checked) state.hiddenCols.delete(cb.dataset.key); else state.hiddenCols.add(cb.dataset.key);
      applyColVis();
      saveHiddenCols();
    });
    $('colVisReset').addEventListener('click', () => {
      state.hiddenCols.clear();
      applyColVis();
      saveHiddenCols();
      renderColVisMenu();
    });
    $('rows').addEventListener('click', (e) => {
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        const id = eye.dataset.eye;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        render();
        return;
      }
      const addrBtn = e.target.closest('[data-addr]');
      if (addrBtn) {
        const id = addrBtn.dataset.addr;
        if (state.addrExpanded.has(id)) state.addrExpanded.delete(id); else state.addrExpanded.add(id);
        render();
        return;
      }
      const msg = e.target.closest('[data-msg]');
      if (msg) { showMessage(msg.dataset.msg); return; }
      const sendBtn = e.target.closest('[data-send]');
      if (sendBtn) { quickSend(sendBtn.dataset.send, sendBtn); return; }
      const btn = e.target.closest('[data-act]');
      if (btn) doAction(btn.dataset.id, btn.dataset.act);
    });
    $('rows').addEventListener('change', (e) => {
      const cb = e.target.closest('.excl-cb');
      if (cb) toggleExclude(cb.dataset.id, cb.checked, cb);
    });
  }

  bind();
  loadMeta();
  loadChannelOptions();
  load();
})();
