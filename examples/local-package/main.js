import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Sandbox } from 'wasmdbox';

// This package is bundled locally and has never been published to a registry.
const webcBytes = await readFile(new URL('./hello.webc', import.meta.url));
const sandbox = await Sandbox.create({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
  extraPkgs: [webcBytes],
  network: false,
});
try {
  const result = await sandbox.exec(['local-hello'], { check: true, timeoutMs: 30_000 });
  assert.equal(result.stdout, 'hello from local webc\n');
  process.stdout.write(result.stdout);
  assert.match((await sandbox.exec(['node', '--version'], { check: true, timeoutMs: 30_000 })).stdout, /^v\d+/);
  console.log('PASS: local WEBC command and default Node runtime are available');
} finally {
  await sandbox.close();
}
