import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Validate the built artifact without rebuilding or touching the checkout's dist.
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const temporary = await mkdtemp(join(tmpdir(), 'wasmdbox-package-'));
const consumer = join(temporary, 'consumer');
const startedAt = new Date().toISOString();
const permissions = [];
try {
  const packed = JSON.parse(await run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  assert.equal(packed.length, 1);
  const archive = join(temporary, packed[0].filename);
  const included = new Set(packed[0].files.map(file => file.path));
  for (const path of ['LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/internal/sandbox-worker.js', 'dist/internal/package-fetch.js', 'dist/internal/webc.js', 'dist/assets/runtime-lock.json', 'dist/assets/NOTICE.md', 'dist/vendor/wasmer-sdk/LICENSE', 'examples/local-package/hello.webc']) {
    assert.ok(included.has(path), `missing package file: ${path}`);
  }
  assert.ok([...included].some(path => path.startsWith('dist/vendor/wasmer-sdk/') && path.endsWith('.wasm')));
  assert.ok(![...included].some(path => path.startsWith('node_modules/')));
  assert.ok(!included.has('dist/assets/edgejs-keepalive.cjs'), 'legacy keepalive preload must not be shipped');
  const runtimeLock = JSON.parse(await readFile(join(root, 'assets/runtime-lock.json'), 'utf8'));
  for (const file of [...runtimeLock.runtime.chunks.map(chunk => chunk.file), ...runtimeLock.packages.map(pkg => pkg.licenseFile)]) {
    assert.ok(included.has(`dist/assets/${file}`), `missing bundled resource: ${file}`);
  }
  assert.ok(![...included].some(path => path.startsWith('dist/assets/packages/')), 'original dependency-bearing packages must not ship');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'wasmdbox-external-consumer', private: true, type: 'module' }));
  await cp(new URL('../tests/fixtures/package-consumer/', import.meta.url), consumer, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const dependencies = [archive, `typescript@${manifest.devDependencies.typescript}`, `@types/node@${manifest.devDependencies['@types/node']}`, `selfsigned@${manifest.dependencies.selfsigned}`];
  await run(npm, ['install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', ...dependencies], consumer);
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules/wasmdbox/package.json'), 'utf8'));
  assert.equal(installed.name, 'wasmdbox');
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.license, 'MIT');
  assert.equal(installed.scripts?.postinstall, undefined);
  const upstream = JSON.parse(await readFile(join(root, 'patches/wasmer-sdk-0.19.1.integrity.json'), 'utf8'));
  for (const [file, expected] of Object.entries(upstream.files)) {
    if (!file.endsWith('.wasm')) continue;
    const bytes = await readFile(join(consumer, 'node_modules/wasmdbox/dist/vendor/wasmer-sdk', file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'installed engine must match the official npm WASM');
  }
  await assert.rejects(readFile(join(consumer, 'node_modules/@wasmer/sdk/package.json')), { code: 'ENOENT' });
  await run(join(consumer, 'node_modules/typescript/bin/tsc'), [
    '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts',
  ], consumer);
  await makeReadOnly(join(consumer, 'node_modules/wasmdbox'));
  const fetchReport = join(temporary, 'fetch.jsonl');
  await writeFile(fetchReport, '');
  const runtime = await run(join(consumer, 'main.mjs'), [], consumer, {
    HOME: join(temporary, 'empty home'), USERPROFILE: join(temporary, 'empty home'),
    XDG_CACHE_HOME: join(temporary, 'empty cache'), LOCALAPPDATA: join(temporary, 'empty cache'),
    WASMDBOX_VERIFY_FETCH_REPORT: fetchReport,
  }, ['--import', pathToFileURL(join(consumer, 'block-fetch.mjs')).href]);
  assert.equal(await readFile(fetchReport, 'utf8'), '', 'installed runtime must not attempt host fetch');
  process.stdout.write(runtime);
  const report = {
    verifiedAt: startedAt,
    node: process.version,
    platform: process.platform,
    tarball: packed[0].filename,
    version: manifest.version,
    integrity: packed[0].integrity,
    shasum: packed[0].shasum,
    ablationDocumentSha256: createHash('sha256').update(await readFile(join(consumer, 'node_modules/wasmdbox/docs/ablation.md'))).digest('hex'),
    files: included.size,
    installedWithScriptsDisabled: true,
    readOnlyPackage: true,
    standaloneJavaScript: true,
    standaloneTypeScript: true,
    nodeAndBash: true,
    guestFileWrite: true,
    hostMountWrite: true,
    hostWorkspaceStorage: true,
    defaultPackageCommandSelection: true,
    nativeHttpsSecretSubstitution: true,
    bundledPython: true,
    selfContainedRuntime: true,
    officialEngineWasm: true,
    runtimeSha256: runtimeLock.runtime.sha256,
    emptyRuntimeCache: true,
    packageNetworkRequests: 0,
    extraPackages: true,
    localWebcPackages: true,
  };
  const artifactDirectory = join(root, '.artifacts/npm');
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  await copyFile(archive, join(artifactDirectory, packed[0].filename));
  await writeFile(join(root, '.artifacts/package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS: npm pack → outside-repository install --ignore-scripts (${included.size} files)`);
} finally {
  for (const [path, mode] of permissions.reverse()) await chmod(path, mode);
  await rm(temporary, { recursive: true, force: true });
}

function run(script, args, cwd, extraEnv = {}, nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, script, ...args], {
      cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const output = Buffer.concat(stdout).toString();
      if (code === 0) resolve(output);
      else reject(new Error(`${script} failed (${signal ?? code})\n${output}${Buffer.concat(stderr).toString()}`));
    });
  });
}

async function makeReadOnly(path) {
  const metadata = await stat(path);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'the published package must not contain symlinks');
      await makeReadOnly(join(path, entry.name));
    }
  }
  const mode = metadata.mode & 0o777;
  permissions.push([path, mode]);
  await chmod(path, mode & ~0o222);
}
