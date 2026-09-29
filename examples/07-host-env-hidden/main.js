import { Sandbox } from 'wasmdbox';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

// 07 Host environment variables are not inherited. Guest code is in guest.cjs.
let sandbox;
const previous = process.env.EDGE_DEMO_CREDENTIAL;

try {
  process.env.EDGE_DEMO_CREDENTIAL = 'fake-host-only-value';
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
  if (previous === undefined) delete process.env.EDGE_DEMO_CREDENTIAL;
  else process.env.EDGE_DEMO_CREDENTIAL = previous;
  await sandbox?.close();
}
console.log('PASS: 07 Host environment variables are not inherited');
