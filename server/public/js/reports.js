(() => {
  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  function resultPill(s) {
    const ok = s === 'success';
    const cls = ok ? 'success' : 'failed';
    const txt = ok ? 'Thành công' : 'Thất bại';
    return `<span class="pill ${cls}">${App.icon(ok ? 'check' : 'alert')} ${txt}</span>`;
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

  async function load() {
    rowsEl.innerHTML = '<tr><td colspan="8" class="empty">Đang tải...</td></tr>';
    const params = new URLSearchParams();
    const st = $('fStatus').value, q = $('fQ').value;
    if (st) params.set('status', st);
    if (q) params.set('q', q);
    try {
      const res = await App.api('/api/reports?' + params.toString());
      $('sTotal').textContent = res.stats.total;
      $('sSuccess').textContent = res.stats.success;
      $('sFailed').textContent = res.stats.failed;
      const items = res.items || [];
      if (!items.length) {
        rowsEl.innerHTML = '<tr><td colspan="8" class="empty">Chưa có lượt báo nào</td></tr>';
        return;
      }
      rowsEl.innerHTML = items.map((r) => `<tr>
        <td>${App.fmtDateTime(r.created_at)}</td>
        <td>${App.esc(r.order_id) || '—'}</td>
        <td class="cust">${App.esc(r.customer_name)}</td>
        <td>${App.esc(r.phone)}</td>
        <td>${App.esc(r.staff)}</td>
        <td class="msg-cell" title="${App.esc(r.message)}">${msgPreview(r.message)}</td>
        <td>${resultPill(r.status)}</td>
        <td class="err-cell" style="color:var(--red)" title="${App.esc(r.error)}">${errPreview(r.error)}</td>
      </tr>`).join('');
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="8" class="empty">Lỗi: ${App.esc(e.message)}</td></tr>`;
    }
  }

  $('reloadBtn').addEventListener('click', load);
  $('fStatus').addEventListener('change', load);
  let t;
  $('fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 400); });
  load();
})();
