import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The host acquires a pinned archive; the guest installs offline with networking disabled.
const archive = await acquireArchive();
const sandbox = await Sandbox.create({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
  files: {
    '/workspace/package.json': await readFile(new URL('./fixtures/package.json', import.meta.url)),
    '/workspace/vendor/is-number-7.0.0.tgz': archive,
    '/workspace/before.cjs': await readFile(new URL('./before.cjs', import.meta.url)),
    '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
  },
});

try {
  await sandbox.exec(['node', '/workspace/before.cjs'], { check: true });
  const install = await sandbox.exec([
    'pnpm', 'add', './vendor/is-number-7.0.0.tgz', '--offline', '--ignore-scripts', '--reporter=append-only',
  ], {
    cwd: '/workspace', timeoutMs: 120_000, check: true,
    env: {
      HOME: '/tmp', PATH: '/bin:/usr/bin', CI: 'true',
      npm_config_node_linker: 'hoisted',
      npm_config_npm_path: '/bin/edge-npm-internal',
      npm_config_package_import_method: 'copy',
      npm_config_store_dir: '/tmp/.pnpm-store',
      npm_config_update_notifier: 'false',
    },
  });
  process.stdout.write(install.stdout);
  process.stderr.write(install.stderr);

  // A second guest process checks the manifest, requires the installed package, and runs it.
  const result = await sandbox.exec(['node', '/workspace/guest.cjs'], {
    cwd: '/workspace', timeoutMs: 30_000, check: true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(JSON.parse(result.stdout).package, 'is-number@7.0.0');
  console.log('PASS: Guest pnpm installs a package and another guest process runs it');
} finally {
  await sandbox.close();
}

// ---- Setup helpers: pinned archive source, size limit, and SHA512 verification ----

async function acquireArchive() {
  const cache = new URL('../../.artifacts/is-number-7.0.0.tgz', import.meta.url);
  let bytes;
  try {
    bytes = await readFile(cache);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch('https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz', {
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= 64 * 1024, 'archive exceeds limit');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.equal(integrity, 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==');
  await mkdir(new URL('../../.artifacts/', import.meta.url), { recursive: true });
  await writeFile(cache, bytes);
  return bytes;
}
