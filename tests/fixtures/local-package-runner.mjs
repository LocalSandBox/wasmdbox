import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Sandbox } from 'wasmdbox';

const [action, cacheDir, variant = 'buffer'] = process.argv.slice(2);
const original = await readFile(new URL('../../examples/local-package/hello.webc', import.meta.url));
let bytes;
switch (variant) {
  case 'buffer': bytes = Buffer.from(original); break;
  case 'uint8': bytes = new Uint8Array(original); break;
  case 'subarray':
  case 'buffer-subarray': {
    const backing = variant === 'subarray' ? new Uint8Array(original.length + 23) : Buffer.alloc(original.length + 23);
    backing.fill(0xff);
    backing.set(original, 7);
    bytes = backing.subarray(7, 7 + original.length);
    break;
  }
  case 'shared':
    bytes = new Uint8Array(new SharedArrayBuffer(original.length));
    bytes.set(original);
    break;
  case 'duplicates': bytes = new Uint8Array(original); break;
  case 'corrupt': bytes = new Uint8Array([1, 2, 3]); break;
  default: throw new Error(`Unknown byte variant: ${variant}`);
}

const runtime = 'wasmer/edgejs-quickjs@=0.1.4';
const extraPkgs = action === 'create-default' ? []
  : variant === 'duplicates' ? [runtime, bytes, runtime, bytes, new Uint8Array(bytes)]
  : [runtime, bytes];
const method = action === 'prepare' ? 'prepare' : 'create';
if (method === 'create') {
  Sandbox.prepare = () => { throw new Error('create must not depend on prepare'); };
}
const pending = Sandbox[method]({ cacheDir, extraPkgs, network: false });
// This runs before startup yields back to the worker. Both content and list
// changes must leave the captured package intact, even for shared memory.
assert.deepEqual(bytes, variant === 'corrupt' ? new Uint8Array([1, 2, 3])
  : Buffer.isBuffer(bytes) ? original : new Uint8Array(original));
bytes.fill(0);
extraPkgs.length = 0;
assert.ok(bytes.byteLength > 0, 'startup must not detach caller buffers');
assert.ok(bytes.every(byte => byte === 0), 'caller retains a usable buffer');
if (variant === 'corrupt') {
  await assert.rejects(pending, { name: 'SandboxError', code: method === 'prepare' ? 'PREPARE_FAILED' : 'CREATE_FAILED' });
} else if (method === 'prepare') {
  assert.equal(await pending, undefined);
} else {
  const sandbox = await pending;
  try {
    if (action === 'create-default') {
      await assert.rejects(sandbox.exec(['local-hello']), { name: 'CommandError', code: 'COMMAND_NOT_FOUND' });
    } else {
      const output = await sandbox.exec(['local-hello'], { check: true, timeoutMs: 30_000 });
      assert.equal(output.stdout, 'hello from local webc\n');
      assert.equal(output.stderr, '');
      assert.equal(output.exitCode, 0);
    }
    assert.match((await sandbox.exec(['node', '--version'], { check: true, timeoutMs: 30_000 })).stdout, /^v\d+/);
  } finally {
    await sandbox.close();
  }
}
console.log(`PASS: ${action} ${variant}`);
// A natural subprocess exit also verifies worker cleanup.
