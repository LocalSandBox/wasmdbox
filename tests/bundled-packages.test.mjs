import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Sandbox } from 'wasmdbox';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const loader = new URL('./fixtures/package-loader.mjs', import.meta.url).href;
const runner = fileURLToPath(new URL('./fixtures/package-runner.mjs', import.meta.url));
const defaults = ['wasmer/edgejs-quickjs@=0.2.5', 'python/python@=3.13.20']; // Rejected legacy inputs.

test('bundled runtime creates directly without any package network requests', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, 'empty cache with spaces');
  let sequence = 0;
  const run = (packages = []) => probe('create-bytes', cache, packages, join(directory, `${++sequence}.jsonl`));
  const lock = JSON.parse(await readFile(join(root, 'dist/assets/runtime-lock.json'), 'utf8'));
  const first = await run();
  assert.deepEqual(first.find(event => event.type === 'load').sources, []);
  assert.equal(first.find(event => event.type === 'load').bytes.length, 1);
  assert.deepEqual(first.find(event => event.type === 'sandbox').ids, [`sha256:${lock.runtime.sha256}`]);
  const runtimePath = join(directory, 'runtime.webc');
  await writeFile(runtimePath, Buffer.concat(await Promise.all(lock.runtime.chunks.map(chunk => readFile(join(root, 'dist/assets', chunk.file))))));
  const duplicate = await run([runtimePath, runtimePath]);
  assert.equal(duplicate.find(event => event.type === 'load').bytes.length, 1);
  for (const oldPath of ['Library/Caches/wasmdbox', 'wasmdbox/Cache', 'wasmdbox']) {
    const registry = join(cache, oldPath, 'cache-v1/registry');
    await mkdir(registry, { recursive: true });
    await writeFile(join(registry, 'python#python'), '{"unix_timestamp":0,"response":null}');
  }
  await run();
});

test('all string extra packages are rejected without starting a worker or fetching', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-string-packages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const flags = { WASMDBOX_EXPECTED_ERROR: 'INVALID_OPTIONS', WASMDBOX_ERROR_MATCH: 'only nonempty Uint8Array.*strings are not supported' };
  const references = [
    'python/python', 'python/python@3.13.20', ...defaults,
    'missing/package@=1.0.0', 'python/python@>=3',
    'https://example.invalid/package.webc', './hello.webc',
  ];
  for (const [index, reference] of references.entries()) {
    const events = await probe('create', join(directory, 'cache'), [reference], join(directory, `${index}.jsonl`), flags);
    assert.deepEqual(events, [], 'invalid options must be rejected before worker startup');
  }
  const mixed = await probe('invalid-mixed', join(directory, 'cache'), [
    join(root, 'examples/local-package/hello.webc'), 'python/python',
  ], join(directory, 'mixed.jsonl'), flags);
  assert.deepEqual(mixed, [], 'mixed bytes and strings must also be rejected before worker startup');
});

test('damaged, missing and reordered runtime chunks fail locally', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-damaged-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'dist'), join(directory, 'dist'), { recursive: true, mode: constants.COPYFILE_FICLONE });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const lockPath = join(directory, 'dist/assets/runtime-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const chunk = lock.runtime.chunks[0];
  const path = join(directory, 'dist/assets', chunk.file);
  const flags = {
    WASMDBOX_TEST_ENTRY: pathToFileURL(join(directory, 'dist/index.js')).href,
    WASMDBOX_EXPECTED_ERROR: 'CREATE_FAILED',
  };
  await writeFile(path, 'corrupted');
  await probe('create', join(directory, 'cache'), [], join(directory, 'corrupt.jsonl'), { ...flags, WASMDBOX_ERROR_MATCH: 'integrity.*runtime-001' });
  await rm(path);
  await probe('create', join(directory, 'cache'), [], join(directory, 'missing.jsonl'), { ...flags, WASMDBOX_ERROR_MATCH: 'Cannot read bundled runtime chunk' });
  await cp(join(root, 'dist/assets', chunk.file), path, { mode: constants.COPYFILE_FICLONE });
  lock.runtime.chunks.reverse();
  await writeFile(lockPath, JSON.stringify(lock));
  await probe('create', join(directory, 'cache'), [], join(directory, 'dependency.jsonl'), { ...flags, WASMDBOX_ERROR_MATCH: 'integrity.*runtime.webc' });
});

