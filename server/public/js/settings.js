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
    if (p === 'zalo') loadZalo();
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

  // ---------------- Tài khoản nhân viên (Zalo + Facebook, gộp 1 chỗ) ----------------
  const zaloRows = $('zaloRows');
  const zm = $('zaloModal');
  const zaKey = $('zaKey'), zaName = $('zaName'), zaSalework = $('zaSalework'),
    zaFbName = $('zaFbName'),
    zaEmail = $('zaEmail'), zaPassword = $('zaPassword'), zaPlatform = $('zaPlatform'),
    zaPhone = $('zaPhone'), zaStaffId = $('zaStaffId'), zaBrand = $('zaBrand'),
    zaProxy = $('zaProxy'), zaAuto = $('zaAuto'), zaTarget = $('zaTarget');
  let zEditing = null;   // key đang sửa, null = thêm mới
  let accountsAll = [];  // toàn bộ account (cả 2 kênh) lần tải gần nhất

  // Icon SVG line dùng chung cho các nút hành động (đồng bộ với .icon toàn hệ).
  const IC = {
    edit: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    login: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>',
    check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    del: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    plus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };

  function connMeta(c) {
    if (c === 'connected') return { cls: 'on', label: 'Đã kết nối' };
    if (c === 'expired') return { cls: 'off', label: 'Mất kết nối' };
    return { cls: 'idle', label: 'Chưa đăng nhập' };
  }
  function connBadge(c) {
    const m = connMeta(c);
    return `<span class="acct-conn ${m.cls}">${m.label}</span>`;
  }
  // Chip điều khiển CÓ NHÃN: nhãn mờ + giá trị đậm màu theo NGHĨA (không mượn đỏ/vàng "cảnh báo").
  function autoTgl(a) {
    const on = a.autoEnabled !== false;
    return `<button class="tgl ${on ? 'is-on' : 'is-off'}" data-action="auto" title="Tự động báo hàng — bấm để ${on ? 'tắt' : 'bật'}"><span class="tgl-label">Tự động</span><span class="tgl-val">${on ? 'Bật' : 'Tắt'}</span></button>`;
  }
  // Đích báo: 'personal' = nhắn cá nhân, mặc định = nhóm. Cả hai đều hợp lệ → dùng tông trung tính.
  function targetTgl(a) {
    const personal = a.notifyTarget === 'personal';
    return `<button class="tgl is-mode" data-action="target" title="Đích báo — bấm để đổi ${personal ? 'sang Nhóm' : 'sang Cá nhân'}"><span class="tgl-label">Báo</span><span class="tgl-val">${personal ? 'Cá nhân' : 'Nhóm'}</span></button>`;
  }
  function brandTag(b) {
    return b ? `<span class="acct-brand" title="Chỉ nhận đơn brand ${App.esc(b)}">${App.esc(b)}</span>` : '';
  }
  const platLabel = (p) => (p === 'facebook' ? 'Facebook' : 'Zalo');
  const findAcct = (key) => accountsAll.find((x) => x.key === key);

  // Gom account về từng nhân viên: ưu tiên staffId, rồi tên, cuối cùng key.
  function groupAccounts(list) {
    const groups = new Map();
    for (const a of (list || [])) {
      const gk = a.staffId ? `s:${a.staffId}` : (a.name ? `n:${a.name.toLowerCase()}` : `k:${a.key}`);
      if (!groups.has(gk)) groups.set(gk, { name: a.name || a.key, staffId: a.staffId || '', zalo: [], facebook: [] });
      const g = groups.get(gk);
      if (!g.name && a.name) g.name = a.name;
      (a.platform === 'facebook' ? g.facebook : g.zalo).push(a);
    }
    return [...groups.values()];
  }

  // Nhãn kênh (Zalo / Facebook) — thay cho 2 cột riêng, giúp gộp mọi tài khoản về 1 bảng phẳng.
  function chanTag(p) {
    return p === 'facebook'
      ? '<span class="chan fb">Facebook</span>'
      : '<span class="chan zalo">Zalo</span>';
  }

  // Tóm tắt nhanh cho cột Nhân viên: tổng tài khoản + số kết nối / chưa kết nối.
  function empMeta(g) {
    const all = [...g.zalo, ...g.facebook];
    if (!all.length) return '';
    const off = all.filter((a) => a.connection !== 'connected').length;
    const on = all.length - off;
    const parts = [`${all.length} tài khoản`];
    if (on) parts.push(`<span class="on">${on} kết nối</span>`);
    if (off) parts.push(`<span class="off">${off} chưa/mất</span>`);
    return `<div class="acct-emp-meta">${parts.join(' · ')}</div>`;
  }

  // Vạch trạng thái trái mỗi dòng (đọc nhanh ở rìa mắt): đỏ = cần đăng nhập,
  // xanh = đang chạy (kết nối + tự động bật), xám = ổn nhưng tự động đang tắt.
  function healthClass(a) {
    if (a.connection !== 'connected') return 'st-alert';
    return a.autoEnabled !== false ? 'st-live' : 'st-quiet';
  }

  // 1 tài khoản = 1 dòng; các cột (kênh · trạng thái · tự động · đích báo · thao tác) thẳng hàng.
  // Tên NV chỉ hiện ở dòng đầu của nhóm. Đăng nhập bung chữ (primary) khi CHƯA kết nối.
  function acctRow(a, group, first) {
    const isFb = a.platform === 'facebook';
    const title = isFb ? (a.fbName || a.name || a.key) : (a.saleworkName || a.name || a.key);
    const need = a.connection !== 'connected';
    const empCell = first
      ? `<div class="emp-name">${App.esc(group.name)}</div>${group.staffId ? `<div class="emp-sub">NV Basso #${App.esc(group.staffId)}</div>` : ''}${empMeta(group)}`
      : '';
    return `<tr class="acct-row ${healthClass(a)}${first ? ' grp-first' : ''}" data-key="${App.esc(a.key)}" data-platform="${a.platform}">
      <td class="acct-emp">${empCell}</td>
      <td class="acct-cell">${App.esc(title)}${isFb || !a.brand ? '' : ` ${brandTag(a.brand)}`}</td>
      <td>${chanTag(a.platform)}</td>
      <td>${connBadge(a.connection)}</td>
      <td>${autoTgl(a)}</td>
      <td>${isFb ? '<span class="muted">—</span>' : targetTgl(a)}</td>
      <td class="acct-act-cell"><div class="acct-acts">
        <button class="ibtn${need ? ' primary' : ''}" data-action="login" title="Mở Chromium trên local-runner để đăng nhập">${IC.login}${need ? '<span>Đăng nhập</span>' : ''}</button>
        <button class="ibtn" data-action="edit" title="Sửa thông tin tài khoản">${IC.edit}</button>
        <button class="ibtn" data-action="check" title="Kiểm tra còn đăng nhập không">${IC.check}</button>
        <button class="ibtn danger" data-action="del" title="Xoá tài khoản">${IC.del}</button>
      </div></td>
    </tr>`;
  }

  // Dòng "Thêm tài khoản" cuối mỗi nhóm — chọn Zalo/Facebook ngay trong popup.
  function addRow(group) {
    return `<tr class="acct-add-row">
      <td></td>
      <td colspan="6"><button class="acct-add-flat" data-action="add" data-name="${App.esc(group.name)}" data-staffid="${App.esc(group.staffId)}">${IC.plus}<span>Thêm tài khoản cho ${App.esc(group.name)}</span></button></td>
    </tr>`;
  }

  function renderAccounts(list) {
    accountsAll = list || [];
    const groups = groupAccounts(accountsAll);
    if (!groups.length) {
      zaloRows.innerHTML = '<tr><td colspan="7" class="muted" style="padding:16px;">Chưa có tài khoản nào. Bấm “Thêm tài khoản”.</td></tr>';
      return;
    }
    zaloRows.innerHTML = groups.map((g) => {
      const all = [...g.zalo, ...g.facebook];
      return all.map((a, i) => acctRow(a, g, i === 0)).join('') + addRow(g);
    }).join('');
  }
  async function loadZalo() {
    try {
      const r = await App.api('/api/accounts');
      renderAccounts(r.accounts || r.zalo || []);
    } catch (e) {
      zaloRows.innerHTML = `<tr><td colspan="7" class="muted" style="padding:16px;">Không tải được danh sách (local-runner offline?): ${App.esc(e.message)}</td></tr>`;
    }
  }

  // Ẩn/hiện field theo nền tảng: .pf-zalo chỉ cho Zalo, .pf-fb chỉ cho Facebook.
  function applyPlatformFields(platform) {
    const fb = platform === 'facebook';
    document.querySelectorAll('#zaloModal .pf-zalo').forEach((el) => { el.style.display = fb ? 'none' : ''; });
    document.querySelectorAll('#zaloModal .pf-fb').forEach((el) => { el.style.display = fb ? '' : 'none'; });
  }

  function openZalo(a, presets) {
    presets = presets || {};
    zEditing = a ? a.key : null;
    const platform = a ? (a.platform || 'zalo') : (presets.platform || 'zalo');
    zaPlatform.value = platform;
    zaPlatform.disabled = !!a; // nền tảng bất biến khi sửa
    applyPlatformFields(platform);
    $('zaTitle').textContent = a ? 'Sửa tài khoản' : 'Thêm tài khoản';
    $('zaHint').style.display = a ? 'none' : '';
    zaKey.value = a ? a.key : '';
    zaKey.disabled = !!a; // không đổi key khi sửa
    zaName.value = a ? (a.name || '') : (presets.name || '');
    zaSalework.value = a ? (a.saleworkName || '') : '';
    zaFbName.value = a ? (a.fbName || '') : '';
    zaEmail.value = a ? (a.email || '') : '';
    zaPassword.value = a ? (a.password || '') : '';
    zaPhone.value = a ? (a.phone || '') : '';
    zaStaffId.value = a ? (a.staffId || '') : (presets.staffId || '');
    zaBrand.value = a ? (a.brand || '') : '';
    zaProxy.value = a ? (a.proxy || '') : '';
    zaAuto.value = a && a.autoEnabled === false ? 'false' : 'true';
    zaTarget.value = a && a.notifyTarget === 'personal' ? 'personal' : 'group';
    zm.classList.add('show');
  }
  function closeZalo() { zm.classList.remove('show'); }

  async function saveZalo() {
    const platform = zaPlatform.value === 'facebook' ? 'facebook' : 'zalo';
    const key = zaKey.value.trim();
    const body = {
      name: zaName.value.trim(),
      phone: zaPhone.value.trim(), staffId: zaStaffId.value.trim(),
      proxy: zaProxy.value.trim(), autoEnabled: zaAuto.value === 'true',
    };
    if (platform === 'facebook') {
      body.fbName = zaFbName.value.trim();
      body.email = zaEmail.value.trim();
      body.password = zaPassword.value;
    } else {
      body.saleworkName = zaSalework.value.trim();
      body.brand = zaBrand.value.trim().toUpperCase();
      body.notifyTarget = zaTarget.value === 'personal' ? 'personal' : 'group';
    }
    if (!key || !body.name) { App.toast('❌ Cần điền: Mã profile và Tên nhân viên', 5000); return; }
    if (platform === 'zalo' && !body.saleworkName) { App.toast('❌ Zalo cần "Tên trong dropdown"', 5000); return; }
    try {
      if (zEditing) {
        await App.api(`/api/accounts/${encodeURIComponent(zEditing)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        App.toast(`✅ Đã lưu tài khoản ${platLabel(platform)}`);
      } else {
        const r = await App.api('/api/accounts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: platform, key, ...body }),
        });
        App.toast(`✅ ${r.message || 'Đã thêm tài khoản'}`, 7000);
      }
      closeZalo();
      loadZalo();
    } catch (e) {
      App.toast(`❌ ${e.message}`, 6000);
    }
  }

  async function rowAction(action, key) {
    const a = findAcct(key);
    const platform = a ? a.platform : 'zalo';
    if (action === 'edit') return openZalo(a || { key });
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
      if (!confirm(`Xoá tài khoản ${platLabel(platform)} "${(a && a.name) || key}"? Session đăng nhập cũng bị xoá.`)) return undefined;
      try { await App.api(`/api/accounts/${platform}/${encodeURIComponent(key)}`, { method: 'DELETE' });
        App.toast('Đã xoá tài khoản'); loadZalo();
      } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
      return undefined;
    }
    if (action === 'auto') {
      const next = !(a && a.autoEnabled !== false);
      try { await App.api(`/api/accounts/${encodeURIComponent(key)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoEnabled: next }),
        });
        App.toast(next ? 'Đã BẬT tự động báo cho tài khoản này' : 'Đã TẮT tự động báo cho tài khoản này');
        loadZalo();
      } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
    }
    if (action === 'target') {
      const next = a && a.notifyTarget === 'personal' ? 'group' : 'personal';
      try { await App.api(`/api/accounts/${encodeURIComponent(key)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifyTarget: next }),
        });
        App.toast(next === 'personal' ? 'Kiểu báo: CÁ NHÂN (nhắn tin cá nhân)' : 'Kiểu báo: NHÓM (báo vào nhóm)');
        loadZalo();
      } catch (e) { App.toast(`❌ ${e.message}`, 6000); }
    }
    return undefined;
  }

  $('addZaloBtn').addEventListener('click', () => openZalo(null, {}));
  zaPlatform.addEventListener('change', () => applyPlatformFields(zaPlatform.value));
  $('zaCancel').addEventListener('click', closeZalo);
  $('zaSave').addEventListener('click', saveZalo);
  zm.addEventListener('click', (e) => { if (e.target === zm) closeZalo(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeZalo(); });
  zaloRows.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    if (b.dataset.action === 'add') {
      return openZalo(null, { platform: b.dataset.platform, name: b.dataset.name, staffId: b.dataset.staffid });
    }
    const block = b.closest('.acct-row'); if (!block) return undefined;
    return rowAction(b.dataset.action, block.dataset.key);
  });
  loadZalo();

  // Khách báo qua Facebook nay quản ở trang Danh bạ (theo SĐT + link + NV phụ trách) — bỏ tab riêng.

  // ---------------- Proxy theo tài khoản Zalo & Facebook (nối backend thật) ----------------
  const proxyRows = $('proxyRows');

  function proxyStatusPill(p) {
    return p
      ? '<span class="pill da">Đang dùng</span>'
      : '<span class="pill chua">Không dùng</span>';
  }
  function renderProxy(list) {
    if (!list || !list.length) {
      proxyRows.innerHTML = '<tr><td colspan="5" class="muted" style="padding:16px;">Chưa có tài khoản Zalo hoặc Facebook nào. Thêm tài khoản ở tab “Tài khoản”.</td></tr>';
      return;
    }
    proxyRows.innerHTML = list.map((a) => `
      <tr class="main-row" data-key="${App.esc(a.key)}">
        <td class="cust">${App.esc(a.name || a.key)}</td>
        <td>${App.esc(a.saleworkName || a.fbName || '')} <span class="muted" style="font-size:11px">${a.platform === 'facebook' ? '(FB)' : '(Zalo)'}</span></td>
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
      renderProxy(r.accounts || r.zalo || []);
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
    renderAutoShip(a);
  }

  // ---- Tự động báo ship (công tắc riêng) ----
  let shipEnabled = false;
  let runnerOnline = true; // cập nhật từ loadHealth để cảnh báo khi runner offline
  function renderAutoShip(a) {
    if (!a) return;
    shipEnabled = !!a.shipEnabled;
    const badge = $('autoShipBadge');
    if (badge) {
      badge.textContent = 'Ship: ' + (shipEnabled ? 'Bật' : 'Tắt');
      badge.className = 'badge-status badge-clickable ' + (shipEnabled ? 'badge-online' : 'badge-offline');
    }
    const st = $('autoShipStatus');
    if (!st) return;
    const parts = [];
    const r = a.lastShipResult;
    if (r && (r.sent || r.failed)) {
      const at = a.lastShipRun ? new Date(a.lastShipRun).toLocaleString('vi-VN') : '';
      parts.push(`Lần gửi ship gần nhất${at ? ` (${App.esc(at)})` : ''}: ${r.sent || 0} ✅ / ${r.failed || 0} ❌`);
    } else if (r && r.skipped && r.reason) {
      parts.push(`Lượt ship gần nhất bỏ qua: ${App.esc(r.reason)}`);
    }
    // Cảnh báo: bật báo ship nhưng runner (Chrome) offline -> chưa gửi được, sẽ gửi bù khi runner mở lại.
    if (shipEnabled && runnerOnline === false) {
      parts.push('<span style="color:var(--danger,#d33)">⚠️ Local-runner (Chrome) offline — đơn báo ship sẽ tự gửi khi runner mở lại.</span>');
    }
    st.innerHTML = parts.join(' · ');
  }

  async function toggleAutoShip() {
    const next = !shipEnabled;
    if (next && !confirm('Bật TỰ ĐỘNG báo ship? Khi đơn đã "Đã báo hàng" và có nội dung báo ship, hệ thống sẽ tự nhắn khách NGAY (cần local-runner mở & đăng nhập Zalo).')) return;
    try {
      const a = await App.api('/api/auto-notify/ship-toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }),
      });
      renderAutoBadge(a); // đồng bộ lại cả badge ship (renderAutoBadge -> renderAutoShip)
      App.toast(next ? '✅ Đã bật tự động báo ship' : 'Đã tắt tự động báo ship');
    } catch (e) {
      App.toast(`❌ ${e.message}`, 5000);
    }
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
      runnerOnline = !!h.localRunner.online; // cho cảnh báo runner-offline ở mục báo ship
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
  { const sb = $('autoShipBadge'); if (sb) sb.addEventListener('click', toggleAutoShip); }
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
