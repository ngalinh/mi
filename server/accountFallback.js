'use strict';

// These errors are emitted before sending. Never match substrings: NEEDS_CHECK
// may contain one of these codes after a partially completed send.
function canTryNextAccount(error, channel = 'zalo') {
  const value = String(error || '').trim();
  return /^(?:CHUA_DANG_NHAP|ACCOUNT_UNAVAILABLE):/.test(value)
    || (channel === 'zalo' && /^KHONG_THAY_HOI_THOAI(?:\s|:|$)/.test(value))
    || (channel === 'facebook' && /^FB:/.test(value));
}

async function sendFacebookWithFallback(send, resolved, payload) {
  const candidates = resolved.source === 'explicit' ? [resolved]
    : [resolved, ...(resolved.fallbackAccounts || [])];
  const seen = new Set();
  let result;
  let lastCandidate;
  const finish = () => {
    if (lastCandidate) {
      resolved.profile = lastCandidate.profile;
      resolved.account = lastCandidate.account;
    }
    return result || { ok: false, error: 'Không có tài khoản Facebook phù hợp.' };
  };
  for (const candidate of candidates) {
    if (candidate.channel !== 'facebook' || seen.has(candidate.profile)) continue;
    seen.add(candidate.profile);
    try {
      result = await send({ ...payload, profile: candidate.profile || 'default' });
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (result.deferred || result.stopped) return result;
    lastCandidate = candidate;
    if (result.ok || !canTryNextAccount(result.error, 'facebook')) return finish();
  }
  return finish();
}

module.exports = { canTryNextAccount, sendFacebookWithFallback };
