// Test-only native descriptor observation inside a sandbox supervisor. This is
// inherited through --import and never included in the published package.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isMainThread, threadId, workerData } from 'node:worker_threads';

const report = process.env.WASMDBOX_MOUNT_REPORT;
const target = process.env.WASMDBOX_MOUNT_OBSERVE;
if (!isMainThread && workerData?.mode === 'sandbox' && report && target) {
  const { openSync, closeSync, fstatSync, appendFileSync } = fs;
  const expected = fs.statSync(target, { bigint: true });
  const handles = new Map();
  let sequence = 0;
  const record = event => appendFileSync(report, JSON.stringify({ threadId, ...event }) + '\n');
  fs.openSync = (...args) => {
    const fd = openSync(...args);
    const stats = fstatSync(fd, { bigint: true });
    if (stats.dev === expected.dev && stats.ino === expected.ino) {
      const id = ++sequence;
      handles.set(fd, id);
      record({ type: 'open', id });
    }
    return fd;
  };
  fs.closeSync = fd => {
    const id = handles.get(fd);
    closeSync(fd);
    if (id !== undefined) {
      handles.delete(fd);
      let released = false;
      try {
        // Other worker threads can reuse a process-wide descriptor immediately
        // after close. The number need not stay vacant; it must stop referring
        // to the mounted file that this observer saw being opened.
        const current = fstatSync(fd, { bigint: true });
        released = current.dev !== expected.dev || current.ino !== expected.ino;
      } catch (error) { released = error.code === 'EBADF'; }
      record({ type: 'close', id, released });
    }
  };
  syncBuiltinESMExports();
  // Keep failure reports useful when a runtime stalls before descriptor cleanup.
  const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
  for (const [Class, method] of [[sdk.Process, 'kill'], [sdk.Process, 'wait'], [sdk.Sandbox, 'close'], [sdk.Wasmer, 'close']]) {
    const original = Class.prototype[method];
    Class.prototype[method] = async function (...args) {
      const operation = `${Class.name}.${method}`;
      record({ type: 'lifecycle', operation, phase: 'start' });
      try { return await original.apply(this, args); }
      finally { record({ type: 'lifecycle', operation, phase: 'end' }); }
    };
  }
}
