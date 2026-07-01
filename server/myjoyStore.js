'use strict';
// Lưu hội thoại "MyJoy" (chat của nhân viên với trợ lý AI) + cơ chế chia sẻ công khai qua
// link. Dùng chung handle SQLite với db.js (cùng file doraemi.sqlite, ổ bền theo DATA_DIR).
const crypto = require('crypto');
const { db } = require('./db');

db.exec(`  -- Mỗi hàng = 1 cuộc trò chuyện của nhân viên với MyJoy.
  -- owner = email nhân viên (gateway forward); có thể trống khi chạy dev/không gateway.
  -- share_token != null nghĩa là đã bật chia sẻ: ai có link /share.html?t=<token> đều đọc được.
  CREATE TABLE IF NOT EXISTS myjoy_conversations (
    id           TEXT PRIMARY KEY,        -- id ngẫu nhiên (hex)
    owner        TEXT,                    -- email chủ hội thoại (nullable)
    title        TEXT NOT NULL,
    share_token  TEXT UNIQUE,             -- null = chưa chia sẻ
    created_at   TEXT NOT NULL,           -- ISO string
    updated_at   TEXT NOT NULL            -- ISO string
  );
  CREATE INDEX IF NOT EXISTS idx_myjoy_conv_owner ON myjoy_conversations(owner);
  CREATE INDEX IF NOT EXISTS idx_myjoy_conv_share ON myjoy_conversations(share_token);

  -- Tin nhắn trong 1 hội thoại. role = 'user' (nhân viên) | 'assistant' (MyJoy).
  CREATE TABLE IF NOT EXISTS myjoy_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL          -- ISO string
  );
  CREATE INDEX IF NOT EXISTS idx_myjoy_msg_conv ON myjoy_messages(conversation_id);
`);

const insConvStmt = db.prepare(`
  INSERT INTO myjoy_conversations (id, owner, title, share_token, created_at, updated_at)
  VALUES (@id, @owner, @title, NULL, @now, @now)
`);
const getConvStmt = db.prepare('SELECT * FROM myjoy_conversations WHERE id = @id');
const getConvByTokenStmt = db.prepare('SELECT * FROM myjoy_conversations WHERE share_token = @token');
const listConvStmt = db.prepare(
  'SELECT * FROM myjoy_conversations WHERE owner IS @owner ORDER BY updated_at DESC LIMIT @limit',
);
const touchConvStmt = db.prepare('UPDATE myjoy_conversations SET updated_at = @now WHERE id = @id');
const renameConvStmt = db.prepare('UPDATE myjoy_conversations SET title = @title, updated_at = @now WHERE id = @id');
const shareConvStmt = db.prepare('UPDATE myjoy_conversations SET share_token = @token, updated_at = @now WHERE id = @id');
const delConvStmt = db.prepare('DELETE FROM myjoy_conversations WHERE id = @id');
const delMsgsStmt = db.prepare('DELETE FROM myjoy_messages WHERE conversation_id = @id');

const insMsgStmt = db.prepare(`
  INSERT INTO myjoy_messages (conversation_id, role, content, created_at)
  VALUES (@conversation_id, @role, @content, @now)
`);
const listMsgStmt = db.prepare('SELECT * FROM myjoy_messages WHERE conversation_id = @id ORDER BY id ASC');
const countMsgStmt = db.prepare('SELECT COUNT(*) AS n FROM myjoy_messages WHERE conversation_id = @id');

/** Chuẩn hoá owner về khoá ổn định. Trống -> null (nhóm dùng chung khi không có gateway). */
function normOwner(owner) {
  const s = String(owner || '').trim().toLowerCase();
  return s || null;
}

/** Tạo hội thoại mới, trả về bản ghi. */
function createConversation(owner, title) {
  const now = new Date().toISOString();
  const id = crypto.randomBytes(12).toString('hex');
  insConvStmt.run({ id, owner: normOwner(owner), title: String(title || 'Cuộc trò chuyện mới').slice(0, 200), now });
  return getConvStmt.get({ id });
}

/** Danh sách hội thoại của 1 chủ (kèm số tin nhắn). */
function listConversations(owner, limit = 100) {
  return listConvStmt.all({ owner: normOwner(owner), limit: Math.min(limit, 500) })
    .map((c) => ({ ...c, messageCount: countMsgStmt.get({ id: c.id }).n || 0 }));
}

function getConversation(id) {
  return getConvStmt.get({ id }) || null;
}

function getMessages(conversationId) {
  return listMsgStmt.all({ id: conversationId });
}

/** Ghi 1 tin nhắn + cập nhật updated_at của hội thoại. Trả về bản ghi tin nhắn. */
function addMessage(conversationId, role, content) {
  const now = new Date().toISOString();
  const info = insMsgStmt.run({ conversation_id: conversationId, role, content: String(content ?? ''), now });
  touchConvStmt.run({ id: conversationId, now });
  return { id: info.lastInsertRowid, conversation_id: conversationId, role, content, created_at: now };
}

function renameConversation(id, title) {
  renameConvStmt.run({ id, title: String(title || '').slice(0, 200), now: new Date().toISOString() });
  return getConvStmt.get({ id });
}

/**
 * Bật/tắt chia sẻ công khai. enabled=true -> sinh token nếu chưa có; false -> xoá token.
 * Trả về token hiện tại ('' nếu tắt).
 */
function setShared(id, enabled) {
  const cur = getConvStmt.get({ id });
  if (!cur) return null;
  let token = cur.share_token;
  if (enabled) {
    if (!token) token = crypto.randomBytes(16).toString('hex');
  } else {
    token = null;
  }
  shareConvStmt.run({ id, token, now: new Date().toISOString() });
  return token || '';
}

/** Lấy hội thoại theo token chia sẻ (chỉ khi đã bật chia sẻ). null nếu không thấy. */
function getByShareToken(token) {
  if (!token) return null;
  return getConvByTokenStmt.get({ token }) || null;
}

/** Xoá hội thoại + toàn bộ tin nhắn. Trả true nếu có xoá. */
function deleteConversation(id) {
  delMsgsStmt.run({ id });
  return delConvStmt.run({ id }).changes > 0;
}

module.exports = {
  createConversation, listConversations, getConversation, getMessages, addMessage,
  renameConversation, setShared, getByShareToken, deleteConversation,
};
