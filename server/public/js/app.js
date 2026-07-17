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
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    stop: '<rect width="16" height="16" x="4" y="4" rx="2"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  },
  icon(name, cls = '') {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${this.ICONS[name] || ''}</svg>`;
  },

  // Timeout (ms) cho mỗi request — tránh kẹt "Đang tải..." vô thời hạn khi server/Basso
  // chậm. Đặt DÀI HƠN timeout phía server (Basso 20s/call + có thể vài call) để lần tải đầu
  // "cold" (cache RAM chưa ấm) kịp xong thay vì client tự bỏ cuộc giữa chừng. Khi cache đã ấm
  // thì server trả gần như tức thì nên người dùng không phải đợi tới mức này.
  API_TIMEOUT_MS: 40000,

  // Tiền tố base path: trên ai.basso.vn bot chạy dưới /b/<id>/ nên API phải gọi
  // /b/<id>/api/... (giống Xeko). Suy từ đường dẫn trang hiện tại (bỏ tên file cuối).
  // Chạy local ở '/' -> BASE = '' -> giữ nguyên /api/...
  BASE: window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, ''),

  async api(path, opts = {}) {
    // timeoutMs: cho phép caller nới thời gian chờ (vd báo hàng loạt chạy vài phút) — mặc định
    // API_TIMEOUT_MS. Tách khỏi opts để không lọt vào fetch init.
    const { timeoutMs, ...fetchOpts } = opts;
    const url = (this.BASE && typeof path === 'string' && path.startsWith('/')) ? this.BASE + path : path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || this.API_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
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

  // Đổi các mã lỗi kỹ thuật từ runner (CHUA_DANG_NHAP, KHONG_THAY_*, lỗi hạ tầng...) thành câu
  // TIẾNG VIỆT dễ hiểu + hướng xử lý, để người dùng không phải đọc mã lỗi/callog Playwright thô.
  // Không khớp luật nào -> trả DÒNG ĐẦU của lỗi gốc (bỏ callog dài). Lỗi gốc đầy đủ vẫn xem được
  // ở tooltip cột lỗi trong Lịch sử báo.
  friendlyError(msg) {
    const raw = String(msg == null ? '' : msg).trim();
    if (!raw) return 'Lỗi không rõ';
    const rules = [
      [/CHUA_DANG_NHAP/i, '⛔ Zalo chưa đăng nhập — hãy đăng nhập Zalo rồi gửi lại.'],
      [/Session Facebook đã hết hạn|phiên Facebook/i, '⛔ Phiên Facebook đã hết hạn — vào Cài đặt → Tài khoản để đăng nhập lại.'],
      [/KHONG_THAY_HOI_THOAI/i, '🔍 Không tìm thấy cuộc trò chuyện của khách trong mục "Trò chuyện" trên Zalo — kiểm tra khách đã có hội thoại chưa.'],
      [/KHONG_THAY_TAI_KHOAN_ZALO/i, 'Không thấy tài khoản Zalo cần gửi trong danh sách — kiểm tra tài khoản đã kết nối trên Zalo Basso.'],
      [/KHONG_CHON_DUNG_TAI_KHOAN/i, 'Không chọn được đúng tài khoản Zalo — đã huỷ để tránh gửi nhầm. Kiểm tra danh sách tài khoản trên Zalo Basso.'],
      [/KHONG_RO_TAI_KHOAN/i, 'Chưa xác định được tài khoản Zalo để gửi — cấu hình tài khoản cho nhân viên ở Cài đặt → Tài khoản.'],
      [/KHONG_THAY_O_TIM_KIEM|KHONG_THAY_O_NHAP/i, 'Giao diện Zalo chưa sẵn sàng (chưa thấy ô tìm kiếm/nhập tin) — thử lại sau giây lát.'],
      [/KHONG_GUI_DUOC/i, 'Đã bấm gửi nhưng không gửi được (ảnh và tin nhắn đều lỗi) — thử lại.'],
      [/TEST_MODE/i, 'Đang ở chế độ TEST — số khách này không nằm trong danh sách được phép gửi thử.'],
      [/không mở được khung soạn tin|^FB:/i, 'Không mở được khung chat Facebook — link sai, khách chặn, hoặc Messenger đổi giao diện.'],
      [/link Facebook|fbLink/i, 'Chưa có/không hợp lệ link Facebook của khách — vào Cài đặt → Báo qua Facebook để thêm link.'],
      [/Local-runner|local-runner|không trả jobId|Hết thời gian chờ local/i, 'Máy chạy Zalo (local-runner) không phản hồi — kiểm tra máy chạy bot còn bật và kết nối mạng.'],
      [/Quá thời gian chờ|timeout/i, 'Quá thời gian chờ — kết nối chậm hoặc Zalo phản hồi lâu, thử lại.'],
    ];
    for (const [re, friendly] of rules) if (re.test(raw)) return friendly;
    return raw.split('\n')[0].trim();
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

  // Mốc thời gian GỌN cho ô nhỏ (vd cột trạng thái): bỏ năm nếu cùng năm nay -> "18/07 · 00:17";
  // khác năm thì rút năm 2 số -> "18/07/25 · 00:17". Đầy đủ vẫn xem ở tooltip (fmtDateTime).
  fmtShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    const datePart = d.getFullYear() === new Date().getFullYear()
      ? `${p(d.getDate())}/${p(d.getMonth() + 1)}`
      : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
    return `${datePart} · ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // Định dạng số tiền VND: 480000 -> "480,000₫"
  fmtVnd(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '';
    return Number(n).toLocaleString('vi-VN') + '₫';
  },

  // ------------------------------------------------------------------
  // Điều hướng mobile: sidebar ẩn, chỉ hiện khi bấm nút menu (drawer).
  // Chèn nút hamburger vào topbar + lớp phủ nền, và biến rail icon thành
  // drawer trượt từ trái trên màn hình hẹp. Dùng chung cho mọi trang.
  // ------------------------------------------------------------------
  initMobileNav() {
    if (this._mobileNavInit) return;
    this._mobileNavInit = true;
    const app = document.querySelector('.app');
    const sidebar = document.querySelector('.sidebar');
    const topbar = document.querySelector('.topbar');
    if (!app || !sidebar || !topbar) return;

    // Tự chèn mục "Danh bạ" vào rail-nav nếu HTML còn THIẾU (vd trình duyệt/PWA giữ index.html
    // bản CŨ trong cache trong khi app.js đã mới). Nhờ vậy menu luôn đủ dù chưa refresh HTML.
    const rail = sidebar.querySelector('.rail-nav');

    // Gỡ mục "Lịch sử báo" (reports.html) nếu HTML còn trong cache: trang này đã bỏ (gộp vào
    // danh sách hàng về). Xoá thẳng khỏi sidebar để mọi trang nhất quán dù client chưa refresh
    // HTML — nếu không, index.html bản cũ vẫn hiện icon Lịch sử báo còn trang mới thì không.
    sidebar.querySelectorAll('a.nav[href="reports.html"]').forEach((el) => el.remove());

    if (rail && !sidebar.querySelector('a.nav[href="danhba.html"]')) {
      const a = document.createElement('a');
      a.className = 'nav';
      a.href = 'danhba.html';
      a.title = 'Danh bạ Zalo';
      a.innerHTML = '<span class="ic"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><circle cx="12" cy="9" r="2"/><path d="M15.5 15a3.5 3.5 0 0 0-7 0"/></svg></span>';
      if (/danhba\.html$/.test(location.pathname)) a.classList.add('active');
      rail.appendChild(a);
    }

    // Đồng bộ vị trí icon "Cài đặt": bản HTML CŨ (còn trong cache) để gear tách dưới đáy
    // trong .side-foot; bản MỚI đưa vào rail-nav ngay dưới Danh bạ. Nếu gặp bản cũ thì tự
    // dời gear lên nhóm nav để mọi trang hiển thị nhất quán dù client chưa refresh HTML.
    const gear = sidebar.querySelector('a.nav[href="settings.html"]');
    if (rail && gear && !rail.contains(gear)) {
      const danhba = rail.querySelector('a.nav[href="danhba.html"]');
      if (danhba) danhba.insertAdjacentElement('afterend', gear);
      else rail.appendChild(gear);
    }

    // Nút mở menu (chỉ hiện trên mobile qua CSS) — đặt đầu topbar.
    const toggle = document.createElement('button');
    toggle.className = 'nav-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Mở menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
    topbar.insertBefore(toggle, topbar.firstChild);

    // Lớp phủ nền mờ khi mở drawer.
    const backdrop = document.createElement('div');
    backdrop.className = 'nav-backdrop';
    app.appendChild(backdrop);

    // Gắn nhãn chữ cho từng mục điều hướng (đọc từ title) để drawer dễ đọc.
    sidebar.querySelectorAll('a.nav').forEach((a) => {
      if (a.querySelector('.nav-label')) return;
      const label = a.getAttribute('title');
      if (!label) return;
      const span = document.createElement('span');
      span.className = 'nav-label';
      span.textContent = label;
      a.appendChild(span);
    });

    // Nhãn tên người dùng cạnh avatar (chỉ hiện trong drawer). Cập nhật ở applyIdentity.
    const avatar = sidebar.querySelector('.avatar');
    if (avatar && !sidebar.querySelector('.avatar-name')) {
      const name = document.createElement('span');
      name.className = 'nav-label avatar-name';
      name.textContent = 'Tài khoản';
      avatar.insertAdjacentElement('afterend', name);
    }

    const open = () => {
      app.classList.add('nav-open');
      toggle.setAttribute('aria-expanded', 'true');
      document.body.classList.add('nav-lock');
    };
    const close = () => {
      app.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('nav-lock');
    };
    toggle.addEventListener('click', () => (app.classList.contains('nav-open') ? close() : open()));
    backdrop.addEventListener('click', close);
    // Bấm 1 mục điều hướng thì đóng drawer.
    sidebar.querySelectorAll('a.nav').forEach((a) => a.addEventListener('click', close));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // Chuyển sang màn rộng thì luôn đóng để không kẹt trạng thái mở.
    window.addEventListener('resize', () => { if (window.innerWidth > 900) close(); });
  },

  // Lấy thông tin người đang đăng nhập từ gateway (header x-user-email) và hiển thị ở avatar.
  // Fallback: nếu gateway không forward email, đọc từ localStorage (user tự nhập).
  async initUserAvatar() {
    if (this._avatarInit) return;
    this._avatarInit = true;
    const el = document.getElementById('userAvatar') || document.querySelector('.sidebar .avatar');
    if (!el) return;
    el.style.cursor = 'pointer';

    const LS_KEY = 'mi_user_identity';

    function applyIdentity(email, name) {
      if (!email) return;
      const parts = name.trim().split(/\s+/);
      const initials = parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
      el.innerHTML = `<span style="font-size:14px;font-weight:700;line-height:1;">${App.esc(initials)}</span>`;
      el.title = name !== email ? `${name} — ${email}` : email;
      const nameLabel = document.querySelector('.sidebar .avatar-name');
      if (nameLabel) nameLabel.textContent = name || email;
    }

    let email = '', name = '';

    // 1. Thử lấy từ gateway
    try {
      const r = await this.api('/api/me');
      email = r.email || '';
      name = (r.staff && r.staff.name) || email;
    } catch (_) {}

    // 2. Fallback: lấy từ localStorage nếu gateway không có
    if (!email) {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        email = saved.email || '';
        name = saved.name || email;
      } catch (_) {}
    }

    applyIdentity(email, name);

    // Popup khi click: hiện info + form tự nhập nếu chưa có email từ gateway
    el.addEventListener('click', () => {
      const existing = document.getElementById('_userPopup');
      if (existing) { existing.remove(); return; }

      const pop = document.createElement('div');
      pop.id = '_userPopup';
      pop.style.cssText = [
        'position:fixed', 'z-index:9999',
        'background:#fff', 'border:1px solid #e2e8f0', 'border-radius:10px',
        'box-shadow:0 4px 20px rgba(0,0,0,.13)', 'padding:16px 18px',
        'min-width:220px', 'font-size:13px', 'color:#1a202c',
      ].join(';');
      const rect = el.getBoundingClientRect();
      pop.style.left = (rect.right + 8) + 'px';
      pop.style.top = rect.top + 'px';

      if (email) {
        const displayName = name !== email ? name : '';
        pop.innerHTML = `
          ${displayName ? `<div style="font-weight:600;margin-bottom:2px;">${App.esc(displayName)}</div>` : ''}
          <div style="color:#718096;">${App.esc(email)}</div>`;
      } else {
        // Form tự nhập
        pop.innerHTML = `
          <div style="font-weight:600;margin-bottom:10px;">Bạn là ai?</div>
          <input id="_uName" placeholder="Tên hiển thị" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #cbd5e0;border-radius:6px;margin-bottom:6px;font-size:13px;" />
          <input id="_uEmail" placeholder="Email (bắt buộc)" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #cbd5e0;border-radius:6px;margin-bottom:10px;font-size:13px;" />
          <button id="_uSave" style="width:100%;padding:7px;background:var(--primary,#e05c8a);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Lưu</button>`;
        setTimeout(() => {
          const nameEl = document.getElementById('_uName');
          const emailEl = document.getElementById('_uEmail');
          const saveEl = document.getElementById('_uSave');
          if (!nameEl || !emailEl || !saveEl) return;
          // Điền sẵn giá trị cũ nếu có
          try { const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); nameEl.value = s.name || ''; emailEl.value = s.email || ''; } catch (_) {}
          nameEl.focus();
          saveEl.addEventListener('click', () => {
            const newEmail = emailEl.value.trim();
            const newName = nameEl.value.trim() || newEmail;
            if (!newEmail) { emailEl.style.borderColor = 'red'; return; }
            localStorage.setItem(LS_KEY, JSON.stringify({ email: newEmail, name: newName }));
            email = newEmail; name = newName;
            applyIdentity(email, name);
            pop.remove();
          });
        }, 0);
      }

      document.body.appendChild(pop);
      const close = (e) => { if (!pop.contains(e.target) && e.target !== el) { pop.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
  },
};

document.addEventListener('DOMContentLoaded', () => {
  App.initMobileNav();
  App.initUserAvatar();
});
