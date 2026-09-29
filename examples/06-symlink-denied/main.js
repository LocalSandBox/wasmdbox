import { Sandbox } from 'wasmdbox';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 06 Symlinks cannot expose unmounted host files. Guest code is in guest.cjs.
let sandbox;
const hostPath = fileURLToPath(new URL('./fixtures/hidden.txt', import.meta.url));

try {
  sandbox = await Sandbox.create({
    cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
    files: {
      '/workspace/app/case.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
      '/workspace/work/hello.txt': 'visible\n',
    },
  });
  const output = await sandbox.exec(['node', '/workspace/app/case.cjs', hostPath], {
    timeoutMs: 30_000, check: true,
  });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  assert.equal(await readFile(hostPath, 'utf8'), 'host-only sentinel\n');
} finally {
  await sandbox?.close();
}
console.log('PASS: 06 Symlinks cannot expose unmounted host files');
