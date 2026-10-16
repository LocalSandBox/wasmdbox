import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Sandbox } from 'wasmdbox';
const originalFetch = globalThis.fetch;
const sandbox = await Sandbox.create();
try {
  assert.equal((await sandbox.exec(['node', '-e', 'process.stdout.write(require("child_process").execFileSync("python",["-c","print(42)"]))'], { check: true })).stdout, '42\n');
} finally { await sandbox.close(); }
assert.equal(globalThis.fetch, originalFetch);
assert.equal(await (await fetch('data:text/plain,host-unchanged')).text(), 'host replacement');
const events = (await readFile(process.env.WASMDBOX_FETCH_GUARD_REPORT, 'utf8')).trim().split('\n').map(JSON.parse);
assert.ok(new Set(events.map(event => event.threadId)).size >= 2, 'observe supervisor and engine workers');
assert.ok(events.every(event => event.blocked), 'all runtime realms must deny host fetch');
const attempts = (await readFile(process.env.WASMDBOX_VERIFY_FETCH_REPORT, 'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(attempts.length, events.length, 'fetch observation must survive the guard and record every probe');
assert.ok(attempts.every(event => event.url === 'data:text/plain,unexpected'));
console.log('PASS: worker fetch policy is inherited without changing the host application');
