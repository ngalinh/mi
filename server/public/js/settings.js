(() => {
  const $ = (id) => document.getElementById(id);

  // ---------------- Sub-nav (đổi panel) ----------------
  const tabs = $('settingsTabs');
  const panels = document.querySelectorAll('[data-panel-content]');
  tabs.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    tabs.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    const p = t.dataset.panel;
    panels.forEach((pl) => pl.classList.toggle('hidden', pl.dataset.panelContent !== p));
    if (p === 'proxy') loadProxy();
  });

  // ---------------- Nhân viên (lưu thật ở server: SQLite /api/staff) ----------------
  // Login do gateway ai.basso.vn lo; bảng này chỉ map EMAIL -> vai trò + trạng thái.
  const empRows = $('empRows');
  const em = $('empModal');
  const emTitle = $('emTitle');
  const emName = $('emName'), emEmail = $('emEmail'), emRole = $('emRole'), emStatus = $('emStatus'), emUserId = $('emUserId');
  let editing = null; // email đang sửa, null = thêm mới
  let staffList = [];  // danh sách NV Mi hiện tại (giữ để lấy user_id khi sửa)
  let bassoStaff = []; // danh sách NV trên Basso (user_id + name) để gán ánh xạ

  // Nạp danh sách NV Basso (từ tab_users) -> đổ vào dropdown "NV trên Basso".
  async function loadBassoStaff() {
    try {
      const r = await App.api('/api/tab-users');
      bassoStaff = (r && r.tabUsers) || [];
    } catch { bassoStaff = []; }
    emUserId.innerHTML = '<option value="">— Chưa gán (thấy tất cả) —</option>'
      + bassoStaff.map((u) => `<option value="${App.esc(u.user_id)}">${App.esc(u.name)} (#${App.esc(u.user_id)})</option>`).join('');
  }
  const bassoNameOf = (uid) => {
    const f = bassoStaff.find((u) => String(u.user_id) === String(uid));
    return f ? f.name : ('#' + uid);
  };

  function rolePillHtml(role) {
    if (role === 'Nhân viên') return '<span class="pill chua">Nhân viên</span>';
    const st = role === 'Quản lý' ? 'background:#eaf2fe; color:#2f6fd0;' : 'background:var(--primary-soft); color:var(--primary);';
    return `<span class="pill" style="${st}">${App.esc(role)}</span>`;
  }
  function statusBadgeHtml(status) {
    const cls = status === 'Tạm khoá' ? 'badge-offline' : 'badge-online';
    return `<span class="badge-status ${cls}" style="box-shadow:none; padding:5px 12px;">${App.esc(status)}</span>`;
  }
  function renderStaff(list) {
    staffList = list || [];
    if (!list || !list.length) {
      empRows.innerHTML = '<tr><td colspan="5" class="muted" style="padding:16px;">Chưa có nhân viên nào. Bấm “Thêm nhân viên”.</td></tr>';
      return;
    }
    empRows.innerHTML = list.map((s) => `
      <tr class="main-row" data-email="${App.esc(s.email)}">
        <td class="cust">${App.esc(s.name)}${s.user_id ? `<br><span class="muted" style="font-size:12px">NV Basso: ${App.esc(bassoNameOf(s.user_id))}</span>` : ''}</td>
        <td>${App.esc(s.email)}</td>
        <td>${rolePillHtml(s.role)}</td>
        <td class="center">${statusBadgeHtml(s.status)}</td>
        <td>
          <button class="link-btn" data-action="edit">Sửa</button>
          <button class="link-btn" data-action="del" style="color:var(--danger,#d33)">Xoá</button>
        </td>
      </tr>`).join('');
  }
  async function loadStaff() {
    try {
      const r = await App.api('/api/staff');
      renderStaff(r.staff || []);
    } catch (e) {
      empRows.innerHTML = `<tr><td colspan="5" class="muted" style="padding:16px;">Không tải được danh sách: ${App.esc(e.message)}</td></tr>`;
    }
  }
  function openEmp(s) {
    editing = s ? s.email : null;
    emTitle.textContent = s ? 'Sửa nhân viên' : 'Thêm nhân viên';
    emName.value = s ? s.name : '';
    emEmail.value = s ? s.email : '';
    emEmail.disabled = !!s; // email là khoá đăng nhập — không đổi khi sửa
    emRole.value = s ? s.role : 'Nhân viên';
    emStatus.value = s ? s.status : 'Hoạt động';
    emUserId.value = s && s.user_id != null ? String(s.user_id) : '';
    em.classList.add('show');
  }
  function closeEmp() { em.classList.remove('show'); }

  $('addEmpBtn').addEventListener('click', () => openEmp(null));
  empRows.addEventListener('click', async (e) => {
    const b = e.target.closest('.link-btn'); if (!b) return;
    const tr = b.closest('tr.main-row'); if (!tr) return;
    const email = tr.dataset.email;
    if (b.dataset.action === 'del') {
      if (!confirm(`Xoá nhân viên ${email}?`)) return;
      try {
        await App.api(`/api/staff/${encodeURIComponent(email)}`, { method: 'DELETE' });
        App.toast('✅ Đã xoá nhân viên');
        loadStaff();
      } catch (err) { App.toast(`❌ ${err.message}`, 6000); }
      return;
    }
    openEmp(staffList.find((x) => String(x.email) === String(email)) || { email });
  });
  $('emCancel').addEventListener('click', closeEmp);
  em.addEventListener('click', (e) => { if (e.target === em) closeEmp(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmp(); });
  $('emSave').addEventListener('click', async () => {
    const body = { name: emName.value.trim(), email: emEmail.value.trim(), role: emRole.value, status: emStatus.value, user_id: emUserId.value || '' };
    if (!body.name || !body.email) { App.toast('❌ Cần điền Họ tên và Email đăng nhập', 5000); return; }
    try {
      if (editing) {
        await App.api(`/api/staff/${encodeURIComponent(editing)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else {
        await App.api('/api/staff', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      }
      App.toast('✅ Đã lưu nhân viên');
      closeEmp();
      loadStaff();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    }
  });
  loadBassoStaff().then(loadStaff); // nạp NV Basso trước để hiển thị đúng tên đã gán

  // ---------------- Tài khoản Zalo (nối backend thật) ----------------
  const zaloRows = $('zaloRows');
  const zm = $('zaloModal');
  const zaKey = $('zaKey'), zaName = $('zaName'), zaSalework = $('zaSalework'),
    zaPhone = $('zaPhone'), zaStaffId = $('zaStaffId'), zaBrand = $('zaBrand'),
    zaProxy = $('zaProxy'), zaAuto = $('zaAuto');
  let zEditing = null; // key đang sửa, null = thêm mới

  function connBadge(c) {
    if (c === 'connected') return '<span class="badge-status badge-online" style="box-shadow:none; padding:5px 12px;">Đã kết nối</span>';
    if (c === 'expired') return '<span class="badge-status badge-offline" style="box-shadow:none; padding:5px 12px;">Mất kết nối</span>';
    return '<span class="badge-status badge-offline" style="box-shadow:none; padding:5px 12px;">Chưa đăng nhập</span>';
  }
  function autoPill(a) {
    return a.autoEnabled === false
      ? '<span class="pill chua" data-action="auto" style="cursor:pointer" title="Bấm để bật">Tắt</span>'
      : '<span class="pill da" data-action="auto" style="cursor:pointer" title="Bấm để tắt">Bật</span>';
  }
  function brandTag(b) {
    return b
      ? `<span class="pill da" style="cursor:default" title="Prefix mã đơn của brand này">${App.esc(b)}</span>`
      : '<span class="muted" title="Nhận mọi brand">—</span>';
  }
  function renderZalo(list) {
    if (!list || !list.length) {
      zaloRows.innerHTML = '<tr><td colspan="7" class="muted" style="padding:16px;">Chưa có tài khoản Zalo nào. Bấm “Thêm tài khoản”.</td></tr>';
      return;
    }
    zaloRows.innerHTML = list.map((a) => `
      <tr class="main-row" data-key="${App.esc(a.key)}">
        <td class="cust">${App.esc(a.name || a.key)}</td>
        <td>${App.esc(a.saleworkName || '')}</td>
        <td class="center">${brandTag(a.brand || '')}</td>
        <td>${App.esc(a.phone || '')}</td>
        <td>${connBadge(a.connection)}</td>
        <td class="center">${autoPill(a)}</td>
        <td>
          <button class="link-btn" data-action="edit">Sửa</button>
          <button class="link-btn" data-action="login">Đăng nhập</button>
          <button class="link-btn" data-action="check">Kiểm tra</button>
          <button class="link-btn" data-action="del" style="color:var(--danger,#d33)">Xoá</button>
        </td>
      </tr>`).join('');
  }
  async function loadZalo() {
    try {
      const r = await App.api('/api/accounts');
      renderZalo(r.zalo || []);
    } catch (e) {
      zaloRows.innerHTML = `<tr><td colspan="7" class="muted" style="padding:16px;">Không tải được danh sách (local-runner offline?): ${App.esc(e.message)}</td></tr>`;
    }
  }
  function openZalo(a) {
    zEditing = a ? a.key : null;
    $('zaTitle').textContent = a ? 'Sửa tài khoản Zalo' : 'Thêm tài khoản Zalo';
    $('zaHint').style.display = a ? 'none' : '';
    zaKey.value = a ? a.key : '';
    zaKey.disabled = !!a; // không đổi key khi sửa
    zaName.value = a ? (a.name || '') : '';
    zaSalework.value = a ? (a.saleworkName || '') : '';
    zaPhone.value = a ? (a.phone || '') : '';
    zaStaffId.value = a ? (a.staffId || '') : '';
    zaBrand.value = a ? (a.brand || '') : '';
    zaProxy.value = a ? (a.proxy || '') : '';
    zaAuto.value = a && a.autoEnabled === false ? 'false' : 'true';
    zm.classList.add('show');
  }
  function closeZalo() { zm.classList.remove('show'); }

  async function saveZalo() {
    const key = zaKey.value.trim();
    const body = {
      name: zaName.value.trim(), saleworkName: zaSalework.value.trim(),
      phone: zaPhone.value.trim(), staffId: zaStaffId.value.trim(),
      brand: zaBrand.value.trim().toUpperCase(),
      proxy: zaProxy.value.trim(), autoEnabled: zaAuto.value === 'true',
    };
    if (!key || !body.name || !body.saleworkName) {
      App.toast('❌ Cần điền: Mã profile, Tên nhân viên, Tên Zalo trong dropdown', 5000);
      return;
    }
    try {
      if (zEditing) {
        await App.api(`/api/accounts/${encodeURIComponent(zEditing)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        App.toast('✅ Đã lưu tài khoản Zalo');
      } else {
        const r = await App.api('/api/accounts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'zalo', key, ...body }),
        });
        App.toast(`✅ ${r.message || 'Đã thêm tài khoản'}`, 7000);
      }
      closeZalo();
      loadZalo();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    }
  }

  async function rowAction(action, key, name) {
    if (action === 'edit') {
      const r = await App.api('/api/accounts').catch(() => ({ zalo: [] }));
      const a = (r.zalo || []).find((x) => x.key === key);
      return openZalo(a || { key });
    }
    if (action === 'login') {
      try { const r = await App.api(`/api/accounts/${encodeURIComponent(key)}/login`, { method: 'POST' });
        App.toast(`🖥️ ${r.message || 'Đang mở Chromium trên máy local-runner'}`, 7000);
      } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
      return undefined;
    }
    if (action === 'check') {
      App.toast('⏳ Đang kiểm tra kết nối (mở trình duyệt)…', 4000);
      try { const r = await App.api(`/api/accounts/${encodeURIComponent(key)}/check`, { method: 'POST' });
        App.toast(r.loggedIn ? '✅ Còn đăng nhập' : `⚠️ Mất kết nối — cần đăng nhập lại${r.error ? ` (${r.error})` : ''}`, 6000);
        loadZalo();
      } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
      return undefined;
    }
    if (action === 'del') {
      if (!confirm(`Xoá tài khoản Zalo "${name || key}"? Session đăng nhập cũng bị xoá.`)) return undefined;
      try { await App.api(`/api/accounts/zalo/${encodeURIComponent(key)}`, { method: 'DELETE' });
        App.toast('Đã xoá tài khoản'); loadZalo();
      } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
      return undefined;
    }
    if (action === 'auto') {
      const r = await App.api('/api/accounts').catch(() => ({ zalo: [] }));
      const a = (r.zalo || []).find((x) => x.key === key);
      const next = !(a && a.autoEnabled !== false);
      try { await App.api(`/api/accounts/${encodeURIComponent(key)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoEnabled: next }),
        });
        App.toast(next ? 'Đã BẬT tự động báo cho tài khoản này' : 'Đã TẮT tự động báo cho tài khoản này');
        loadZalo();
      } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
    }
    return undefined;
  }

  $('addZaloBtn').addEventListener('click', () => openZalo(null));
  $('zaCancel').addEventListener('click', closeZalo);
  $('zaSave').addEventListener('click', saveZalo);
  zm.addEventListener('click', (e) => { if (e.target === zm) closeZalo(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeZalo(); });
  zaloRows.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    const tr = b.closest('tr.main-row'); if (!tr) return;
    rowAction(b.dataset.action, tr.dataset.key, tr.children[0].textContent.trim());
  });
  loadZalo();

  // ---------------- Proxy theo tài khoản Zalo (nối backend thật) ----------------
  const proxyRows = $('proxyRows');

  function proxyStatusPill(p) {
    return p
      ? '<span class="pill da">Đang dùng</span>'
      : '<span class="pill chua">Không dùng</span>';
  }
  function renderProxy(list) {
    if (!list || !list.length) {
      proxyRows.innerHTML = '<tr><td colspan="5" class="muted" style="padding:16px;">Chưa có tài khoản Zalo nào. Thêm tài khoản ở tab “Tài khoản Zalo”.</td></tr>';
      return;
    }
    proxyRows.innerHTML = list.map((a) => `
      <tr class="main-row" data-key="${App.esc(a.key)}">
        <td class="cust">${App.esc(a.name || a.key)}</td>
        <td>${App.esc(a.saleworkName || '')}</td>
        <td>
          <div class="note-cell">
            <input class="note-input proxy-input" data-key="${App.esc(a.key)}" value="${App.esc(a.proxy || '')}" placeholder="host:port hoặc user:pass@host:port" />
          </div>
        </td>
        <td class="center" data-cell="status">${proxyStatusPill(a.proxy)}</td>
        <td>
          <button class="link-btn" data-action="save-proxy">Lưu</button>
          <button class="link-btn" data-action="clear-proxy" style="color:var(--danger,#d33)">Xoá</button>
        </td>
      </tr>`).join('');
  }
  async function loadProxy() {
    proxyRows.innerHTML = '<tr><td colspan="5" class="muted" style="padding:16px;">Đang tải…</td></tr>';
    try {
      const r = await App.api('/api/accounts');
      renderProxy(r.zalo || []);
    } catch (e) {
      proxyRows.innerHTML = `<tr><td colspan="5" class="muted" style="padding:16px;">Không tải được danh sách (local-runner offline?): ${App.esc(e.message)}</td></tr>`;
    }
  }
  async function saveProxy(key, proxy, tr) {
    try {
      await App.api(`/api/accounts/${encodeURIComponent(key)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxy }),
      });
      const cell = tr && tr.querySelector('[data-cell="status"]');
      if (cell) cell.innerHTML = proxyStatusPill(proxy);
      App.toast(proxy ? '✅ Đã lưu proxy cho tài khoản này' : 'Đã xoá proxy của tài khoản này');
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    }
  }

  proxyRows.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    const tr = b.closest('tr.main-row'); if (!tr) return;
    const key = tr.dataset.key;
    const input = tr.querySelector('.proxy-input');
    if (b.dataset.action === 'clear-proxy') { if (input) input.value = ''; return saveProxy(key, '', tr); }
    return saveProxy(key, input ? input.value.trim() : '', tr);
  });
  proxyRows.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('.proxy-input'); if (!input) return;
    const tr = input.closest('tr.main-row');
    saveProxy(tr.dataset.key, input.value.trim(), tr);
  });
  $('proxyReload').addEventListener('click', loadProxy);

  // ---------------- Chế độ (nối backend thật) ----------------
  let autoEnabled = false;
  let scheduleTime = '';

  function renderAutoBadge(a) {
    autoEnabled = !!(a && a.enabled);
    const el = $('autoBadge');
    const sched = a && a.scheduleTime;
    let mode;
    if (!autoEnabled) mode = 'Tắt';
    else if (sched) mode = `Bật (gửi lúc ${sched})`;
    else mode = `Bật (mỗi ${Math.round(((a && a.intervalMs) || 0) / 1000)}s)`;
    el.textContent = 'Tự động: ' + mode;
    el.className = 'badge-status badge-clickable ' + (autoEnabled ? 'badge-online' : 'badge-offline');
    renderSchedule(a);
    renderAlert(a);
  }

  // ---- Nhắc ra Zalo (nội bộ) ----
  let alertEnabled = false;
  function renderAlert(a) {
    if (!a) return;
    alertEnabled = !!a.alertEnabled;
    const badge = $('alertBadge');
    if (badge) {
      badge.textContent = 'Nhắc Zalo: ' + (alertEnabled ? 'Bật' : 'Tắt');
      badge.className = 'badge-status badge-clickable ' + (alertEnabled ? 'badge-online' : 'badge-offline');
    }
    const setIf = (id, val) => { const el = $(id); if (el && document.activeElement !== el) el.value = val || ''; };
    setIf('alertAccount', a.alertAccount);
    setIf('alertPhone', a.alertPhone);
    setIf('alertName', a.alertName);
    const st = $('alertStatus');
    if (st) {
      if (a.lastAlert && a.lastAlert.at) {
        const t = new Date(a.lastAlert.at).toLocaleString('vi-VN');
        st.innerHTML = a.lastAlert.ok
          ? `<span style="color:var(--primary)">✓ Đã gửi nhắc lúc ${App.esc(t)}${a.lastAlert.phone ? ` tới ${App.esc(a.lastAlert.phone)}` : ''}</span>`
          : `<span style="color:var(--danger,#d33)">✗ Nhắc lỗi lúc ${App.esc(t)}: ${App.esc(a.lastAlert.error || '')}</span>`;
      } else {
        st.textContent = '';
      }
    }
  }

  async function toggleAlert() {
    const next = !alertEnabled;
    if (next && !($('alertPhone').value || '').trim()) {
      App.toast('❌ Nhập SĐT nhận trước khi bật', 5000); return;
    }
    try {
      const a = await App.api('/api/auto-notify/alert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next, account: $('alertAccount').value.trim(), phone: $('alertPhone').value.trim(), name: $('alertName').value.trim() }),
      });
      renderAlert(a);
      App.toast(next ? '✅ Đã bật nhắc ra Zalo' : 'Đã tắt nhắc ra Zalo');
    } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
  }

  async function saveAlert() {
    try {
      const a = await App.api('/api/auto-notify/alert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: $('alertAccount').value.trim(), phone: $('alertPhone').value.trim(), name: $('alertName').value.trim() }),
      });
      renderAlert(a);
      App.toast('✅ Đã lưu cấu hình nhắc Zalo');
    } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
  }

  async function testAlert() {
    const btn = $('alertTest');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang gửi…';
    try {
      const r = await App.api('/api/auto-notify/alert-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: $('alertAccount').value.trim(), phone: $('alertPhone').value.trim(), name: $('alertName').value.trim() }),
      });
      App.toast(r.ok ? '✅ Đã gửi tin thử — kiểm tra Zalo của bạn' : `❌ Gửi thử lỗi: ${r.error || 'không rõ'}`, 7000);
    } catch (e) { App.toast(`❌ ${e.message}`, 7000); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  }

  // Đổ giờ gửi + trạng thái lượt kế vào ô nhập (không đè khi admin đang gõ).
  function renderSchedule(a) {
    if (!a) return;
    scheduleTime = a.scheduleTime || '';
    const input = $('scheduleInput');
    if (input && document.activeElement !== input) input.value = scheduleTime;
    const pcInput = $('precheckInput');
    if (pcInput && document.activeElement !== pcInput) pcInput.value = (a.precheckMinutes != null ? a.precheckMinutes : 30);
    // Dòng "giờ gửi kế tiếp"
    const nextEl = $('scheduleNext');
    if (nextEl) {
      if (!autoEnabled) nextEl.textContent = '';
      else if (!scheduleTime) nextEl.textContent = '· đang gửi ngay khi có hàng về';
      else {
        const s = a.schedule || {};
        const label = s.next === 'done_today' ? 'đã gửi lượt hôm nay'
          : s.next === 'due' ? 'đã tới giờ — sẽ gửi ở lần kiểm tra kế'
            : 'sẽ gửi hôm nay lúc ' + scheduleTime;
        nextEl.textContent = '· ' + label + (a.timezone ? ` (${a.timezone})` : '');
      }
    }
    // Dòng "giờ nhắc"
    const pcNext = $('precheckNext');
    if (pcNext) {
      const s = a.schedule || {};
      pcNext.textContent = (scheduleTime && s.precheckTime) ? `· nhắc lúc ${s.precheckTime}` : '';
    }
    // Kết quả lần nhắc gần nhất (nếu có)
    renderPrecheckResult(a.lastPrecheck);
  }

  // Hiển thị kết quả lần "nhắc soạn ND" gần nhất do bot tự chạy trước giờ gửi.
  function renderPrecheckResult(lp) {
    const box = $('precheckResult');
    if (!box) return;
    if (!lp) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const t = lp.at ? new Date(lp.at).toLocaleString('vi-VN') : '';
    const willSend = lp.willSend != null ? lp.willSend : lp.ready;
    const head = `🔔 Nhắc lúc ${App.esc(t)}: <strong style="color:var(--primary)">${willSend}</strong> đơn sẽ gửi · <strong>${lp.missingContent}</strong> thiếu ND`;
    let body = '';
    if (lp.missingContent) {
      const names = (lp.missingList || []).slice(0, 20)
        .map((o) => App.esc(o.customerName || o.orderCode || '?') + (o.staff ? ` (${App.esc(o.staff)})` : ''))
        .join(', ');
      body += `<div style="margin-top:4px; color:var(--danger,#d33)">⚠️ Cần soạn nốt nội dung: ${names}${(lp.missingList || []).length > 20 ? '…' : ''}</div>`;
    } else {
      body += '<div style="margin-top:4px; color:var(--primary)">✓ Tất cả đơn sẽ gửi đều đã có nội dung.</div>';
    }
    const skipLine = fmtSkipReasons(lp);
    if (skipLine) body += `<div style="margin-top:4px;" class="muted">Bỏ qua: ${skipLine}</div>`;
    box.style.display = '';
    box.innerHTML = head + body;
  }

  async function toggleAuto() {
    const next = !autoEnabled;
    if (next) {
      const msg = scheduleTime
        ? `Bật TỰ ĐỘNG báo hàng? Mỗi ngày lúc ${scheduleTime} hệ thống sẽ gửi tin cho mọi đơn "Chưa báo" đã có nội dung.`
        : 'Bật TỰ ĐỘNG báo hàng? Chưa đặt giờ cố định nên hệ thống sẽ gửi NGAY cho mọi đơn "Chưa báo".';
      if (!confirm(msg)) return;
    }
    try {
      const a = await App.api('/api/auto-notify/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      renderAutoBadge(a);
      App.toast(next ? '✅ Đã bật tự động báo hàng' : 'Đã tắt tự động báo hàng');
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
    }
  }

  async function saveSchedule() {
    const time = ($('scheduleInput').value || '').trim();
    const pcRaw = ($('precheckInput').value || '').trim();
    const body = { time };
    if (pcRaw !== '') body.precheckMinutes = Number(pcRaw);
    try {
      const a = await App.api('/api/auto-notify/schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      renderAutoBadge(a);
      const pcMsg = a.precheckMinutes > 0 ? `, nhắc trước ${a.precheckMinutes} phút` : '';
      App.toast(time ? `✅ Đã đặt giờ gửi: ${a.scheduleTime}${pcMsg}` : '✅ Đã bỏ hẹn giờ — gửi ngay khi có hàng về');
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    }
  }

  // Gộp các lý do "bỏ qua ngoài thiếu ND" thành 1 dòng dễ đọc.
  function fmtSkipReasons(r) {
    const parts = [];
    if (r.skippedBacklog) parts.push(`${r.skippedBacklog} tồn cũ (về trước khi bật auto)`);
    if (r.skippedDelayed) parts.push(`${r.skippedDelayed} đã Delay`);
    if (r.skippedAutoOff) parts.push(`${r.skippedAutoOff} account tắt auto`);
    if (r.skippedNoAccount) parts.push(`${r.skippedNoAccount} không khớp account`);
    if (r.skippedBrand) parts.push(`${r.skippedBrand} chưa có Zalo brand`);
    return parts.join(' · ');
  }

  async function runPreview() {
    const box = $('previewResult');
    const btn = $('previewBtn');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang kiểm tra…';
    box.style.display = '';
    box.innerHTML = 'Đang quét đơn "Chưa báo"…';
    try {
      const r = await App.api('/api/auto-notify/preview');
      const willSend = r.willSend != null ? r.willSend : r.ready;
      const when = r.scheduleTime ? `lúc ${r.scheduleTime}` : '(chưa đặt giờ)';
      const missWarn = r.missingContent
        ? `<span style="color:var(--danger,#d33)">⚠️ ${r.missingContent} đơn CHƯA có nội dung báo hàng — sẽ bị bỏ qua tới giờ gửi.</span>`
        : '<span style="color:var(--primary)">✓ Mọi đơn sẽ gửi đều đã có nội dung.</span>';
      const names = (r.missingList || []).slice(0, 20)
        .map((o) => App.esc(o.customerName || o.orderCode || '?') + (o.staff ? ` (${App.esc(o.staff)})` : ''))
        .join(', ');
      const skipLine = fmtSkipReasons(r);
      box.innerHTML = `
        <div><strong style="color:var(--primary)">${willSend}</strong> đơn SẼ GỬI ${when} · <strong>${r.missingContent}</strong> thiếu ND · ${r.skippedOther || 0} bỏ qua khác · ${r.alreadyHandled} đã báo <span class="muted">(tổng ${r.scanned} đơn "Chưa báo")</span></div>
        <div style="margin-top:6px;">${missWarn}</div>
        ${r.missingContent ? `<div style="margin-top:6px;" class="muted">Thiếu ND: ${names}${r.missingList.length > 20 ? '…' : ''}</div>` : ''}
        ${skipLine ? `<div style="margin-top:6px;" class="muted">Bỏ qua: ${skipLine}</div>` : ''}
        ${!r.runnerOnline ? '<div style="margin-top:6px; color:var(--danger,#d33)">⚠️ Local-runner đang offline — tới giờ sẽ không gửi được cho tới khi online lại.</div>' : ''}`;
    } catch (e) {
      box.innerHTML = `<span style="color:var(--danger,#d33)">❌ ${App.esc(e.message)}</span>`;
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  }

  // ---- Chặn an toàn khi test (TEST_MODE + whitelist SĐT) ----
  let testMode = false;
  let testKnown = false; // đã biết trạng thái thật từ runner chưa (tránh render khi offline)

  function renderTestMode(t, online = true) {
    const badge = $('testModeBadge');
    const saveBtn = $('testPhonesSave');
    const input = $('testPhonesInput');
    if (!online || !t) {
      testKnown = false;
      badge.textContent = 'TEST: (local-runner offline)';
      badge.className = 'badge-status badge-offline';
      saveBtn.disabled = true;
      return;
    }
    testKnown = true;
    testMode = !!t.testMode;
    badge.textContent = 'TEST: ' + (testMode ? 'Bật (chỉ gửi số whitelist)' : 'Tắt (gửi khách thật)');
    badge.className = 'badge-status badge-clickable ' + (testMode ? 'badge-online' : 'badge-offline');
    saveBtn.disabled = false;
    // Không đè khi người dùng đang gõ (loadHealth chạy nền mỗi 15s).
    if (document.activeElement !== input) input.value = (t.testPhones || []).join(', ');
  }

  async function saveTestMode(patch, okMsg) {
    const t = await App.api('/api/test-mode', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    renderTestMode(t, true);
    if (okMsg) App.toast(okMsg);
    return t;
  }

  async function toggleTestMode() {
    if (!testKnown) { App.toast('⚠️ Local-runner offline — chưa đổi được', 4000); return; }
    const next = !testMode;
    if (!next && !confirm('TẮT chặn an toàn? Bot sẽ gửi tới SĐT THẬT của MỌI khách. Chắc chắn?')) return;
    try {
      await saveTestMode({ testMode: next },
        next ? '✅ Đã bật chặn an toàn (chỉ gửi số trong danh sách)' : '⚠️ Đã tắt chặn an toàn — sẽ gửi khách thật');
    } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
  }

  async function saveTestPhones() {
    if (!testKnown) { App.toast('⚠️ Local-runner offline — chưa lưu được', 4000); return; }
    try {
      await saveTestMode({ testPhones: $('testPhonesInput').value }, '✅ Đã lưu danh sách số test');
    } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
  }

  async function loadHealth() {
    try {
      const h = await App.api('/api/health');
      const lb = $('localBadge');
      lb.textContent = 'Local-runner: ' + (h.localRunner.online ? 'online' : 'offline');
      lb.className = 'badge-status ' + (h.localRunner.online ? 'badge-online' : 'badge-offline');
      $('modeMockBadge').style.display = h.mock ? '' : 'none';
      $('modeLiveBadge').style.display = h.mock ? 'none' : '';
      if (h.autoNotify) renderAutoBadge(h.autoNotify);
      renderTestMode(
        { testMode: h.localRunner.testMode, testPhones: h.localRunner.testPhones },
        !!h.localRunner.online,
      );
    } catch { /* ignore */ }
  }

  async function pingBasso() {
    const btn = $('bassoBtn');
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang kiểm tra...';
    try {
      const r = await App.api('/api/basso/ping');
      if (r.connected) {
        const s = r.sample ? ` · đơn mẫu: ${r.sample.customerName}` : ' · danh sách trống';
        App.toast(`✅ Basso OK (${r.ms}ms · ${r.total ?? 0} đơn${s})`, 6000);
      } else if (r.mock) {
        App.toast('⚠️ Đang ở chế độ MOCK — chưa nối Basso thật (đặt BASSO_API_BASE_URL, USE_MOCK=false).', 7000);
      } else {
        App.toast(`❌ Không kết nối được Basso: ${r.error}`, 8000);
      }
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  }

  $('autoBadge').addEventListener('click', toggleAuto);
  $('scheduleSave').addEventListener('click', saveSchedule);
  $('scheduleInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSchedule(); });
  $('precheckInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSchedule(); });
  $('previewBtn').addEventListener('click', runPreview);
  $('alertBadge').addEventListener('click', toggleAlert);
  $('alertSave').addEventListener('click', saveAlert);
  $('alertTest').addEventListener('click', testAlert);
  $('bassoBtn').addEventListener('click', pingBasso);
  $('testModeBadge').addEventListener('click', toggleTestMode);
  $('testPhonesSave').addEventListener('click', saveTestPhones);
  $('testPhonesInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveTestPhones(); });

  loadHealth();
  setInterval(loadHealth, 15000);
})();
