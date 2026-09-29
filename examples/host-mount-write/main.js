import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Writes through a writable host mount are saved directly to the host.
const hostDirectory = await mkdtemp(join(tmpdir(), 'wasmdbox-mount-write-'));
let sandbox;

try {
  await cp(new URL('./fixtures/', import.meta.url), hostDirectory, { recursive: true });
  sandbox = await Sandbox.create({
    cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
    files: {
      '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
    },
    mounts: [{ hostPath: hostDirectory, guestPath: '/mounted', readOnly: false }],
  });
  const output = await sandbox.exec(['node', '/workspace/guest.cjs'], {
    timeoutMs: 30_000, check: true,
  });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);

  // Read host files while the sandbox is still open to verify that mount writes are persisted.
  assert.equal(await readFile(join(hostDirectory, 'hello.txt'), 'utf8'), 'written by WASM\n');
  assert.equal(await readFile(join(hostDirectory, 'nested/renamed.txt'), 'utf8'), 'new host file\n');
  assert.equal(await readFile(join(hostDirectory, 'positioned.txt'), 'utf8'), '0123XYZ789');
  await assert.rejects(stat(join(hostDirectory, 'nested/to-rename.txt')), { code: 'ENOENT' });
  await assert.rejects(stat(join(hostDirectory, 'deleted.txt')), { code: 'ENOENT' });
  await assert.rejects(stat(join(hostDirectory, 'empty')), { code: 'ENOENT' });
  const expected = Buffer.alloc(768 * 1024);
  for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
  assert.deepEqual(await readFile(join(hostDirectory, 'binary.bin')), expected);
} finally {
  await cleanup(() => sandbox?.close(), () => rm(hostDirectory, { recursive: true, force: true }));
}
console.log('PASS: Writable mount persists edits, creation, offset writes, truncation, renames, deletion, and large files');

// ---- Setup helpers: close the sandbox and remove temporary files even after a failure ----

async function cleanup(...actions) {
  const errors = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Cleanup failed');
}
