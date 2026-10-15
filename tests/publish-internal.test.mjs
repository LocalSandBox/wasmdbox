import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { publishInternal } from '../scripts/publish-internal.mjs';

// Deliberately synthetic: these values never authenticate against a registry.
const credentials = { NPM_SEA_USERNAME: 'fixture-user', NPM_SEA_PASSWORD: 'fixture-password%value' };
const credentialValues = env => [
  env.NPM_SEA_USERNAME,
  env.NPM_SEA_PASSWORD,
  env.NPM_SEA_PASSWORD && Buffer.from(env.NPM_SEA_PASSWORD).toString('base64'),
  Buffer.from(`${env.NPM_SEA_USERNAME ?? ''}:${env.NPM_SEA_PASSWORD ?? ''}`).toString('base64'),
].filter(Boolean);
const escapedCommandData = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

function assertNoCredentials(text, env) {
  for (const value of credentialValues(env)) {
    assert.ok(!text.includes(value), 'diagnostics must not expose credentials');
  }
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wasmdbox-publish-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactDirectory = join(root, 'artifacts');
  const temporaryRoot = join(root, 'runner');
  await Promise.all([mkdir(join(artifactDirectory, 'npm'), { recursive: true }), mkdir(temporaryRoot)]);
  const env = { ...credentials, GITHUB_ACTIONS: 'true', RELEASE_VERSION: '0.2.0', NPM_TAG: 'latest', ...overrides };
  const filename = `wasmdbox-${env.RELEASE_VERSION}.tgz`;
  const archive = join(artifactDirectory, 'npm', filename);
  const bytes = Buffer.from('synthetic CI-verified package archive\n');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const report = { tarball: filename, version: env.RELEASE_VERSION, integrity };
  const reportPath = join(artifactDirectory, 'package-verification.json');
  await Promise.all([writeFile(archive, bytes), writeFile(reportPath, JSON.stringify(report))]);
  const logs = [];
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const userconfig = args.find(arg => arg.startsWith('--userconfig=')).slice('--userconfig='.length);
    const globalconfig = args.find(arg => arg.startsWith('--globalconfig=')).slice('--globalconfig='.length);
    calls.push({
      command, args, options,
      userconfig: readFileSync(userconfig, 'utf8'),
      globalconfig: readFileSync(globalconfig, 'utf8'),
      userconfigMode: statSync(userconfig).mode & 0o777,
      globalconfigMode: statSync(globalconfig).mode & 0o777,
    });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const options = { env, artifactDirectory, temporaryRoot, log: line => logs.push(line), spawnProcess };
  return { ...options, options, logs, calls, archive, bytes, integrity, report, reportPath };
}

async function assertClean(context) {
  assert.deepEqual(await readdir(context.temporaryRoot), [], 'temporary publication files must be removed');
}

async function assertSafeFailure(run, context, expected) {
  let error;
  try { await run(); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error, 'publication must fail');
  assertNoCredentials(error.message, context.env);
  assert.ok(expected.test(error.message), 'failure must identify the expected problem without raw diagnostics');
  assertNoCredentials(context.logs.filter(line => !line.startsWith('::add-mask::')).join('\n'), context.env);
  await assertClean(context);
}

