// Trang MyJoy: chat với trợ lý AI + nút Share tạo link công khai cho từng hội thoại.
(function () {
  const listEl = document.getElementById('convList');
  const msgsEl = document.getElementById('msgs');
  const titleEl = document.getElementById('chatTitle');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const shareBtn = document.getElementById('shareBtn');
  const shareNote = document.getElementById('shareNote');
  const newBtn = document.getElementById('newConvBtn');

  let conversations = [];
  let current = null;   // {id, title, share_token, ...}
  let sending = false;

  function setComposeEnabled(on) {
    inputEl.disabled = !on;
    sendBtn.disabled = !on;
  }

  async function loadConversations() {
    try {
      const r = await App.api('/api/myjoy/conversations');
      conversations = r.conversations || [];
      renderList();
    } catch (e) {
      listEl.innerHTML = `<div class="mj-empty-list">${App.esc(e.message)}</div>`;
    }
  }

  function renderList() {
    if (!conversations.length) {
      listEl.innerHTML = '<div class="mj-empty-list">Chưa có cuộc trò chuyện nào.</div>';
      return;
    }
    listEl.innerHTML = conversations.map((c) => `
      <div class="mj-conv ${current && c.id === current.id ? 'active' : ''}" data-id="${c.id}">
        <span class="t" title="${App.esc(c.title)}">${App.esc(c.title)}</span>
        <span class="del" data-del="${c.id}" title="Xoá">&times;</span>
      </div>`).join('');
    listEl.querySelectorAll('.mj-conv').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.hasAttribute('data-del')) return;
        openConversation(el.getAttribute('data-id'));
      });
    });
    listEl.querySelectorAll('[data-del]').forEach((el) => {
      el.addEventListener('click', (ev) => { ev.stopPropagation(); deleteConversation(el.getAttribute('data-del')); });
    });
  }

  function renderMessages(messages) {
    if (!messages || !messages.length) {
      msgsEl.innerHTML = '<div class="mj-hint">Hãy gửi tin nhắn đầu tiên cho MyJoy.</div>';
      return;
    }
    msgsEl.innerHTML = messages.map((m) => `
      <div class="mj-row ${m.role === 'user' ? 'user' : 'assistant'}">
        <div class="mj-bubble">${App.esc(m.content)}</div>
      </div>`).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function appendBubble(role, content) {
    const hint = msgsEl.querySelector('.mj-hint');
    if (hint) hint.remove();
    const row = document.createElement('div');
    row.className = `mj-row ${role === 'user' ? 'user' : 'assistant'}`;
    row.innerHTML = `<div class="mj-bubble">${App.esc(content)}</div>`;
    msgsEl.appendChild(row);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return row.querySelector('.mj-bubble');
  }

  function renderShare() {
    if (!current) { shareBtn.style.display = 'none'; shareNote.style.display = 'none'; return; }
    shareBtn.style.display = '';
    const shared = !!current.share_token;
    shareBtn.classList.toggle('accent', shared);
    shareBtn.classList.toggle('secondary', !shared);
    if (shared) {
      const base = window.location.href.replace(/[^/]*$/, '');
      const url = base + 'share.html?t=' + current.share_token;
      shareNote.style.display = '';
      shareNote.innerHTML = `Đang chia sẻ — ai có link đều đọc được: <a href="${App.esc(url)}" target="_blank">${App.esc(url)}</a>
        &nbsp;<a href="#" id="copyLink">Sao chép</a>`;
      const cp = document.getElementById('copyLink');
      if (cp) cp.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(url).then(() => App.toast('Đã sao chép link'), () => App.toast('Không sao chép được'));
      });
    } else {
      shareNote.style.display = 'none';
    }
  }

  async function openConversation(id) {
    try {
      const r = await App.api('/api/myjoy/conversations/' + id);
      current = r.conversation;
      titleEl.textContent = current.title;
      renderMessages(r.messages);
      renderList();
      renderShare();
      setComposeEnabled(true);
      inputEl.focus();
    } catch (e) {
      App.toast(e.message);
    }
  }

  async function createConversation() {
    try {
      const r = await App.api('/api/myjoy/conversations', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      conversations.unshift({ ...r.conversation, messageCount: 0 });
      await openConversation(r.conversation.id);
    } catch (e) {
      App.toast(e.message);
    }
  }

  async function deleteConversation(id) {
    if (!confirm('Xoá cuộc trò chuyện này?')) return;
    try {
      await App.api('/api/myjoy/conversations/' + id, { method: 'DELETE' });
      conversations = conversations.filter((c) => c.id !== id);
      if (current && current.id === id) {
        current = null;
        titleEl.textContent = 'MyJoy';
        msgsEl.innerHTML = '<div class="mj-hint">Chọn hoặc tạo một cuộc trò chuyện để bắt đầu.</div>';
        setComposeEnabled(false);
        renderShare();
      }
      renderList();
    } catch (e) {
      App.toast(e.message);
    }
  }

  async function send() {
    if (sending || !current) return;
    const text = inputEl.value.trim();
    if (!text) return;
    sending = true;
    setComposeEnabled(false);
    inputEl.value = '';
    appendBubble('user', text);
    const pending = appendBubble('assistant', 'MyJoy đang trả lời...');
    try {
      const r = await App.api('/api/myjoy/conversations/' + current.id + '/message', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }),
      });
      pending.textContent = r.reply.content;
      if (r.conversation) {
        current = r.conversation;
        titleEl.textContent = current.title;
        // Cập nhật tiêu đề trong danh sách.
        const item = conversations.find((c) => c.id === current.id);
        if (item) item.title = current.title;
        renderList();
      }
    } catch (e) {
      pending.textContent = '⚠️ ' + e.message;
    } finally {
      sending = false;
      setComposeEnabled(true);
      inputEl.focus();
    }
  }

  async function toggleShare() {
    if (!current) return;
    const enable = !current.share_token;
    try {
      const r = await App.api('/api/myjoy/conversations/' + current.id + '/share', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: enable }),
      });
      current.share_token = r.token || null;
      renderShare();
      App.toast(enable ? 'Đã bật chia sẻ' : 'Đã tắt chia sẻ');
    } catch (e) {
      App.toast(e.message);
    }
  }

  // Auto-grow textarea + Enter để gửi (Shift+Enter xuống dòng).
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  newBtn.addEventListener('click', createConversation);
  shareBtn.addEventListener('click', toggleShare);

  loadConversations();
})();
