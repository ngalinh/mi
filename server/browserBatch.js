'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const active = new AsyncLocalStorage();

function employeeKey(order, fallback = 'default') {
  const approver = (order.items || []).find((item) => item && String(item.approveUser || '').trim());
  if (order.userId != null) return `id:${order.userId}`;
  const name = order.staff || (approver && approver.approveUser);
  return name ? `name:${String(name).trim()}` : `profile:${order.profile || fallback}`;
}

function groupByEmployee(list, keyOf = employeeKey) {
  const groups = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].flat();
}

// Track actual profiles sent to, including fallback accounts and Facebook.
function sendOptions(payload) {
  const batch = active.getStore();
  if (batch) batch.profiles.add(payload.profile || 'default');
  return { ...payload, keepContext: !!batch, closeAfterSend: true };
}

async function withBrowserBatch(fn) {
  const batch = { profiles: new Set(), employee: undefined };
  const close = async () => {
    const errors = [];
    for (const profile of batch.profiles) {
      try {
        await require('./playwrightProxy').closeBrowserProfile(profile);
        batch.profiles.delete(profile);
      } catch (err) { errors.push(err); }
    }
    if (errors.length) throw new Error(`Không đóng được browser: ${errors.map(e => e.message).join('; ')}`);
  };
  batch.select = async (employee) => {
    if (batch.employee !== employee) await close();
    batch.employee = employee;
  };
  return active.run(batch, async () => {
    try { return await fn(batch); }
    finally { await close(); }
  });
}

module.exports = { employeeKey, groupByEmployee, sendOptions, withBrowserBatch };
