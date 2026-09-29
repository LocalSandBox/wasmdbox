import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A read-only host mount exposes the directory and subsequent host changes to the guest.
const hostDirectory = await mkdtemp(join(tmpdir(), 'wasmdbox-mount-read-'));
let sandbox;

try {
  await cp(new URL('./fixtures/', import.meta.url), hostDirectory, { recursive: true });
  sandbox = await Sandbox.create({
    cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
    files: {
      '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
    },
    mounts: [{ hostPath: hostDirectory, guestPath: '/mounted', readOnly: true }],
  });

  // Change the host file after creation to prove this is a live mount, not a snapshot.
  await writeFile(join(hostDirectory, 'hello.txt'), 'updated after sandbox creation\n');
  const output = await sandbox.exec(['node', '/workspace/guest.cjs'], {
    timeoutMs: 30_000, check: true,
  });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  assert.equal(await readFile(join(hostDirectory, 'hello.txt'), 'utf8'), 'updated after sandbox creation\n');
  await assert.rejects(readFile(join(hostDirectory, 'blocked.txt')), { code: 'ENOENT' });
} finally {
  await cleanup(() => sandbox?.close(), () => rm(hostDirectory, { recursive: true, force: true }));
}
console.log('PASS: Read-only mount exposes current host contents and rejects guest writes');

// ---- Setup helpers: close the sandbox and remove temporary files even after a failure ----

async function cleanup(...actions) {
  const errors = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Cleanup failed');
}
