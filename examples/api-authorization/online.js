import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Optional public HTTPS check using no real credentials. Local demos do not need this site.
const url = new URL(process.env.PROXY_SMOKE_URL ?? 'https://example.com/');
assert.equal(url.protocol, 'https:');
assert.equal(url.username + url.password + url.hash, '');
const sandbox = await Sandbox.create({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
  files: { '/workspace/guest.cjs': await readFile(new URL('./online-guest.cjs', import.meta.url)) },
  env: { API_URL: url.href },
  network: {
    allow: [url.hostname],
    secrets: {
      DEMO_HEADER: { value: 'wasmdbox-smoke', hosts: [url.hostname], ports: [Number(url.port || 443)] },
    },
  },
});

try {
  const result = await sandbox.exec(['node', '/workspace/guest.cjs'], {
    timeoutMs: 45_000, outputBytes: 64 * 1024, check: true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log('PASS: public HTTPS through the automatically managed proxy');
} finally {
  await sandbox.close();
}
