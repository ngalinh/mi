(() => {
  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');

  function resultPill(s) {
    const cls = s === 'success' ? 'success' : 'failed';
    const txt = s === 'success' ? '✅ Thành công' : '❌ Thất bại';
    return `<span class="pill ${cls}">${txt}</span>`;
  }

  function msgPreview(t) {
    const s = String(t || '').trim();
    if (!s) return '<span class="muted">—</span>';
    return App.esc(s.length > 70 ? s.slice(0, 70) + '…' : s);
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
        <td class="msg-cell" style="color:var(--red)">${App.esc(r.error) || ''}</td>
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