test('local package initialization preserves timeout, cancellation and cleanup', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const action of ['timeout', 'abort']) {
    await probe(action, join(directory, 'cache'), [], join(directory, `${action}.jsonl`), { WASMDBOX_PACKAGE_FAULT: 'stalled-load' });
  }
});

test('extra package conflicts are explicit and external dependencies are rejected before SDK loading', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-local-dependencies-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = name => join(root, `tests/fixtures/local-packages/${name}.webc`);
  await probe('conflict', join(directory, 'cache'), [fixture('bash-shadow')], join(directory, 'conflict.jsonl'));
  // An extra's identity cannot replace built-ins; duplicate command names are still ambiguous.
  await probe('conflict', join(directory, 'cache'), [fixture('builtin-override')], join(directory, 'identity.jsonl'));
  for (const [index, packages] of [
    [fixture('local-parent')],
    [fixture('local-parent'), fixture('local-dependency')],
    [fixture('local-dependency'), fixture('local-parent')],
    [fixture('local-parent'), fixture('wrong-version')],
  ].entries()) {
    const events = await probe('create-bytes', join(directory, 'cache'), packages, join(directory, `dependencies-${index}.jsonl`), {
      WASMDBOX_EXPECTED_ERROR: 'CREATE_FAILED', WASMDBOX_ERROR_MATCH: 'External package dependencies are not supported',
    });
    assert.equal(events.some(event => event.type === 'load'), false, 'reject dependency-bearing bytes before upstream loading');
  }
});

test('creation validates additional local package inputs before starting a worker', async () => {
  assert.equal('prepare' in Sandbox, false);
  for (const extraPkgs of [null, 'python/python', [null], [7], [''], [' '], ['a\0b'], new Array(1), [new Uint8Array()], [Buffer.alloc(0)], [new ArrayBuffer(8)], [new DataView(new ArrayBuffer(8))], [new Uint16Array([1])], [[1, 2]], [{}]]) {
    await assert.rejects(Sandbox.create({ extraPkgs }), { name: 'SandboxError', code: 'INVALID_OPTIONS' });
  }
});

async function probe(action, legacyCacheRoot, packages, report, flags = {}) {
  const { stdout } = await execute(process.execPath, ['--import', loader, runner, action, ...packages], {
    cwd: root, timeout: 90_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, HOME: legacyCacheRoot, USERPROFILE: legacyCacheRoot, LOCALAPPDATA: legacyCacheRoot, XDG_CACHE_HOME: legacyCacheRoot, WASMDBOX_BLOCK_DOWNLOADS: '1', WASMDBOX_PACKAGE_REPORT: report, ...flags },
  });
  assert.ok(stdout.includes(`PASS: ${action}`));
  const events = await readFile(report, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.equal(events.some(event => event.type === 'fetch'), false, 'package loading must not attempt any fetch, even one it catches');
  return events;
}

test('host fetch replacement preloads cannot override the worker guard and observation stays active', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-fetch-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, [
    '--import', new URL('./fixtures/package-fetch-observer.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/package-fetch-runner.mjs', import.meta.url)),
  ], { cwd: root, timeout: 50_000, env: { ...process.env, WASMDBOX_FETCH_GUARD_REPORT: join(directory, 'events.jsonl'), WASMDBOX_VERIFY_FETCH_REPORT: join(directory, 'fetch.jsonl') } });
  assert.match(stdout, /PASS: worker fetch policy/);
});

test('removed cacheDir option is rejected before starting a worker', async () => {
  await assert.rejects(Sandbox.create({ cacheDir: './legacy-cache' }), { code: 'INVALID_OPTIONS', message: /cacheDir has been removed/ });
});
