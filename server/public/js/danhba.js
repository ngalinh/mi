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
    fbFilter: $('fbFilter'), nvFilter: $('nvFilter'),
  };

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
    els.nvFilter.innerHTML = '<option value="">Mọi NV phụ trách</option>' + opts;
    $('cmStaff').innerHTML = '<option value="">— Không gán —</option>' + opts;
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

  // 1 ô "Báo qua FB": pill bật/tắt (bấm để đổi) + link/cảnh báo thiếu link khi đang bật.
  function fbCell(c) {
    const on = !!c.fb_report;
    const pill = on
      ? '<span class="pill da" data-action="fbtoggle" style="cursor:pointer" title="Đang báo qua Facebook — bấm để tắt">Bật</span>'
      : '<span class="pill chua" data-action="fbtoggle" style="cursor:pointer" title="Đang báo qua Zalo — bấm để bật FB">Tắt</span>';
    if (!on) return pill;
    const link = String(c.fb_link || '').trim();
    const sub = link
      ? `<div class="muted" style="font-size:11px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${App.esc(link)}">${App.esc(link)}</div>`
      : '<div style="font-size:11px; color:var(--red);">⚠ chưa có link</div>';
    return `${pill}${sub}`;
  }

  function renderContacts() {
    const q = (els.searchBox.value || '').trim().toLowerCase();
    const fbMode = els.fbFilter.value || 'all';
    const nv = els.nvFilter.value || '';
    const list = contacts.filter((c) => {
      if (fbMode === 'fb' && !c.fb_report) return false;
      if (fbMode === 'nofb' && c.fb_report) return false;
      if (nv && String(c.staff_id || '') !== String(nv)) return false;
      if (q) {
        return (c.zalo_name || '').toLowerCase().includes(q)
          || (c.raw_phone || c.phone || '').toLowerCase().includes(q)
          || (c.phone || '').includes(q.replace(/\D/g, ''));
      }
      return true;
    });
    els.contactCount.textContent = contacts.length;
    if (!list.length) {
      els.contactRows.innerHTML = `<tr><td colspan="8" class="muted" style="padding:16px;">${contacts.length ? 'Không có liên hệ khớp bộ lọc.' : 'Chưa có liên hệ nào — nhập từ file hoặc thêm thủ công.'}</td></tr>`;
      return;
    }
    els.contactRows.innerHTML = list.map((c) => `
      <tr data-phone="${App.esc(c.phone)}">
        <td>${App.esc(c.raw_phone || c.phone)}</td>
        <td class="cust">${App.esc(c.zalo_name || '—')}</td>
        <td class="center">${fbCell(c)}</td>
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
  els.nvFilter.addEventListener('change', renderContacts);

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
  let editingPhone = null; // SĐT (đã chuẩn hoá) đang sửa; null = thêm mới

  // Chỉ hiện ô Link khi đang bật "báo qua Facebook".
  function syncFbLinkField() { cmFbLinkField.style.display = cmFbReport.value === '1' ? '' : 'none'; }
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
