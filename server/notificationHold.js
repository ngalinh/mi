'use strict';
const { getSetting, setSetting, getReportById, updateReport, markShippingNotified, recordAutoNotified } = require('./db');
const isUncertain = error => /^(?:NEEDS_CHECK|KHONG_XAC_NHAN_DA_GUI):/.test(String(error || ''));
function getHold(key) { return getSetting(`notification-hold:${key}`); }
function hold(key, error, reportId) {
  setSetting(`notification-hold:${key}`, error);
  if (reportId != null) setSetting(`notification-hold-report:${reportId}`, key);
}

// Human confirmation only: never infer delivery from a timeout or empty composer.
function resolveHold(reportId, decision, actor) {
  if (!['sent', 'not_sent'].includes(decision)) throw new Error('Chọn sent hoặc not_sent sau khi kiểm tra hội thoại.');
  const key = getSetting(`notification-hold-report:${reportId}`);
  const report = getReportById(reportId);
  if (!key || !getHold(key) || report?.status !== 'needs_check') throw new Error('Không có lượt gửi cần kiểm tra này.');
  if (decision === 'sent') {
    if (key.startsWith('shipping:')) markShippingNotified(key.slice('shipping:'.length), report.phone);
    else recordAutoNotified(key, 'manual', 0);
  }
  updateReport(reportId, { status: decision === 'sent' ? 'success' : 'failed',
    error: `Đã kiểm tra thủ công (${actor || 'Admin'}): ${decision === 'sent' ? 'khách đã nhận tin' : 'chưa gửi; có thể báo lại'}.` });
  setSetting(`notification-hold:${key}`, null);
  setSetting(`notification-hold-report:${reportId}`, null);
  return { ok: true };
}
module.exports = { isUncertain, getHold, hold, resolveHold };
