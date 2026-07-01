'use strict';
// Gọi Claude API để MyJoy trả lời. Thiếu ANTHROPIC_API_KEY -> trả câu nhắc cấu hình thay vì
// gọi API (để tính năng vẫn chạy được khi chưa có key). Dùng node-fetch v2 (đã có sẵn).
const fetch = require('node-fetch');
const config = require('./config');

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Hỏi MyJoy với toàn bộ lịch sử hội thoại.
 * @param {{role:'user'|'assistant', content:string}[]} history
 * @returns {Promise<string>} nội dung trả lời của trợ lý
 */
async function askMyJoy(history) {
  const messages = (history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content) }));

  if (!messages.length) return 'Bạn muốn hỏi MyJoy điều gì?';

  if (!config.myjoy.apiKey) {
    return 'MyJoy chưa được cấu hình khoá API (ANTHROPIC_API_KEY). Hãy đặt biến môi trường '
      + 'ANTHROPIC_API_KEY trên server để MyJoy trả lời. Trong lúc chờ, tin nhắn của bạn vẫn '
      + 'được lưu lại và có thể chia sẻ qua link.';
  }

  const res = await fetch(`${config.myjoy.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.myjoy.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: config.myjoy.model,
      max_tokens: config.myjoy.maxTokens,
      system: config.myjoy.system,
      messages,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(`MyJoy gọi API lỗi: ${detail}`);
  }

  // content là mảng block; ghép các block text lại.
  const text = Array.isArray(data && data.content)
    ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim()
    : '';
  return text || 'MyJoy chưa có câu trả lời.';
}

module.exports = { askMyJoy };
