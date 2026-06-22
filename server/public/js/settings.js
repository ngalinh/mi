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
