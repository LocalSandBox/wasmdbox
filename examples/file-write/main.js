import { Sandbox } from 'wasmdbox';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Write and read a virtual file. Host SDK entry point; guest code is in guest.cjs.
let sandbox;
const input = new URL('./fixtures/visible.txt', import.meta.url);

try {
  sandbox = await Sandbox.create({
    cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
    files: {
      '/workspace/app/case.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
      '/workspace/work/hello.txt': await readFile(input),
    },
  });
  const output = await sandbox.exec(['node', '/workspace/app/case.cjs'], {
    timeoutMs: 30_000, check: true,
  });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  assert.equal(await readFile(input, 'utf8'), 'visible to WASM\n');
} finally {
  await sandbox?.close();
}
console.log('PASS: Write and read a virtual file');
