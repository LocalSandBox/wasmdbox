import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sandbox = await Sandbox.create({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
  files: { '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)) },
});

try {
  const child = await sandbox.spawn(['node', '/workspace/guest.cjs'], {
    stdin: 'pipe', timeoutMs: 30_000, check: true,
  });
  child.stdin.end('hello from host\n');
  child.stderr.pipe(process.stderr, { end: false });
  let text = '';
  for await (const chunk of child.stdout) {
    text += chunk.toString();
    process.stdout.write(chunk);
  }
  const result = await child.wait();
  assert.equal(result.exitCode, 0);
  assert.equal(text, 'guest received: hello from host\n');
  console.log('PASS: 28 stdin, streaming stdout, and wait');
} finally {
  await sandbox.close();
}
