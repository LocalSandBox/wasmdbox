// Maintainer-only recipe. Uses the official CLI; never rebuilds the Wasmer SDK.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { assertSelfContained, digest } from '../src/internal/webc.ts';
import { check, readLock, root, sourceRoot, verifyRuntimeAssets, verifySources } from './runtime-assets.mjs';

const lock = await readLock();
await verifySources(lock);
const cli = process.env.WASMER ?? 'wasmer';
const version = execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, `wasmer ${lock.bundleTool.version}`, 'Use the CLI version recorded in runtime-lock.json');
const work = await mkdtemp(join(tmpdir(), 'wasmdbox-runtime-'));
const q = JSON.stringify;
try {
  const expected = { atoms: {}, commands: {}, mounts: {} };
  const lines = ['[package]', 'name = "wasmdbox/runtime"', 'version = "0.0.0"', 'entrypoint = "node"'];
  await mkdir(join(work, 'annotations'));
  for (const pkg of lock.packages) {
    const source = join(sourceRoot, pkg.file);
    check(await readFile(source), pkg);
    const directory = join(work, 'sources', pkg.name.replaceAll('/', '-'));
    await mkdir(directory, { recursive: true });
    execFileSync(cli, ['package', 'unpack', '--quiet', '--format', 'webc', '--out-dir', directory, source], { stdio: 'inherit' });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, pkg.manifest, `Original manifest changed: ${pkg.name}`);
    assert.deepEqual(manifest.use ?? {}, pkg.dependencies);
    for (const [name, atom] of Object.entries(manifest.atoms)) {
      assert.equal(expected.atoms[name], undefined, `Duplicate atom: ${name}`);
      expected.atoms[name] = atom;
      lines.push('', '[[module]]', `name = ${q(name)}`, `source = ${q(local(join(directory, name)))}`, `kind = ${q(atom.kind)}`);
    }
    for (const [name, command] of Object.entries(manifest.commands)) {
      assert.equal(expected.commands[name], undefined, `Duplicate command: ${name}`);
      assert.equal(command.annotations.atom.dependency, undefined);
      expected.commands[name] = command;
      const file = `annotations/${Object.keys(expected.commands).length}.json`;
      await writeFile(join(work, file), JSON.stringify(command.annotations));
      lines.push('', '[[command]]', `name = ${q(name)}`, `module = ${q(command.annotations.atom.name)}`, `runner = ${q(command.runner)}`, `annotations = { file = ${q(file)}, kind = "json" }`);
    }
    for (const mapping of manifest.package.fs ?? []) {
      assert.equal(mapping.from, null);
      assert.equal(mapping.original_path, undefined);
      assert.equal(expected.mounts[mapping.mount_path], undefined, `Duplicate mount: ${mapping.mount_path}`);
      expected.mounts[mapping.mount_path] = join(directory, mapping.volume_name.replace(/^\//, ''));
    }
  }
  await cp(join(root, 'licenses'), join(work, 'licenses'), { recursive: true });
  await copyFile(join(root, 'NOTICE.md'), join(work, 'licenses/NOTICE.md'));
  expected.mounts['/opt/wasmdbox/licenses'] = join(work, 'licenses');
  lines.push('', '[fs]', ...Object.entries(expected.mounts).map(([guest, host]) => `${q(guest)} = ${q(local(host))}`), '');
  await writeFile(join(work, 'wasmer.toml'), lines.join('\n'));
  await normalizeTimes(work);
  const output = join(work, 'runtime.webc');
  execFileSync(cli, ['package', 'build', '--quiet', '--out', output, join(work, 'wasmer.toml')], { stdio: 'inherit' });
  const bytes = await readFile(output);
  assertSelfContained(bytes);
  const inspection = join(work, 'inspection');
  await mkdir(inspection);
  execFileSync(cli, ['package', 'unpack', '--quiet', '--format', 'webc', '--out-dir', inspection, output], { stdio: 'inherit' });
  const built = JSON.parse(await readFile(join(inspection, 'manifest.json'), 'utf8'));
  assert.deepEqual(built.use ?? {}, {});
  assert.deepEqual(built.commands, expected.commands);
  const featureChanges = {};
  for (const [name, atom] of Object.entries(expected.atoms)) {
    assert.equal(built.atoms[name].kind, atom.kind);
    assert.equal(built.atoms[name].signature, atom.signature);
    const original = atom.annotations.wasm.features;
    const rebuilt = built.atoms[name].annotations.wasm.features;
    for (const feature of original) assert.ok(rebuilt.includes(feature), `${name}: missing ${feature}`);
    if (JSON.stringify(original) !== JSON.stringify(rebuilt)) featureChanges[name] = { original, rebuilt };
  }
  assert.deepEqual(built.package.fs.map(m => m.mount_path).sort(), Object.keys(expected.mounts).sort());
  let files = 0;
  for (const mapping of built.package.fs) {
    assert.equal(mapping.from, null);
    files += await compareDirectories(expected.mounts[mapping.mount_path], join(inspection, mapping.volume_name.replace(/^\//, '')));
  }
  const chunks = [];
  await mkdir(join(root, 'runtime'), { recursive: true });
  for (let offset = 0; offset < bytes.length; offset += 48 * 1024 * 1024) {
    const part = bytes.subarray(offset, offset + 48 * 1024 * 1024);
    const file = `runtime/runtime-${String(chunks.length + 1).padStart(3, '0')}.bin`;
    await writeFile(join(root, file + '.tmp'), part);
    await rename(join(root, file + '.tmp'), join(root, file));
    chunks.push({ file, size: part.length, sha256: digest(part) });
  }
  const previous = lock.runtime?.chunks ?? [];
  const notices = {};
  for (const file of ['NOTICE.md', ...lock.packages.map(pkg => pkg.licenseFile)]) notices[file] = digest(await readFile(join(root, file)));
  const sourceLockSha256 = digest(Buffer.from(JSON.stringify({ packages: lock.packages, bundleTool: lock.bundleTool })));
  lock.runtime = { size: bytes.length, sha256: digest(bytes), chunks, sourceLockSha256, notices, atoms: Object.keys(built.atoms).length, commands: Object.keys(built.commands).length, files, featureChanges };
  await writeFile(join(root, 'runtime-lock.json.tmp'), JSON.stringify(lock, null, 2) + '\n');
  await rename(join(root, 'runtime-lock.json.tmp'), join(root, 'runtime-lock.json'));
  for (const chunk of previous) if (!chunks.some(next => next.file === chunk.file) && /^runtime\/runtime-\d{3}\.bin$/.test(chunk.file)) await rm(join(root, chunk.file), { force: true });
  await verifyRuntimeAssets();
  console.log(JSON.stringify(lock.runtime, null, 2));
} finally { await rm(work, { recursive: true, force: true }); }

function local(path) { return relative(work, path).replaceAll('\\', '/'); }
async function normalizeTimes(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const item = join(path, entry.name);
    if (entry.isDirectory()) await normalizeTimes(item);
    else assert.ok(entry.isFile(), `Unsupported resource type: ${item}`);
    await utimes(item, 0, 0);
  }
}
async function compareDirectories(source, target) {
  const entries = await readdir(source, { withFileTypes: true });
  assert.deepEqual((await readdir(target)).sort(), entries.map(e => e.name).sort());
  let files = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) files += await compareDirectories(join(source, entry.name), join(target, entry.name));
    else { assert.ok((await readFile(join(source, entry.name))).equals(await readFile(join(target, entry.name)))); files++; }
  }
  return files;
}
