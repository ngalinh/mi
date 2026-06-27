(() => {
  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

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

  function msgPreview(t) {
    const s = String(t || '').trim();
    if (!s) return '<span class="muted">—</span>';
    return App.esc(s.length > 70 ? s.slice(0, 70) + '…' : s);
  }

  // Lỗi Playwright thường rất dài (call log). Chỉ hiện dòng đầu + cắt ngắn,
  // text đầy đủ xem ở tooltip (title) khi rê chuột.
  function errPreview(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    const firstLine = s.split('\n')[0].trim();
    return App.esc(firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine);
  }

  // Người gửi: 'bot' = tự động; chuỗi khác = nhân viên (gateway forward); rỗng = không rõ.
  function senderCell(v) {
    const s = String(v || '').trim();
    if (!s) return '<span class="muted">—</span>';
    if (s === 'bot') return '<span class="pill">🤖 Bot</span>';
    return App.esc(s);
  }

  async function load() {
    rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    const st = $('fStatus').value, q = $('fQ').value;
    if (st) params.set('status', st);
    if (q) params.set('q', q);
    try {
      const res = await App.api('/api/reports?' + params.toString());
      $('sTotal').textContent = res.stats.total;
      $('sSuccess').textContent = res.stats.success;
      $('sFailed').textContent = res.stats.failed;
      $('sPending').textContent = res.stats.pending || 0;
      const items = res.items || [];
      // Còn dòng "đang báo" -> tự tải lại để badge tự lật sang Thành công/Thất bại khi job xong.
      scheduleAutoRefresh(items.some((r) => r.status === 'pending'));
      if (!items.length) {
        rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Chưa có lượt báo nào</td></tr>';
        return;
      }
      rowsEl.innerHTML = items.map((r) => `<tr>
        <td>${App.fmtDateTime(r.created_at)}</td>
        <td>${App.esc(r.order_id) || '—'}</td>
        <td>${thumbsCell(r.images)}</td>
        <td class="cust">${App.esc(r.customer_name)}</td>
        <td>${App.esc(r.phone)}</td>
        <td>${App.esc(r.staff)}</td>
        <td>${senderCell(r.sent_by)}</td>
        <td class="msg-cell" title="${App.esc(r.message)}">${msgPreview(r.message)}</td>
        <td>${resultPill(r.status)}</td>
        <td class="err-cell" style="color:var(--red)" title="${App.esc(r.error)}">${errPreview(r.error)}</td>
      </tr>`).join('');
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="10" class="empty">Lỗi: ${App.esc(e.message)}</td></tr>`;
    }
  }

  // Đồng bộ thẻ thống kê đang active với giá trị filter ('' | 'success' | 'failed')
  function syncStatCards(val) {
    document.querySelectorAll('#statCards .status-tab').forEach((c) =>
      c.classList.toggle('active', c.dataset.filter === val));
  }

  $('reloadBtn').addEventListener('click', load);
  $('fStatus').addEventListener('change', () => { syncStatCards($('fStatus').value); load(); });
  // Bấm thẻ thống kê = lọc theo loại (Tổng = tất cả, Thành công, Thất bại)
  $('statCards').addEventListener('click', (e) => {
    const card = e.target.closest('.status-tab');
    if (!card) return;
    $('fStatus').value = card.dataset.filter;
    syncStatCards(card.dataset.filter);
    load();
  });
  let t;
  $('fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 400); });
  load();
})();
