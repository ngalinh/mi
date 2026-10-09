'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dir = fs.mkdtempSync(path.join(dataDir, 'test-send-trace-'));
const file = path.join(dir, 'trace.log');
process.env.SEND_TRACE_FILE = file;
const trace = require('../shared/sendTrace');
const { createJob, getJob } = require('../local-runner/jobQueue');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('concurrent lanes retain job correlation, success/error and private message metadata', async () => {
  try {
    const first = createJob({ traceId: 'arrival-test', browserLane: 'hang', message: 'private-message' }, async () => {
      await delay(15); trace.log('test.confirm', { confirmed: true }); return { ok: true };
    });
    const second = createJob({ traceId: 'ship-test', browserLane: 'ship' }, async () => {
      trace.log('test.confirm', { confirmed: false }); throw Error('test-send-failure');
    });
    for (let i = 0; i < 100 && !['done','error'].includes(getJob(first).status); i++) await delay(5);
    assert.equal(getJob(first).status, 'done');
    assert.equal(getJob(second).status, 'error');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('private-message'));
    const entries = raw.trim().split('\n').map(line => JSON.parse(line.slice('[send-trace] '.length)));
    for (const [id, traceId] of [[first, 'arrival-test'], [second, 'ship-test']]) {
      assert.ok(entries.some(e => e.jobId === id && e.event === 'test.confirm'));
      assert.ok(entries.filter(e => e.jobId === id).every(e => e.traceId === traceId));
    }
    assert.ok(entries.some(e => e.event === 'runner.error' && e.error === 'test-send-failure'));
    assert.ok(entries.some(e => e.event === 'runner.done' && e.runnerOk === true));
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024));
    trace.log('test.rotation');
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(fs.readFileSync(file, 'utf8').includes('test.rotation'));
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.doesNotThrow(() => trace.log('test.write-failure'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
