import { Sandbox } from 'wasmdbox';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

// 09 Raw TCP connections to public addresses are disabled. Guest code is in guest.cjs.
let sandbox;

try {
  sandbox = await Sandbox.create({
    cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
    files: {
      '/workspace/app/case.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
    },
  });
  const output = await sandbox.exec(['node', '/workspace/app/case.cjs'], {
    timeoutMs: 30_000, check: true,
  });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
} finally {
  await sandbox?.close();
}
console.log('PASS: 09 Raw TCP connections to public addresses are disabled');