test('publishes the verified archive to the fixed internal registry with isolated npm credentials', async t => {
  const context = await fixture(t, {
    NODE_AUTH_TOKEN: 'fixture-unrelated-token', NPM_TOKEN: 'fixture-other-token',
    npm_config_registry: 'https://invalid.example/', NPM_CONFIG_LOGLEVEL: 'verbose',
    npm_config_userconfig: 'invalid-userconfig', PATH: process.env.PATH,
  });
  let requested = false;
  await publishInternal({ ...context.options, request: async (url, options) => {
    requested = true;
    assert.equal(url.href, 'https://npm.sea.com/wasmdbox/0.2.0');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.ok(options.headers.authorization === `Basic ${credentialValues(context.env).at(-1)}`, 'precheck must use Basic authentication');
    assert.equal(options.headers.accept, 'application/json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal, 'precheck must have a timeout signal');
    return { status: 404, ok: false };
  } });
  assert.ok(requested);
  assert.equal(context.calls.length, 1);
  const call = context.calls[0];
  assert.equal(call.command, 'npm');
  assert.equal(call.args[0], 'publish');
  assert.equal(call.args[1], resolve(context.archive));
  assert.ok((await readFile(call.args[1])).equals(context.bytes), 'publish must reuse the verified archive');
  for (const flag of ['--registry=https://npm.sea.com/', '--ignore-scripts', '--provenance=false', '--tag=latest', '--strict-ssl=true', '--loglevel=silent', '--logs-max=0']) {
    assert.ok(call.args.includes(flag), 'npm must receive the required publishing safeguards');
  }
  assert.equal(call.options.stdio, 'ignore');
  assert.ok(call.options.timeout > 0, 'npm must have a bounded runtime');
  assert.equal(call.userconfig, 'registry=https://npm.sea.com/\n//npm.sea.com/:_auth=${WASMDBOX_NPM_AUTH}\n');
  assert.equal(call.globalconfig, '');
  assertNoCredentials(call.userconfig + call.globalconfig + call.args.join(' '), context.env);
  if (process.platform !== 'win32') {
    assert.equal(call.userconfigMode, 0o600);
    assert.equal(call.globalconfigMode, 0o600);
  }
  assert.ok(call.options.env.WASMDBOX_NPM_AUTH === credentialValues(context.env).at(-1), 'npm receives only the derived authentication value');
  for (const key of ['NPM_SEA_USERNAME', 'NPM_SEA_PASSWORD', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
    assert.ok(!(key in call.options.env), 'npm must not inherit raw or unrelated registry credentials');
  }
  assert.ok(!Object.keys(call.options.env).some(key => /^npm_config_/i.test(key)), 'ambient npm configuration must be removed');
  assert.equal(call.options.env.PATH, process.env.PATH);
  assertNoCredentials(context.logs.filter(line => !line.startsWith('::add-mask::')).join('\n'), context.env);
  await assertClean(context);
});

test('passes prerelease and isolated smoke distribution tags through to npm', async t => {
  for (const npmTag of ['next', 'internal-smoke']) {
    const context = await fixture(t, { NPM_TAG: npmTag });
    let requests = 0;
    await publishInternal({ ...context.options, request: async () => {
      requests += 1;
      return { status: 404, ok: false };
    } });
    assert.equal(requests, 1);
    assert.equal(context.calls.length, 1);
    assert.deepEqual(context.calls[0].args.filter(arg => arg.startsWith('--tag=')), [`--tag=${npmTag}`]);
    assert.ok(context.logs.some(line => line.endsWith(`(${npmTag}).`)));
    await assertClean(context);
  }
});

test('invalid distribution tags stop before contacting the registry or invoking npm', async t => {
  for (const npmTag of [
    '', undefined, '1.2.3', '--registry', 'bad tag', ' latest', 'latest ',
    'latest\n', 'latest\r', 'latest\r\n', '$(id)', 'Latest',
  ]) {
    const context = await fixture(t, { NPM_TAG: npmTag });
    let requests = 0;
    await assertSafeFailure(() => publishInternal({ ...context.options, request: async () => {
      requests += 1;
      return { status: 404, ok: false };
    } }), context, /Invalid release version or npm distribution tag/);
    assert.equal(requests, 0);
    assert.equal(context.calls.length, 0);
  }
});

test('registers masks for raw and derived credentials before validation, escaping workflow command data', async t => {
  const context = await fixture(t, { NPM_SEA_USERNAME: 'fixture%user\r\ncommand', NPM_SEA_PASSWORD: 'fixture%password\r\ncommand' });
  await assertSafeFailure(() => publishInternal({ ...context.options, request: () => { throw new Error('unexpected request'); } }), context, /unsupported format/);
  const masks = context.logs.filter(line => line.startsWith('::add-mask::'));
  assert.equal(masks.length, 4);
  for (const value of credentialValues(context.env)) {
    assert.ok(masks.includes(`::add-mask::${escapedCommandData(value)}`), 'all raw and derived credential forms must be masked');
  }
  assert.ok(masks.every(line => !/[\r\n]/.test(line)), 'mask data cannot inject additional workflow commands');
  assert.equal(context.calls.length, 0);
});

test('skips a published version only when its integrity matches the verified archive', async t => {
  const context = await fixture(t);
  await publishInternal({ ...context.options, request: async () => ({ status: 200, ok: true, json: async () => ({ dist: { integrity: context.integrity } }) }) });
  assert.equal(context.calls.length, 0);
  assert.ok(context.logs.some(line => line.includes('skipped.')));
  await assertClean(context);
});

test('rejects an existing version with different contents', async t => {
  const context = await fixture(t);
  await assertSafeFailure(() => publishInternal({ ...context.options, request: async () => ({ status: 200, ok: true, json: async () => ({ dist: { integrity: 'sha512-different' } }) }) }), context, /different contents/);
  assert.equal(context.calls.length, 0);
});

test('rejects a changed archive before contacting the registry', async t => {
  const context = await fixture(t);
  await writeFile(context.archive, 'changed after CI verification');
  let requests = 0;
  await assertSafeFailure(() => publishInternal({ ...context.options, request: async () => { requests += 1; return { status: 404 }; } }), context, /differs from the CI verification report/);
  assert.equal(requests, 0);
  assert.equal(context.calls.length, 0);
});

test('rejects verification reports for a different version or tarball before contacting the registry', async t => {
  for (const changed of [{ version: '0.3.0' }, { tarball: 'unexpected.tgz' }]) {
    const context = await fixture(t);
    await writeFile(context.reportPath, JSON.stringify({ ...context.report, ...changed }));
    let requests = 0;
    await assertSafeFailure(() => publishInternal({ ...context.options, request: async () => { requests += 1; return { status: 404 }; } }), context, /differs from the CI verification report/);
    assert.equal(requests, 0);
    assert.equal(context.calls.length, 0);
  }
});

test('HTTP failures, unsafe network diagnostics and invalid registry JSON never invoke npm', async t => {
  for (const failure of ['http', 'network', 'json']) {
    const context = await fixture(t);
    const request = async () => {
      if (failure === 'network') throw new Error(`network failure: ${context.env.NPM_SEA_PASSWORD}`);
      if (failure === 'json') return { status: 200, ok: true, json: async () => { throw new Error(`invalid JSON: ${context.env.NPM_SEA_PASSWORD}`); } };
      return { status: 401, ok: false };
    };
    await assertSafeFailure(() => publishInternal({ ...context.options, request }), context, /Cannot reach|HTTP 401|invalid package metadata/);
    assert.equal(context.calls.length, 0);
  }
});

test('missing or unsupported credentials stop before any registry or npm call', async t => {
  for (const overrides of [
    { NPM_SEA_USERNAME: '' }, { NPM_SEA_PASSWORD: '' },
    { NPM_SEA_USERNAME: 'fixture:user' }, { NPM_SEA_USERNAME: 'fixture\0user' },
    { NPM_SEA_PASSWORD: 'fixture\0password' }, { NPM_SEA_PASSWORD: 'fixture\npassword' },
  ]) {
    const context = await fixture(t, overrides);
    let requests = 0;
    await assertSafeFailure(() => publishInternal({ ...context.options, request: async () => { requests += 1; return { status: 404 }; } }), context, /Configure|unsupported format/);
    assert.equal(requests, 0);
    assert.equal(context.calls.length, 0);
  }
});

test('npm process failures suppress raw diagnostics and clean the temporary configuration', async t => {
  for (const failure of ['error', 'exit']) {
    const context = await fixture(t);
    let attempts = 0;
    await assertSafeFailure(() => publishInternal({ ...context.options,
      request: async () => ({ status: 404, ok: false }),
      spawnProcess: (command, args, options) => {
        attempts += 1;
        assert.equal(options.stdio, 'ignore');
        const child = new EventEmitter();
        queueMicrotask(() => {
          if (failure === 'error') child.emit('error', new Error(`process error: ${context.env.NPM_SEA_PASSWORD}`));
          else child.emit('close', 1);
        });
        return child;
      },
    }), context, /could not start|publish failed/);
    assert.equal(attempts, 1);
  }
});

test('CLI suppresses raw filesystem and malformed-report errors', async t => {
  for (const failure of ['missing', 'invalid-json']) {
    const context = await fixture(t, { GITHUB_ACTIONS: '' });
    if (failure === 'invalid-json') {
      const artifactDirectory = join(context.temporaryRoot, '.artifacts');
      await mkdir(artifactDirectory);
      await writeFile(join(artifactDirectory, 'package-verification.json'), `invalid-json:${context.env.NPM_SEA_PASSWORD}`);
    }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/publish-internal.mjs', import.meta.url))], {
      cwd: context.temporaryRoot,
      env: { ...process.env, ...context.env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assertNoCredentials(result.stdout + result.stderr, context.env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'Internal publication failed; raw diagnostics are suppressed to protect credentials.');
    if (failure === 'invalid-json') await rm(join(context.temporaryRoot, '.artifacts'), { recursive: true });
    await assertClean(context);
  }
});
