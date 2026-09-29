import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this directory after closing the sandboxes so the installation persists.
const hostDirectory = fileURLToPath(new URL('../../.artifacts/package-install/', import.meta.url));
const cacheDir = fileURLToPath(new URL('../../.wasmer/', import.meta.url));
await mkdir(hostDirectory, { recursive: true });
try {
  await writeFile(join(hostDirectory, 'package.json'), await readFile(new URL('./fixtures/package.json', import.meta.url)), { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
console.log('Persistent host directory: ' + hostDirectory);

const installer = await Sandbox.create({
  cacheDir,
  network: { allow: ['registry.npmjs.org'] },
  mounts: [{ hostPath: hostDirectory, guestPath: '/mounted', readOnly: false }],
  files: {
    '/workspace/before.cjs': await readFile(new URL('./before.cjs', import.meta.url)),
  },
});
try {
  const before = await installer.exec(['node', '/workspace/before.cjs'], { check: true, timeoutMs: 30_000 });
  process.stdout.write(before.stdout);
  const install = await installer.exec([
    'pnpm', '--dir=/mounted', 'add', 'is-number@7.0.0', '--save-exact', '--ignore-scripts', '--reporter=append-only',
    '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=30000',
  ], {
    // Keep WASI startup in /workspace; pnpm targets the host mount via --dir.
    cwd: '/workspace', timeoutMs: 120_000, check: true,
    env: {
      HOME: '/tmp', PATH: '/bin:/usr/bin', CI: 'true',
      // Use ordinary files: the mount adapter rejects host symlinks and hardlinks.
      npm_config_node_linker: 'hoisted',
      npm_config_npm_path: '/bin/edge-npm-internal',
      npm_config_package_import_method: 'copy',
      npm_config_store_dir: '/tmp/.pnpm-store',
      npm_config_update_notifier: 'false',
    },
  });
  process.stdout.write(install.stdout);
  process.stderr.write(install.stderr);
} finally {
  await installer.close();
}

// The installer is gone. Confirm its writes still exist in the real host directory.
const metadata = JSON.parse(await readFile(join(hostDirectory, 'node_modules/is-number/package.json'), 'utf8'));
assert.equal(metadata.version, '7.0.0');
assert.ok((await readFile(join(hostDirectory, 'node_modules/is-number/index.js'))).length > 0);
console.log('Installer closed; is-number@7.0.0 remains on the host');

// A new sandbox receives only the guest script and a read-only mount of the saved installation.
const verifier = await Sandbox.create({
  cacheDir,
  network: false,
  mounts: [{ hostPath: hostDirectory, guestPath: '/mounted', readOnly: true }],
  files: { '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)) },
});
try {
  const result = await verifier.exec(['node', '/workspace/guest.cjs'], {
    cwd: '/workspace', timeoutMs: 30_000, check: true,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.package, 'is-number@7.0.0');
  assert.equal(report.loadedFrom, '/mounted/node_modules/is-number/index.js');
} finally {
  await verifier.close();
}
console.log('PASS: Guest pnpm installs into a host mount; a new sandbox requires and runs the persisted package');
console.log('Installation kept at: ' + hostDirectory);
