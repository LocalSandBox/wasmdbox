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
      try { fstatSync(fd); } catch (error) { released = error.code === 'EBADF'; }
      record({ type: 'close', id, released });
    }
  };
  syncBuiltinESMExports();
}
