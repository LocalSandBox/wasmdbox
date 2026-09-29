import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy directory contents at creation. Guest edits affect the virtual copy, not the host originals.
const sourceDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));
const sandbox = await Sandbox.create({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
  files: {
    ...await readDirectory(sourceDirectory, '/workspace/data'),
    '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
  },
});

try {
  const result = await sandbox.exec(['node', '/workspace/guest.cjs'], { timeoutMs: 30_000, check: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(await readFile(join(sourceDirectory, 'hello.txt'), 'utf8'), 'hello from host\n');
  await assert.rejects(readFile(join(sourceDirectory, 'result.txt')), { code: 'ENOENT' });
  console.log('PASS: Guest edits the snapshot without changing the host directory');
} finally {
  await sandbox.close();
}

// ---- Setup helpers: import regular files, preserving directory structure in their paths ----

async function readDirectory(hostDirectory, guestDirectory) {
  const files = {};
  for (const entry of await readdir(hostDirectory, { withFileTypes: true })) {
    const hostPath = join(hostDirectory, entry.name);
    const guestPath = posix.join(guestDirectory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readDirectory(hostPath, guestPath));
    } else if (entry.isFile()) {
      files[guestPath] = await readFile(hostPath);
    } else {
      throw new Error('Only regular files and directories are imported: ' + hostPath);
    }
  }
  return files;
}
