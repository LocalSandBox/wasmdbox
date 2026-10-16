import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { satisfies } from 'semver';
import { assertSelfContained, digest } from '../src/internal/webc.ts';
import { readBundledRuntime } from '../src/internal/runtime-resource.ts';

export const root = fileURLToPath(new URL('../assets/', import.meta.url));
export const sourceRoot = fileURLToPath(new URL('../.artifacts/runtime-sources/', import.meta.url));
export const readLock = async () => JSON.parse(await readFile(join(root, 'runtime-lock.json'), 'utf8'));

export async function verifySources(lock) {
  if (lock.schemaVersion !== 2) throw new Error('Unsupported runtime lock version');
  const names = new Map(lock.packages.map(pkg => [pkg.name, pkg]));
  if (names.size !== lock.packages.length) throw new Error('Duplicate locked package name');
  for (const pkg of lock.packages) {
    if (!/^packages\/[\w.-]+\.webc$/.test(pkg.file) || !/^licenses\/[\w.-]+\.txt$/.test(pkg.licenseFile)) throw new Error(`Invalid resource path: ${pkg.name}`);
    if (!(await readFile(join(root, pkg.licenseFile), 'utf8')).trim()) throw new Error(`Missing license: ${pkg.name}`);
    for (const reference of Object.values(pkg.dependencies)) {
      if (typeof reference !== 'string') throw new Error(`Invalid dependency: ${pkg.name}`);
      const at = reference.lastIndexOf('@');
      const dep = names.get(reference.slice(0, at));
      if (!dep || !satisfies(dep.version, reference.slice(at + 1))) throw new Error(`Unsatisfied locked dependency of ${pkg.name}: ${reference}`);
    }
  }
}

export async function verifyRuntimeAssets() {
  const lock = await readLock();
  await verifySources(lock);
  if (!lock.runtime?.chunks?.length) throw new Error('Missing bundled runtime; maintainers must run runtime:bundle');
  if (lock.runtime.sourceLockSha256 !== digest(Buffer.from(JSON.stringify({ packages: lock.packages, bundleTool: lock.bundleTool })))) {
    throw new Error('Runtime source lock changed; run runtime:bundle');
  }
  for (const file of ['NOTICE.md', ...lock.packages.map(pkg => pkg.licenseFile)]) {
    if (lock.runtime.notices?.[file] !== digest(await readFile(join(root, file)))) throw new Error(`Runtime notice changed; run runtime:bundle: ${file}`);
  }
  assertSelfContained(await readBundledRuntime(pathToFileURL(root), lock.runtime));
  return lock;
}

// The build verifies once, before replacing dist, and passes the verified lock.
export async function copyRuntimeAssets(destination, lock) {
  const files = ['runtime-lock.json', 'NOTICE.md', ...lock.runtime.chunks.map(chunk => chunk.file), ...lock.packages.map(pkg => pkg.licenseFile)];
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
}

export function check(bytes, resource, name = resource.name) {
  if (bytes.length !== resource.size || digest(bytes) !== resource.sha256) throw new Error(`Integrity mismatch: ${name}`);
}

// Maintainer-only acquisition. Sources live in an ignored cache, never in npm.
// Neither ordinary builds nor consumers call this operation.
async function update() {
  const lock = await readLock();
  await verifySources(lock);
  for (const pkg of lock.packages) {
    const destination = join(sourceRoot, pkg.file);
    try { check(await readFile(destination), pkg); continue; } catch { /* Fetch the reviewed source. */ }
    const response = await fetch(pkg.url);
    if (!response.ok) throw new Error(`Download failed for ${pkg.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    check(bytes, pkg);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp`;
    try { await writeFile(temporary, bytes); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
  }
  console.log('Locked source packages verified; run npm run runtime:bundle to rebuild the distributable');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'update') await update();
  else if (process.argv[2] === 'verify') { await verifyRuntimeAssets(); console.log('Bundled runtime verified'); }
  else throw new Error('Usage: node scripts/runtime-assets.mjs verify|update');
}
