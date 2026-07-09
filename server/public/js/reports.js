(() => {
  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');
  const pagerEl = $('pager');

  // Phân trang phía client: API trả nguyên tập (tối đa 200 lượt), chia 20 dòng/trang cho gọn.
  const PAGE_SIZE = 20;
  let allItems = [];                                          // toàn bộ lượt báo lần tải gần nhất
  let currentPage = 1;

  // Khi danh sách còn dòng "đang báo", tự tải lại sau vài giây để badge tự cập nhật khi job
  // gửi xong. Hết pending thì dừng (không poll vô ích). Mỗi lần load() gọi lại để gia hạn/huỷ.
  let refreshTimer = null;
  function scheduleAutoRefresh(hasPending) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (hasPending) refreshTimer = setTimeout(load, 3000);
  }

  function resultPill(s) {
    if (s === 'pending') return `<span class="pill pending">${App.icon('hourglass')} Pending</span>`;
    const ok = s === 'success';
    const cls = ok ? 'success' : 'failed';
    const txt = ok ? 'Done' : 'Failed';
    return `<span class="pill ${cls}">${App.icon(ok ? 'check' : 'alert')} ${txt}</span>`;
  }

  // Thumbnail ảnh SP đã báo: hiện tối đa 4, dư thì "+N".
  function thumbsCell(images) {
    const list = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!list.length) return '<span class="muted">—</span>';
    const shown = list.slice(0, 4);
    const extra = list.length - shown.length;
    const imgs = shown.map((src) =>
      `<img class="rp-thumb" src="${App.esc(src)}" alt="" loading="lazy" />`).join('');
    const more = extra > 0 ? `<span class="rp-more">+${extra}</span>` : '';
    return `<div class="rp-thumbs">${imgs}${more}</div>`;
  }

  // Preview nội dung gọn 1 dòng: gộp xuống dòng/khoảng trắng thừa thành 1 space rồi cắt ngắn.
  // Tin báo hàng thường 3 dòng nên nếu để nguyên sẽ đội chiều cao mỗi hàng; full text ở tooltip.
  function msgPreview(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (!s) return '<span class="muted">—</span>';
    return App.esc(s.length > 60 ? s.slice(0, 60) + '…' : s);
  }

  // Lỗi Playwright thường rất dài (call log) và là mã kỹ thuật (KHONG_*). Hiện câu tiếng Việt dễ
  // hiểu (App.friendlyError) + cắt ngắn; text GỐC đầy đủ vẫn xem ở tooltip (data-tip) khi rê chuột.
  function errPreview(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    const friendly = App.friendlyError(s);
    return App.esc(friendly.length > 60 ? friendly.slice(0, 60) + '…' : friendly);
  }

  // Map email nhân viên (chữ thường) -> tên, để cột "Người gửi" hiện tên gọn thay vì email.
  // Tải 1 lần từ /api/staff; nếu lỗi thì map rỗng và fallback hiện nguyên email.
  let staffByEmail = new Map();
  async function loadStaffMap() {
    try {
      const res = await App.api('/api/staff');
      staffByEmail = new Map(
        (res.staff || []).map((s) => [String(s.email || '').trim().toLowerCase(), s.name])
      );
    } catch (_) { /* giữ map hiện tại */ }
  }

  // Người gửi: 'bot' = tự động; chuỗi khác = nhân viên (gateway forward); rỗng = không rõ.
  // Nếu là email khớp danh sách NV -> hiện tên cho gọn (email đầy đủ ở tooltip).
  // Nhãn kênh gửi trước tên tài khoản: chip mềm "Zalo" / "FB".
  function chanIcon(channel) {
    const fb = channel === 'facebook';
    return `<span class="chan-tag ${fb ? 'fb' : 'zalo'}" title="${fb ? 'Facebook' : 'Zalo'}">${fb ? 'FB' : 'Zalo'}</span>`;
  }
  function accountCell(r) {
    if (!r.zalo_account) return '<span class="muted">—</span>';
    return `<span class="acct-with-ic">${chanIcon(r.channel)}${App.esc(r.zalo_account)}</span>`;
  }

  function senderCell(v) {
    const s = String(v || '').trim();
    if (!s) return '<span class="muted">—</span>';
    if (s === 'bot') return `<span class="pill pill-bot">${App.icon('bot')} Bot</span>`;
    const name = staffByEmail.get(s.toLowerCase());
    if (name) return `<span title="${App.esc(s)}">${App.esc(name)}</span>`;
    return App.esc(s);
  }

  // Nhãn cho dropdown "Người gửi": "Bot" (option native không render được SVG nên để chữ
  // thuần — icon robot SVG chỉ dùng ở pill trong bảng), hoặc "Tên (email)" nếu email khớp NV.
  function senderLabel(v) {
    const s = String(v || '').trim();
    if (s === 'bot') return 'Bot';
    const name = staffByEmail.get(s.toLowerCase());
    return name ? `${name} (${s})` : s;
  }

  // Đổ danh sách chọn cho dropdown lọc, giữ nguyên giá trị đang chọn (kể cả khi facets đổi).
  function fillSelect(el, values, labelFn) {
    const cur = el.value;
    const opts = ['<option value="">Tất cả</option>'].concat(
      (values || []).map((v) => `<option value="${App.esc(v)}">${App.esc(labelFn ? labelFn(v) : v)}</option>`)
    );
    el.innerHTML = opts.join('');
    el.value = cur;                                           // khôi phục lựa chọn
    if (el.value !== cur) el.value = '';                      // giá trị cũ đã biến mất -> về "Tất cả"
  }

  // Tooltip tuỳ biến cho ô Nội dung / Lỗi: đẹp hơn tooltip mặc định của trình duyệt,
  // giữ nguyên xuống dòng và bám theo viewport (không tràn mép, tự lật lên nếu chạm đáy).
  const tip = document.createElement('div');
  tip.className = 'rp-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipTarget = null;

  function positionTip(target) {
    const r = target.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const m = 8;
    let left = r.left;
    if (left + box.width > window.innerWidth - m) left = window.innerWidth - box.width - m;
    if (left < m) left = m;
    let top = r.bottom + m;                                   // mặc định: ngay dưới ô
    if (top + box.height > window.innerHeight - m) top = r.top - box.height - m; // chạm đáy -> lật lên
    if (top < m) top = m;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function showTip(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;                                   // textContent: giữ \n, chống XSS
    tip.classList.toggle('is-err', target.classList.contains('err-cell'));
    tip.classList.add('show');
    positionTip(target);
  }
  function hideTip() { tip.classList.remove('show'); tipTarget = null; }

  rowsEl.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t || t === tipTarget) return;
    tipTarget = t;
    showTip(t);
  });
  rowsEl.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t && t === tipTarget) hideTip();
  });

  // Danh sách nút trang dạng cửa sổ: 1 … (cur-1) cur (cur+1) … N.
  function pageItems(total, cur) {
    const out = [];
    for (let p = 1; p <= total; p++) {
      if (p === 1 || p === total || (p >= cur - 1 && p <= cur + 1)) out.push(p);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  }

  function renderPager(total, totalPages) {
    if (!pagerEl) return;
    if (!total) { pagerEl.innerHTML = ''; pagerEl.classList.add('hidden'); return; }
    pagerEl.classList.remove('hidden');
    const cur = currentPage;
    const info = `<span class="pg-info">Tổng <b>${total}</b> lượt báo — Trang <b>${cur}</b> / <b>${totalPages}</b></span>`;
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
      jump = `<span class="pg-jump">Đến trang <input class="pg-jump-input" type="number" min="1" max="${totalPages}" value="${cur}" aria-label="Đến trang" /> <button class="pg-btn pg-go" id="pgGo">Đi</button></span>`;
    }
    pagerEl.innerHTML = info + pages + jump;
  }

  // Vẽ đúng 1 trang (20 dòng) từ allItems + thanh phân trang. Gọi lại khi đổi trang mà không tải lại API.
  function renderPage() {
    hideTip();                                                // tránh tooltip "kẹt" khi bảng render lại
    const total = allItems.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItemsList = allItems.slice(start, start + PAGE_SIZE);
    rowsEl.innerHTML = pageItemsList.map((r) => `<tr>
      <td class="time-cell">${App.fmtDateTime(r.created_at)}</td>
      <td class="order-cell" ${r.order_id ? `data-tip="${App.esc(r.order_id)}"` : ''}>${App.esc(r.order_id) || '—'}</td>
      <td>${thumbsCell(r.images)}</td>
      <td class="cust" title="${App.esc(r.customer_name)}">${App.esc(r.customer_name)}</td>
      <td>${App.esc(r.phone)}</td>
      <td>${resultPill(r.status)}</td>
      <td title="${App.esc(r.staff)}">${App.esc(r.staff)}</td>
      <td>${senderCell(r.sent_by)}</td>
      <td>${accountCell(r)}</td>
      <td class="msg-cell" data-tip="${App.esc(r.message)}">${msgPreview(r.message)}</td>
      <td class="err-cell" style="color:var(--red)" data-tip="${App.esc(r.error)}">${errPreview(r.error)}</td>
      <td class="center">${actionCell(r)}</td>
    </tr>`).join('');
    renderPager(total, totalPages);
  }

  // Nhảy tới 1 trang (kẹp về [1, số trang]) rồi vẽ lại, không gọi API.
  function goToPage(p) {
    const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, parseInt(p, 10) || 1), totalPages);
    renderPage();
  }

  // Ô "Thao tác": chỉ dòng THẤT BẠI mới có nút Thử lại (gửi lại đúng đơn đó).
  function actionCell(r) {
    if (r.status !== 'failed') return '<span class="muted">—</span>';
    return `<button class="btn small secondary retry-btn" data-id="${App.esc(r.id)}" title="Gửi lại lượt báo này">
      ${App.icon('refresh')} Thử lại</button>`;
  }

  async function load() {
    hideTip();                                                // tránh tooltip "kẹt" khi bảng render lại
    rowsEl.innerHTML = '<tr><td colspan="12" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    const st = $('fStatus').value, q = $('fQ').value;
    if (st) params.set('status', st);
    if (q) params.set('q', q);
    const staff = $('fStaff').value, sender = $('fSender').value, account = $('fAccount').value;
    if (staff) params.set('staff', staff);
    if (sender) params.set('sender', sender);
    if (account) params.set('account', account);
    // Ngày chọn ở input là ngày local; quy đổi ra mốc ISO (UTC) để khớp created_at.
    // from = 00:00 ngày bắt đầu; to = 00:00 ngày sau ngày kết thúc (chặn trên, loại trừ).
    const from = $('fFrom').value, to = $('fTo').value;
    if (from) params.set('from', new Date(from + 'T00:00:00').toISOString());
    if (to) { const d = new Date(to + 'T00:00:00'); d.setDate(d.getDate() + 1); params.set('to', d.toISOString()); }
    try {
      const res = await App.api('/api/reports?' + params.toString());
      const f = res.facets || {};
      fillSelect($('fStaff'), f.staff);
      fillSelect($('fSender'), f.senders, senderLabel);
      fillSelect($('fAccount'), f.accounts);
      $('sTotal').textContent = res.stats.total;
      $('sSuccess').textContent = res.stats.success;
      $('sFailed').textContent = res.stats.failed;
      $('sPending').textContent = res.stats.pending || 0;
      const items = res.items || [];
      // Còn dòng "đang báo" -> tự tải lại để badge tự lật sang Thành công/Thất bại khi job xong.
      scheduleAutoRefresh(items.some((r) => r.status === 'pending'));
      allItems = items;
      if (!items.length) {
        currentPage = 1;
        rowsEl.innerHTML = '<tr><td colspan="12" class="empty">Chưa có lượt báo nào</td></tr>';
        renderPager(0, 1);
        return;
      }
      // Kẹp trang hiện tại theo tập mới (bộ lọc đổi có thể làm ít trang hơn) rồi vẽ trang.
      const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      if (currentPage > totalPages) currentPage = totalPages;
      renderPage();
    } catch (e) {
      allItems = [];
      rowsEl.innerHTML = `<tr><td colspan="12" class="empty">Lỗi: ${App.esc(e.message)}</td></tr>`;
      renderPager(0, 1);
    }
  }

  // Đổi bộ lọc/tìm kiếm/tải lại -> quay về trang 1 rồi gọi API.
  function reload() { currentPage = 1; load(); }

  // Bấm "Thử lại" trên 1 dòng thất bại -> gọi API gửi lại đúng đơn đó, rồi tải lại bảng.
  rowsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.retry-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id || btn.disabled) return;
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Đang gửi...';
    // Retry chạy ĐỒNG BỘ tới lúc gửi xong, nhưng server đã ghi sẵn 1 dòng 'pending' ngay khi bắt
    // đầu. Poll bảng trong lúc chờ để dòng 'pending' hiện lên (rồi tự lật Done/Failed nhờ
    // scheduleAutoRefresh) thay vì người dùng chỉ thấy spinner ở nút. Dừng poll khi API trả về.
    const poll = setInterval(load, 3000);
    try {
      const r = await App.api(`/api/reports/${encodeURIComponent(id)}/retry`, { method: 'POST' });
      if (r.sent > 0) App.toast('✅ Đã gửi lại thành công');
      else if (r.aborted) App.toast('⛔ Zalo chưa đăng nhập — hãy đăng nhập Zalo rồi thử lại.', 8000);
      else {
        const err = (r.results && r.results[0] && r.results[0].error) || 'không rõ lý do';
        App.toast(`❌ Gửi lại vẫn lỗi: ${App.friendlyError(err)}`, 7000);
      }
    } catch (err) {
      clearInterval(poll);
      App.toast(`❌ ${err.message}`, 6000);
      btn.disabled = false;
      btn.innerHTML = label;
      return;
    }
    clearInterval(poll);
    load(); // làm mới bảng (dòng mới 'pending' -> lật success/failed)
  });

  // Đồng bộ thẻ thống kê đang active với giá trị filter ('' | 'success' | 'failed')
  function syncStatCards(val) {
    document.querySelectorAll('#statCards .status-tab').forEach((c) =>
      c.classList.toggle('active', c.dataset.filter === val));
  }

  $('reloadBtn').addEventListener('click', reload);
  $('fStatus').addEventListener('change', () => { syncStatCards($('fStatus').value); reload(); });
  $('fFrom').addEventListener('change', reload);
  $('fTo').addEventListener('change', reload);
  $('fStaff').addEventListener('change', reload);
  $('fSender').addEventListener('change', reload);
  $('fAccount').addEventListener('change', reload);
  // Bấm thẻ thống kê = lọc theo loại (Tổng = tất cả, Thành công, Thất bại)
  $('statCards').addEventListener('click', (e) => {
    const card = e.target.closest('.status-tab');
    if (!card) return;
    $('fStatus').value = card.dataset.filter;
    syncStatCards(card.dataset.filter);
    reload();
  });
  let t;
  $('fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(reload, 400); });

  // Phân trang: bấm số trang / Trước / Sau, hoặc nhập số rồi "Đi" (Enter cũng được). Chỉ vẽ lại
  // trang từ tập đã tải, không gọi API.
  pagerEl.addEventListener('click', (e) => {
    const b = e.target.closest('.pg-btn');
    if (!b) return;
    if (b.classList.contains('pg-go')) {
      const inp = pagerEl.querySelector('.pg-jump-input');
      goToPage(inp ? inp.value : 1);
    } else if (b.dataset.page) {
      goToPage(b.dataset.page);
    }
  });
  pagerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('pg-jump-input')) {
      e.preventDefault();
      goToPage(e.target.value);
    }
  });
  // Tải map nhân viên trước, xong mới render để cột "Người gửi" hiện tên ngay lượt đầu.
  loadStaffMap().finally(load);
})();
