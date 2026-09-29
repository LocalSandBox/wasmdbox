import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// create() loads its own packages and does not require a preceding prepare().
const sandbox = await Sandbox.create({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
  extraPkgs: ['python/python@=3.13.20'],
  files: { '/workspace/guest.py': await readFile(new URL('./guest.py', import.meta.url)) },
});

try {
  const output = await sandbox.exec(['python', '/workspace/guest.py'], { check: true, timeoutMs: 30_000 });
  assert.equal(output.stdout, 'hello from Python\n');
  process.stdout.write(output.stdout);
  const node = await sandbox.exec(['node', '--version'], { check: true, timeoutMs: 30_000 });
  assert.match(node.stdout, /^v\d+/);
  console.log('PASS: the extra Python package and default Node runtime are available');
} finally {
  await sandbox.close();
}
