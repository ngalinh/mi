// Helper dùng chung cho các trang
const App = {
  // Bộ icon SVG (kiểu line, theo currentColor) — dùng cho phần tử render bằng JS
  ICONS: {
    chevron: '<path d="m9 18 6-6-6-6"/>',
    send: '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.1 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    truck: '<path d="M14 18V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  },
  icon(name, cls = '') {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${this.ICONS[name] || ''}</svg>`;
  },

  // Timeout (ms) cho mỗi request — tránh kẹt "Đang tải..." vô thời hạn khi server/Basso
  // chậm. Đặt dài hơn timeout phía server (12s) để lỗi server nổi lên trước.
  API_TIMEOUT_MS: 20000,

  // Tiền tố base path: trên ai.basso.vn bot chạy dưới /b/<id>/ nên API phải gọi
  // /b/<id>/api/... (giống Xeko). Suy từ đường dẫn trang hiện tại (bỏ tên file cuối).
  // Chạy local ở '/' -> BASE = '' -> giữ nguyên /api/...
  BASE: window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, ''),

  async api(path, opts = {}) {
    const url = (this.BASE && typeof path === 'string' && path.startsWith('/')) ? this.BASE + path : path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.API_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Quá thời gian chờ — kết nối chậm, thử lại sau');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({ ok: false, error: 'Response không hợp lệ' }));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },

  toast(msg, ms = 3000) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => el.classList.remove('show'), ms);
  },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  },

  fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // Định dạng số tiền VND: 480000 -> "480,000₫"
  fmtVnd(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '';
    return Number(n).toLocaleString('vi-VN') + '₫';
  },

  // Lấy thông tin người đang đăng nhập từ gateway (header x-user-email) và hiển thị ở avatar.
  async initUserAvatar() {
    const el = document.getElementById('userAvatar');
    if (!el) return;
    try {
      const r = await this.api('/api/me');
      const email = r.email || '';
      const name = (r.staff && r.staff.name) || email;
      if (!email) return;
      // Lấy 1-2 chữ đầu tên/email làm initials
      const parts = name.trim().split(/\s+/);
      const initials = parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
      el.title = name !== email ? `${name} (${email})` : email;
      el.innerHTML = `<span style="font-size:14px;font-weight:700;line-height:1;">${App.esc(initials)}</span>`;
    } catch (_) { /* giữ icon mặc định nếu không lấy được */ }
  },
};
