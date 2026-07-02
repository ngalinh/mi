(() => {
  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  const PAGE_SIZE = 20;                                        // số dòng mỗi trang
  let page = 1;                                                // trang hiện tại (1-based)

  // Khi danh sách còn dòng "đang báo", tự tải lại sau vài giây để badge tự cập nhật khi job
  // gửi xong. Hết pending thì dừng (không poll vô ích). Mỗi lần load() gọi lại để gia hạn/huỷ.
  let refreshTimer = null;
  function scheduleAutoRefresh(hasPending) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (hasPending) refreshTimer = setTimeout(load, 3000);
  }

  function resultPill(s) {
    if (s === 'pending') return '<span class="pill pending">⏳ Đang báo</span>';
    const ok = s === 'success';
    const cls = ok ? 'success' : 'failed';
    const txt = ok ? 'Thành công' : 'Thất bại';
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

  // Lỗi Playwright thường rất dài (call log). Chỉ hiện dòng đầu + cắt ngắn,
  // text đầy đủ xem ở tooltip (title) khi rê chuột.
  function errPreview(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    const firstLine = s.split('\n')[0].trim();
    return App.esc(firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine);
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
  function senderCell(v) {
    const s = String(v || '').trim();
    if (!s) return '<span class="muted">—</span>';
    if (s === 'bot') return '<span class="pill">🤖 Bot</span>';
    const name = staffByEmail.get(s.toLowerCase());
    if (name) return `<span title="${App.esc(s)}">${App.esc(name)}</span>`;
    return App.esc(s);
  }

  // Nhãn cho dropdown "Người gửi": 🤖 Bot, hoặc "Tên (email)" nếu email khớp NV, hoặc nguyên chuỗi.
  function senderLabel(v) {
    const s = String(v || '').trim();
    if (s === 'bot') return '🤖 Bot';
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

  // Ô "Thao tác": chỉ dòng THẤT BẠI mới có nút Thử lại (gửi lại đúng đơn đó).
  function actionCell(r) {
    if (r.status !== 'failed') return '<span class="muted">—</span>';
    return `<button class="btn small secondary retry-btn" data-id="${App.esc(r.id)}" title="Gửi lại lượt báo này">
      ${App.icon('refresh')} Thử lại</button>`;
  }

  // Dãy số trang có "…" khi nhiều trang: luôn hiện trang đầu/cuối, và cửa sổ quanh trang hiện tại.
  function pageList(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const set = new Set([1, total, cur, cur - 1, cur + 1]);
    const arr = [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      if (i && arr[i] - arr[i - 1] > 1) out.push('…');
      out.push(arr[i]);
    }
    return out;
  }

  // Vẽ thanh phân trang dưới bảng. Ẩn khi chỉ có 1 trang (hoặc rỗng).
  function renderPager(total) {
    const pager = $('pager');
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (total <= PAGE_SIZE) { pager.hidden = true; return; }
    pager.hidden = false;
    const first = (page - 1) * PAGE_SIZE + 1;
    const last = Math.min(page * PAGE_SIZE, total);
    $('pagerInfo').textContent = `Hiển thị ${first}–${last} / ${total} lượt báo`;
    const btn = (label, target, opts = {}) => {
      const dis = opts.disabled ? ' disabled' : '';
      const active = opts.active ? ' active' : '';
      if (opts.gap) return `<span class="pager-gap">…</span>`;
      return `<button class="pager-btn${active}" data-page="${target}"${dis}>${label}</button>`;
    };
    const parts = [btn('‹', page - 1, { disabled: page <= 1 })];
    for (const p of pageList(page, totalPages)) {
      parts.push(p === '…' ? btn('', 0, { gap: true }) : btn(String(p), p, { active: p === page }));
    }
    parts.push(btn('›', page + 1, { disabled: page >= totalPages }));
    $('pagerNav').innerHTML = parts.join('');
  }

  async function load() {
    hideTip();                                                // tránh tooltip "kẹt" khi bảng render lại
    rowsEl.innerHTML = '<tr><td colspan="12" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    params.set('page', page);
    params.set('pageSize', PAGE_SIZE);
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
      const total = res.total != null ? res.total : items.length;
      // Xoá bớt bộ lọc khiến trang hiện tại vượt quá số trang -> lùi về trang cuối và tải lại.
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page > totalPages) { page = totalPages; return load(); }
      // Còn dòng "đang báo" -> tự tải lại để badge tự lật sang Thành công/Thất bại khi job xong.
      scheduleAutoRefresh(items.some((r) => r.status === 'pending'));
      if (!items.length) {
        rowsEl.innerHTML = '<tr><td colspan="12" class="empty">Chưa có lượt báo nào</td></tr>';
        $('pager').hidden = true;
        return;
      }
      rowsEl.innerHTML = items.map((r) => `<tr>
        <td class="time-cell">${App.fmtDateTime(r.created_at)}</td>
        <td class="order-cell" ${r.order_id ? `data-tip="${App.esc(r.order_id)}"` : ''}>${App.esc(r.order_id) || '—'}</td>
        <td>${thumbsCell(r.images)}</td>
        <td class="cust">${App.esc(r.customer_name)}</td>
        <td>${App.esc(r.phone)}</td>
        <td>${App.esc(r.staff)}</td>
        <td>${senderCell(r.sent_by)}</td>
        <td>${r.zalo_account ? App.esc(r.zalo_account) : '<span class="muted">—</span>'}</td>
        <td class="msg-cell" data-tip="${App.esc(r.message)}">${msgPreview(r.message)}</td>
        <td>${resultPill(r.status)}</td>
        <td class="err-cell" style="color:var(--red)" data-tip="${App.esc(r.error)}">${errPreview(r.error)}</td>
        <td class="center">${actionCell(r)}</td>
      </tr>`).join('');
      renderPager(total);
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="12" class="empty">Lỗi: ${App.esc(e.message)}</td></tr>`;
      $('pager').hidden = true;
    }
  }

  // Bấm "Thử lại" trên 1 dòng thất bại -> gọi API gửi lại đúng đơn đó, rồi tải lại bảng.
  rowsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.retry-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id || btn.disabled) return;
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Đang gửi...';
    try {
      const r = await App.api(`/api/reports/${encodeURIComponent(id)}/retry`, { method: 'POST' });
      if (r.sent > 0) App.toast('✅ Đã gửi lại thành công');
      else {
        const err = (r.results && r.results[0] && r.results[0].error) || 'không rõ lý do';
        App.toast(`❌ Gửi lại vẫn lỗi: ${err}`, 6000);
      }
    } catch (err) {
      App.toast(`❌ ${err.message}`, 6000);
      btn.disabled = false;
      btn.innerHTML = label;
      return;
    }
    load(); // làm mới bảng (dòng mới 'pending' -> lật success/failed)
  });

  // Đồng bộ thẻ thống kê đang active với giá trị filter ('' | 'success' | 'failed')
  function syncStatCards(val) {
    document.querySelectorAll('#statCards .status-tab').forEach((c) =>
      c.classList.toggle('active', c.dataset.filter === val));
  }

  // Đổi bộ lọc -> luôn về trang 1 rồi tải (tránh "kẹt" ở trang không còn dữ liệu).
  function reload() { page = 1; load(); }

  // Bấm số trang / mũi tên -> nhảy trang (không đổi bộ lọc).
  $('pagerNav').addEventListener('click', (e) => {
    const b = e.target.closest('.pager-btn');
    if (!b || b.disabled) return;
    const target = parseInt(b.dataset.page, 10);
    if (!target || target === page) return;
    page = target;
    load();
    document.querySelector('.table-wrap')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

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
  // Tải map nhân viên trước, xong mới render để cột "Người gửi" hiện tên ngay lượt đầu.
  loadStaffMap().finally(load);
})();
