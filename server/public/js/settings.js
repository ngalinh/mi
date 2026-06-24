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

  // ---------------- Nhân viên (bản mẫu — chưa nối backend) ----------------
  const empRows = $('empRows');
  const em = $('empModal');
  const emTitle = $('emTitle');
  const emName = $('emName'), emUser = $('emUser'), emPass = $('emPass'), emRole = $('emRole'), emStatus = $('emStatus');
  let editing = null;

  function rolePillHtml(role) {
    if (role === 'Nhân viên') return '<span class="pill chua">Nhân viên</span>';
    const st = role === 'Quản lý' ? 'background:#eaf2fe; color:#2f6fd0;' : 'background:var(--primary-soft); color:var(--primary);';
    return `<span class="pill" style="${st}">${App.esc(role)}</span>`;
  }
  function statusBadgeHtml(status) {
    const cls = status === 'Tạm khoá' ? 'badge-offline' : 'badge-online';
    return `<span class="badge-status ${cls}" style="box-shadow:none; padding:5px 12px;">${App.esc(status)}</span>`;
  }
  function fillRow(tr, d) {
    tr.children[0].textContent = d.name;
    tr.children[1].textContent = d.user;
    tr.children[2].innerHTML = '<span class="pw">••••••••</span>';
    tr.children[3].innerHTML = rolePillHtml(d.role);
    tr.children[4].innerHTML = statusBadgeHtml(d.status);
  }
  function makeRow(d) {
    const tr = document.createElement('tr');
    tr.className = 'main-row';
    tr.innerHTML = '<td class="cust"></td><td></td><td></td><td></td><td class="center"></td><td><button class="link-btn">Sửa</button></td>';
    fillRow(tr, d);
    return tr;
  }
  function openEmp(tr) {
    editing = tr || null;
    if (tr) {
      emTitle.textContent = 'Sửa nhân viên';
      emName.value = tr.children[0].textContent.trim();
      emUser.value = tr.children[1].textContent.trim();
      emPass.value = '';
      emRole.value = tr.children[3].textContent.trim();
      emStatus.value = tr.children[4].textContent.trim();
    } else {
      emTitle.textContent = 'Thêm nhân viên';
      emName.value = ''; emUser.value = ''; emPass.value = '';
      emRole.value = 'Nhân viên'; emStatus.value = 'Hoạt động';
    }
    em.classList.add('show');
  }
  function closeEmp() { em.classList.remove('show'); }

  $('addEmpBtn').addEventListener('click', () => openEmp(null));
  empRows.addEventListener('click', (e) => {
    const b = e.target.closest('.link-btn'); if (!b) return;
    openEmp(b.closest('tr.main-row'));
  });
  $('emCancel').addEventListener('click', closeEmp);
  em.addEventListener('click', (e) => { if (e.target === em) closeEmp(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmp(); });
  $('emSave').addEventListener('click', () => {
    const d = { name: emName.value.trim() || 'Nhân viên mới', user: emUser.value.trim(), role: emRole.value, status: emStatus.value };
    if (editing) fillRow(editing, d);
    else empRows.appendChild(makeRow(d));
    closeEmp();
    App.toast('Đã lưu (bản mẫu — chưa đồng bộ hệ thống)');
  });

  // ---------------- Tài khoản Zalo (nối backend thật) ----------------
  const zaloRows = $('zaloRows');
  const zm = $('zaloModal');
  const zaKey = $('zaKey'), zaName = $('zaName'), zaSalework = $('zaSalework'),
    zaPhone = $('zaPhone'), zaStaffId = $('zaStaffId'), zaProxy = $('zaProxy'), zaAuto = $('zaAuto');
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
  function renderZalo(list) {
    if (!list || !list.length) {
      zaloRows.innerHTML = '<tr><td colspan="6" class="muted" style="padding:16px;">Chưa có tài khoản Zalo nào. Bấm “Thêm tài khoản”.</td></tr>';
      return;
    }
    zaloRows.innerHTML = list.map((a) => `
      <tr class="main-row" data-key="${App.esc(a.key)}">
        <td class="cust">${App.esc(a.name || a.key)}</td>
        <td>${App.esc(a.saleworkName || '')}</td>
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
      zaloRows.innerHTML = `<tr><td colspan="6" class="muted" style="padding:16px;">Không tải được danh sách (local-runner offline?): ${App.esc(e.message)}</td></tr>`;
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

  function renderAutoBadge(a) {
    autoEnabled = !!(a && a.enabled);
    const el = $('autoBadge');
    const every = Math.round(((a && a.intervalMs) || 0) / 1000);
    el.textContent = 'Tự động: ' + (autoEnabled ? `Bật (mỗi ${every}s)` : 'Tắt');
    el.className = 'badge-status badge-clickable ' + (autoEnabled ? 'badge-online' : 'badge-offline');
  }

  async function toggleAuto() {
    const next = !autoEnabled;
    if (next && !confirm('Bật TỰ ĐỘNG báo hàng? Hệ thống sẽ tự gửi tin cho mọi đơn "Chưa báo".')) return;
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

  async function loadHealth() {
    try {
      const h = await App.api('/api/health');
      const lb = $('localBadge');
      lb.textContent = 'Local-runner: ' + (h.localRunner.online ? 'online' : 'offline');
      lb.className = 'badge-status ' + (h.localRunner.online ? 'badge-online' : 'badge-offline');
      $('modeMockBadge').style.display = h.mock ? '' : 'none';
      $('modeLiveBadge').style.display = h.mock ? 'none' : '';
      if (h.autoNotify) renderAutoBadge(h.autoNotify);
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
  $('bassoBtn').addEventListener('click', pingBasso);

  loadHealth();
  setInterval(loadHealth, 15000);
})();
