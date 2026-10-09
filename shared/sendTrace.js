'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const scope = new AsyncLocalStorage();
const file = path.resolve(process.env.SEND_TRACE_FILE || path.join(__dirname, '..', 'data', `send-trace-${process.pid}.log`));
let warned = false;

// No message body, cookies, credentials or full destination URL in diagnostics.
function messageMeta(message) {
  const text = String(message || '');
  return { messageLength: text.length, messageHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) };
}
function log(event, details = {}) {
  try {
    const entry = { time: new Date().toISOString(), ...scope.getStore(), ...details, event };
    const line = `[send-trace] ${JSON.stringify(entry)}`;
    console.log(line);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size >= 5 * 1024 * 1024) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch (err) {
      if (!warned) { warned = true; console.warn('[send-trace] cannot persist diagnostics:', err.message); }
    }
  } catch { /* Logging must never change the send outcome. */ }
}
module.exports = { log, messageMeta, run: (context, fn) => scope.run(context, fn) };
