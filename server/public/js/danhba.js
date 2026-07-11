// Trang Danh bạ Zalo: import từ file Excel/CSV (parse ngay trên trình duyệt bằng SheetJS) +
// quản lý (thêm/sửa/xoá) danh bạ SĐT -> tên hội thoại Zalo/FB. Server chỉ nhận danh sách đã
// ghép cột, lưu SQLite (bảng zalo_contacts) và dùng làm fallback khi runner tìm hội thoại.
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------------- State import ----------------
  let workbook = null;   // workbook SheetJS đã parse
  let sheetRows = [];    // mảng-của-mảng (array of arrays) của sheet đang chọn
  let contacts = [];     // danh bạ hiện có (từ server)
  let bassoStaff = [];   // NV Basso (user_id + name) cho dropdown "NV phụ trách"

  const els = {
    file: $('fileInput'), mapArea: $('mapArea'),
    sheetField: $('sheetField'), sheetSel: $('sheetSel'),
    colPhone: $('colPhone'), colName: $('colName'), colNote: $('colNote'),
    hasHeader: $('hasHeader'), importMode: $('importMode'),
    mapSummary: $('mapSummary'), previewRows: $('previewRows'),
    cancelImport: $('cancelImport'), doImport: $('doImport'),
    contactRows: $('contactRows'), contactCount: $('contactCount'),
    searchBox: $('searchBox'), addBtn: $('addContactBtn'),
    fbFilter: $('fbFilter'),
    nvToggle: $('nvToggle'), nvLabel: $('nvLabel'), nvPanel: $('nvPanel'),
  };

  // NV phụ trách được chọn để lọc (rỗng = tất cả nhân viên)
  const nvSelected = new Set();

  const staffName = (uid) => {
    if (uid == null || uid === '') return '';
    const f = bassoStaff.find((u) => String(u.user_id) === String(uid));
    return f ? f.name : `#${uid}`;
  };
  async function loadBassoStaff() {
    try {
      const r = await App.api('/api/tab-users');
      bassoStaff = (r && r.tabUsers) || [];
    } catch { bassoStaff = []; }
    const opts = bassoStaff.map((u) => `<option value="${App.esc(u.user_id)}">${App.esc(u.name)} (#${App.esc(u.user_id)})</option>`).join('');
    $('cmStaff').innerHTML = '<option value="">— Không gán —</option>' + opts;
    renderNvPanel();
  }

  // Dựng danh sách checkbox NV phụ trách (chọn nhiều) + dòng "Tất cả nhân viên" để bỏ chọn nhanh.
  function renderNvPanel() {
    const rows = bassoStaff.map((u) => {
      const id = String(u.user_id);
      const on = nvSelected.has(id) ? ' checked' : '';
      return `<label class="ms-opt"><input type="checkbox" value="${App.esc(id)}"${on}/><span>${App.esc(u.name)} (#${App.esc(id)})</span></label>`;
    }).join('');
    els.nvPanel.innerHTML = `<label class="ms-opt all"><input type="checkbox" value="__all__"${nvSelected.size ? '' : ' checked'}/><span>Tất cả nhân viên</span></label>${rows}`;
    updateNvLabel();
  }

  function updateNvLabel() {
    if (!nvSelected.size) { els.nvLabel.textContent = 'Tất cả nhân viên'; return; }
    if (nvSelected.size === 1) { els.nvLabel.textContent = staffName([...nvSelected][0]); return; }
    els.nvLabel.textContent = `${nvSelected.size} nhân viên`;
  }

  // ================= IMPORT =================
  els.file.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      workbook = XLSX.read(buf, { type: 'array' });
    } catch (err) {
      App.toast('Không đọc được file: ' + err.message);
      resetImport();
      return;
    }
    const names = workbook.SheetNames || [];
    if (!names.length) { App.toast('File không có trang tính nào'); resetImport(); return; }
    // Nhiều sheet -> cho chọn; 1 sheet -> ẩn.
    els.sheetField.style.display = names.length > 1 ? '' : 'none';
    els.sheetSel.innerHTML = names.map((n, i) => `<option value="${App.esc(n)}"${i === 0 ? ' selected' : ''}>${App.esc(n)}</option>`).join('');
    loadSheet(names[0]);
    els.mapArea.style.display = '';
  });

  els.sheetSel.addEventListener('change', () => loadSheet(els.sheetSel.value));
  [els.colPhone, els.colName, els.colNote, els.hasHeader].forEach((el) => el.addEventListener('change', renderPreview));

  function loadSheet(name) {
    const ws = workbook.Sheets[name];
    // header:1 -> mảng-của-mảng; defval:'' để ô trống không lệch cột; blankrows:false bỏ dòng rỗng.
    sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
    buildColumnSelectors();
    renderPreview();
  }

  // Số cột = cột nhiều nhất trong vài dòng đầu (phòng dòng đầu thiếu ô).
  function columnCount() {
    let n = 0;
    for (let i = 0; i < Math.min(sheetRows.length, 20); i += 1) {
      if (sheetRows[i] && sheetRows[i].length > n) n = sheetRows[i].length;
    }
    return n;
  }

  function buildColumnSelectors() {
    const header = sheetRows[0] || [];
    const n = columnCount();
    const labelFor = (i) => {
      const h = header[i];
      const letter = XLSX.utils.encode_col(i);
      return h != null && String(h).trim() !== '' ? `${letter} · ${String(h).trim()}` : `Cột ${letter}`;
    };
    const opts = (withNone) => {
      let out = withNone ? '<option value="-1">— Không dùng —</option>' : '';
      for (let i = 0; i < n; i += 1) out += `<option value="${i}">${App.esc(labelFor(i))}</option>`;
      return out;
    };
    els.colPhone.innerHTML = opts(false);
    els.colName.innerHTML = opts(false);
    els.colNote.innerHTML = opts(true);

    // Tự đoán cột theo tiêu đề, theo TỪNG TẦNG ưu tiên: duyệt hết tầng 1 trên mọi cột trước,
    // hết mới xuống tầng 2... Nhờ vậy cột "Tên Zalo/FB" luôn thắng cột "Tên khách" (tên Basso)
    // khi file có cả hai — đúng mục đích danh bạ (tên Zalo, KHÔNG phải tên Basso).
    const guessBy = (tiers) => {
      for (const keys of tiers) {
        for (let i = 0; i < n; i += 1) {
          const h = String(header[i] || '').toLowerCase();
          if (keys.some((k) => h.includes(k))) return i;
        }
      }
      return -1;
    };
    const gPhone = guessBy([['sđt', 'sdt', 'điện thoại', 'dien thoai', 'phone', 'số đt', 'so dt']]);
    const gName = guessBy([
      ['tên zalo', 'ten zalo', 'zalo', 'facebook', 'tên fb', 'ten fb'],  // ưu tiên tuyệt đối
      ['tên hội thoại', 'ten hoi thoai', 'hội thoại', 'hoi thoai', 'tên hiển thị', 'ten hien thi'],
      ['tên khách', 'ten khach', 'tên', 'ten', 'name', 'khách', 'khach'], // fallback cuối
    ]);
    const gNote = guessBy([['ghi chú', 'ghi chu', 'note', 'chú thích', 'chu thich']]);
    // Cột SĐT: đoán được thì dùng, không thì cột 0. Cột tên: tránh trùng cột SĐT.
    const phoneIdx = gPhone >= 0 ? gPhone : 0;
    let nameIdx = gName >= 0 ? gName : -1;
    if (nameIdx < 0 || nameIdx === phoneIdx) {
      nameIdx = -1;
      for (let i = 0; i < n; i += 1) { if (i !== phoneIdx) { nameIdx = i; break; } }
      if (nameIdx < 0) nameIdx = 0;
    }
    els.colPhone.value = String(phoneIdx);
    els.colName.value = String(nameIdx);
    els.colNote.value = String(gNote >= 0 && gNote !== phoneIdx && gNote !== nameIdx ? gNote : -1);
  }

  // Chuẩn hoá SĐT giống server (bỏ ký tự thừa + tiền tố 84/0) để đếm hợp lệ/xem trước cho khớp.
  function normPhone(v) {
    return String(v == null ? '' : v).replace(/\D/g, '').replace(/^84/, '').replace(/^0/, '');
  }

  // Trả danh sách { phone, zalo_name, note } đã ghép từ cột chọn (bỏ dòng thiếu SĐT/tên).
  function mappedRows() {
    const pi = parseInt(els.colPhone.value, 10);
    const ni = parseInt(els.colName.value, 10);
    const oi = parseInt(els.colNote.value, 10);
    const start = els.hasHeader.value === '1' ? 1 : 0;
    const out = [];
    let skipped = 0;
    for (let r = start; r < sheetRows.length; r += 1) {
      const row = sheetRows[r] || [];
      const rawPhone = row[pi];
      const name = String(row[ni] == null ? '' : row[ni]).trim();
      const note = oi >= 0 ? String(row[oi] == null ? '' : row[oi]).trim() : '';
      if (!normPhone(rawPhone) || !name) { skipped += 1; continue; }
      out.push({ phone: String(rawPhone).trim(), zalo_name: name, note });
    }
    return { rows: out, skipped };
  }

  function renderPreview() {
    if (!sheetRows.length) { els.previewRows.innerHTML = ''; els.mapSummary.textContent = ''; return; }
    const { rows, skipped } = mappedRows();
    els.mapSummary.innerHTML = `Đọc được <strong>${rows.length}</strong> liên hệ hợp lệ`
      + (skipped ? ` · bỏ qua <strong>${skipped}</strong> dòng thiếu SĐT hoặc tên` : '')
      + '. Xem trước 5 dòng đầu:';
    const preview = rows.slice(0, 5);
    els.previewRows.innerHTML = preview.length
      ? preview.map((r, i) => `<tr><td>${i + 1}</td><td>${App.esc(r.phone)}</td><td>${App.esc(r.zalo_name)}</td><td>${App.esc(r.note || '')}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted" style="padding:12px;">Chưa ghép được dòng nào — kiểm tra lại cột SĐT / Tên.</td></tr>';
    els.doImport.disabled = rows.length === 0;
  }

  els.cancelImport.addEventListener('click', resetImport);

  function resetImport() {
    workbook = null; sheetRows = [];
    els.file.value = '';
    els.mapArea.style.display = 'none';
    els.previewRows.innerHTML = '';
    els.mapSummary.textContent = '';
  }

  els.doImport.addEventListener('click', async () => {
    const { rows } = mappedRows();
    if (!rows.length) { App.toast('Không có liên hệ hợp lệ để nhập'); return; }
    const mode = els.importMode.value === 'replace' ? 'replace' : 'merge';
    if (mode === 'replace' && !confirm(`Thay TOÀN BỘ danh bạ hiện có bằng ${rows.length} liên hệ trong file?\nDanh bạ cũ sẽ bị xoá.`)) return;
    els.doImport.disabled = true;
    els.doImport.textContent = 'Đang nhập…';
    try {
      const r = await App.api('/api/zalo-contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, mode }),
      });
      App.toast(`Đã nhập: ${r.added} mới, ${r.updated} cập nhật${r.skipped ? `, ${r.skipped} bỏ qua` : ''}`);
      resetImport();
      await loadContacts();
    } catch (e) {
      App.toast('Lỗi nhập: ' + e.message);
    } finally {
      els.doImport.disabled = false;
      els.doImport.textContent = 'Nhập vào danh bạ';
    }
  });

  // ================= DANH BẠ HIỆN CÓ =================
  const SOURCE_LABEL = { import: 'File', manual: 'Nhập tay', basso: 'Basso', learned: 'Tự học' };

  // 1 ô "Báo qua FB": pill bật/tắt (bấm để đổi) + link/cảnh báo NẰM CẠNH (cùng hàng) khi đang bật.
  function fbCell(c) {
    const on = !!c.fb_report;
    const pill = on
      ? '<span class="pill da fb-toggle" data-action="fbtoggle" title="Đang báo qua Facebook — bấm để tắt">Bật</span>'
      : '<span class="pill chua fb-toggle" data-action="fbtoggle" title="Đang báo qua Zalo — bấm để bật FB">Tắt</span>';
    if (!on) return `<div class="fb-cell">${pill}</div>`;
    const link = String(c.fb_link || '').trim();
    const sub = link
      ? `<a class="fb-link" href="${App.esc(link)}" target="_blank" rel="noopener noreferrer" title="${App.esc(link)}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Xem link</a>`
      : '<span class="fb-warn"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>chưa có link</span>';
    return `<div class="fb-cell">${pill}${sub}</div>`;
  }

  // 1 ô "Kiểu báo Zalo": select ngoại lệ cho từng khách — ghi đè kiểu báo (cá nhân/nhóm) của NV.
  // Rỗng = theo NV. Khách báo qua FB không có tab cá nhân/nhóm nên hiện "—".
  function rtCell(c) {
    if (c.fb_report) return '<span class="muted" title="Báo qua Facebook không dùng tab cá nhân/nhóm">—</span>';
    const v = c.report_target === 'personal' ? 'personal' : c.report_target === 'group' ? 'group' : '';
    return `<select class="note-input rt-sel" data-action="rtset" title="Kiểu báo riêng cho khách này (ghi đè NV)" style="max-width:130px;padding:5px 8px;font-size:13px;">
      <option value=""${v === '' ? ' selected' : ''}>Theo NV</option>
      <option value="personal"${v === 'personal' ? ' selected' : ''}>Cá nhân</option>
      <option value="group"${v === 'group' ? ' selected' : ''}>Nhóm</option>
    </select>`;
  }

  function renderContacts() {
    const q = (els.searchBox.value || '').trim().toLowerCase();
    const fbMode = els.fbFilter.value || 'all';
    const list = contacts.filter((c) => {
      if (fbMode === 'fb' && !c.fb_report) return false;
      if (fbMode === 'nofb' && c.fb_report) return false;
      if (nvSelected.size && !nvSelected.has(String(c.staff_id || ''))) return false;
      if (q) {
        return (c.zalo_name || '').toLowerCase().includes(q)
          || (c.raw_phone || c.phone || '').toLowerCase().includes(q)
          || (c.phone || '').includes(q.replace(/\D/g, ''));
      }
      return true;
    });
    els.contactCount.textContent = contacts.length;
    if (!list.length) {
      els.contactRows.innerHTML = `<tr><td colspan="9" class="muted" style="padding:16px;">${contacts.length ? 'Không có liên hệ khớp bộ lọc.' : 'Chưa có liên hệ nào — nhập từ file hoặc thêm thủ công.'}</td></tr>`;
      return;
    }
    els.contactRows.innerHTML = list.map((c) => `
      <tr data-phone="${App.esc(c.phone)}">
        <td>${App.esc(c.raw_phone || c.phone)}</td>
        <td class="cust">${App.esc(c.zalo_name || '—')}</td>
        <td class="center">${fbCell(c)}</td>
        <td class="center">${rtCell(c)}</td>
        <td>${c.staff_id ? App.esc(staffName(c.staff_id)) : '<span class="muted">—</span>'}</td>
        <td>${App.esc(c.note || '')}</td>
        <td class="center"><span class="pill chua">${App.esc(SOURCE_LABEL[c.source] || c.source || '—')}</span></td>
        <td class="muted" style="font-size:12px;">${App.esc(App.fmtDateTime(c.updated_at))}</td>
        <td>
          <button class="link-btn act-edit" title="Sửa">Sửa</button>
          <button class="link-btn act-del" title="Xoá" style="color:var(--danger,#d33)">Xoá</button>
        </td>
      </tr>`).join('');
  }

  els.searchBox.addEventListener('input', renderContacts);
  els.fbFilter.addEventListener('change', renderContacts);

  // Mở/đóng panel chọn nhiều NV
  const nvBox = $('nvFilter');
  function toggleNv(open) {
    const willOpen = open != null ? open : els.nvPanel.hidden;
    els.nvPanel.hidden = !willOpen;
    nvBox.classList.toggle('open', willOpen);
    els.nvToggle.setAttribute('aria-expanded', String(willOpen));
  }
  els.nvToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleNv(); });
  els.nvPanel.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    if (cb.value === '__all__') {
      nvSelected.clear();
    } else if (cb.checked) {
      nvSelected.add(cb.value);
    } else {
      nvSelected.delete(cb.value);
    }
    renderNvPanel();
    renderContacts();
  });
  document.addEventListener('click', (e) => {
    if (!els.nvPanel.hidden && !nvBox.contains(e.target)) toggleNv(false);
  });

  // Đổi "Kiểu báo Zalo" ngay trên hàng (select ngoại lệ) -> lưu report_target cho riêng khách này.
  els.contactRows.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-action="rtset"]');
    if (!sel) return;
    const tr = e.target.closest('tr[data-phone]');
    const c = tr && contacts.find((x) => x.phone === tr.dataset.phone);
    if (!c) return;
    const val = sel.value === 'personal' ? 'personal' : sel.value === 'group' ? 'group' : '';
    try {
      await App.api('/api/zalo-contacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: c.raw_phone || c.phone, report_target: val }),
      });
      App.toast(val === 'personal' ? '✅ Khách này: báo CÁ NHÂN' : val === 'group' ? '✅ Khách này: báo NHÓM' : 'Đã bỏ ngoại lệ — theo kiểu báo của NV');
      await loadContacts();
    } catch (err) { App.toast('Lỗi: ' + err.message); }
  });

  els.contactRows.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-phone]');
    if (!tr) return;
    const phone = tr.dataset.phone;
    const c = contacts.find((x) => x.phone === phone);
    if (e.target.closest('[data-action="fbtoggle"]') && c) {
      const next = c.fb_report ? 0 : 1;
      try {
        await App.api('/api/zalo-contacts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: c.raw_phone || c.phone, fb_report: next }),
        });
        App.toast(next
          ? (c.fb_link ? '✅ Đã bật báo qua Facebook' : '✅ Đã bật FB — nhớ thêm link để bot mở đúng hội thoại')
          : 'Đã tắt — khách này báo qua Zalo');
        await loadContacts();
      } catch (err) { App.toast('Lỗi: ' + err.message); }
      return;
    }
    if (e.target.closest('.act-edit')) { openModal(c); return; }
    if (e.target.closest('.act-del')) {
      if (!confirm(`Xoá liên hệ "${c ? c.zalo_name : phone}"?`)) return;
      try {
        await App.api('/api/zalo-contacts/' + encodeURIComponent(phone), { method: 'DELETE' });
        App.toast('Đã xoá');
        await loadContacts();
      } catch (err) { App.toast('Lỗi xoá: ' + err.message); }
    }
  });

  async function loadContacts() {
    try {
      const r = await App.api('/api/zalo-contacts');
      contacts = r.contacts || [];
    } catch (e) {
      contacts = [];
      App.toast('Không tải được danh bạ: ' + e.message);
    }
    renderContacts();
  }

  // ================= MODAL THÊM / SỬA =================
  const modal = $('contactModal');
  const cmTitle = $('cmTitle'), cmPhone = $('cmPhone'), cmName = $('cmName'), cmNote = $('cmNote');
  const cmFbReport = $('cmFbReport'), cmFbLink = $('cmFbLink'), cmFbLinkField = $('cmFbLinkField'), cmStaff = $('cmStaff');
  const cmReportTarget = $('cmReportTarget');
  let editingPhone = null; // SĐT (đã chuẩn hoá) đang sửa; null = thêm mới

  // Ô Link luôn hiển thị để dễ thấy; chỉ khoá mờ + đổi gợi ý khi đang Tắt (báo qua Zalo).
  function syncFbLinkField() {
    const on = cmFbReport.value === '1';
    cmFbLink.disabled = !on;
    cmFbLinkField.style.opacity = on ? '' : '0.55';
    cmFbLink.placeholder = on
      ? 'facebook.com/… , m.me/… hoặc messages/t/…'
      : 'Bật "Báo qua Facebook" để nhập link';
  }
  cmFbReport.addEventListener('change', syncFbLinkField);

  function openModal(c) {
    editingPhone = c ? c.phone : null;
    cmTitle.textContent = c ? 'Sửa liên hệ' : 'Thêm liên hệ';
    cmPhone.value = c ? (c.raw_phone || c.phone) : '';
    cmName.value = c ? (c.zalo_name || '') : '';
    cmNote.value = c ? (c.note || '') : '';
    cmFbReport.value = c && c.fb_report ? '1' : '0';
    cmFbLink.value = c ? (c.fb_link || '') : '';
    cmStaff.value = c && c.staff_id != null ? String(c.staff_id) : '';
    cmReportTarget.value = c && (c.report_target === 'personal' || c.report_target === 'group') ? c.report_target : '';
    syncFbLinkField();
    modal.classList.add('show');
    setTimeout(() => (c ? cmName : cmPhone).focus(), 30);
  }
  function closeModal() { modal.classList.remove('show'); editingPhone = null; }

  els.addBtn.addEventListener('click', () => openModal(null));
  $('cmCancel').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  $('cmSave').addEventListener('click', async () => {
    const phone = cmPhone.value.trim();
    const name = cmName.value.trim();
    const fbReport = cmFbReport.value === '1' ? 1 : 0;
    const fbLink = cmFbLink.value.trim();
    if (!phone.replace(/\D/g, '')) { App.toast('Nhập SĐT hợp lệ'); return; }
    // Khách chỉ báo qua FB thì cần link thay cho tên; còn lại vẫn cần tên Zalo/FB.
    if (!name && !(fbReport && fbLink)) { App.toast('Nhập tên Zalo/FB, hoặc bật báo qua FB kèm link'); return; }
    if (fbReport && !fbLink && !confirm('Bật báo qua Facebook nhưng chưa có link — bot sẽ không mở được hội thoại. Vẫn lưu?')) return;
    try {
      // Sửa mà đổi SĐT -> xoá bản ghi cũ (khoá theo SĐT) rồi ghi bản mới.
      if (editingPhone && normPhone(phone) !== editingPhone) {
        await App.api('/api/zalo-contacts/' + encodeURIComponent(editingPhone), { method: 'DELETE' });
      }
      await App.api('/api/zalo-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone, zalo_name: name, note: cmNote.value.trim(),
          fb_report: fbReport, fb_link: fbLink, staff_id: cmStaff.value || '',
          report_target: cmReportTarget.value || '',
        }),
      });
      App.toast('Đã lưu');
      closeModal();
      await loadContacts();
    } catch (e) { App.toast('Lỗi lưu: ' + e.message); }
  });

  // ================= INIT =================
  loadBassoStaff().then(loadContacts); // nạp NV trước để hiển thị đúng tên "NV phụ trách"
})();
