import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const registry = 'https://npm.sea.com/';
class PublishError extends Error {}

function mask(value, log) {
  // Workflow command data must be escaped before the runner consumes the mask.
  log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}

export async function publishInternal({
  env = process.env,
  artifactDirectory = '.artifacts',
  temporaryRoot = env.RUNNER_TEMP ?? tmpdir(),
  request = fetch,
  spawnProcess = spawn,
  log = console.log,
} = {}) {
  const username = env.NPM_SEA_USERNAME;
  const password = env.NPM_SEA_PASSWORD;
  const auth = Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64');
  if (env.GITHUB_ACTIONS === 'true') {
    for (const value of [username, password, password && Buffer.from(password).toString('base64'), auth]) {
      if (value) mask(value, log);
    }
  }
  if (!username || !password) throw new PublishError('Configure NPM_SEA_USERNAME and NPM_SEA_PASSWORD as GitHub Actions secrets.');
  if (/[\r\n\0:]/.test(username) || /[\r\n\0]/.test(password)) {
    throw new PublishError('Internal registry credentials have an unsupported format.');
  }

  const version = env.RELEASE_VERSION;
  const npmTag = env.NPM_TAG;
  const validTag = typeof npmTag === 'string' && /^[a-z][a-z0-9-]*$/.test(npmTag) && npmTag.trim() === npmTag;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '') || !validTag) {
    throw new PublishError('Invalid release version or npm distribution tag.');
  }
  const filename = `wasmdbox-${version}.tgz`;
  const archive = resolve(artifactDirectory, 'npm', filename);
  const report = JSON.parse(await readFile(join(artifactDirectory, 'package-verification.json'), 'utf8'));
  const bytes = await readFile(archive);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (report.tarball !== filename || report.version !== version || report.integrity !== integrity) {
    throw new PublishError('Internal publication rejected: artifact differs from the CI verification report.');
  }

  let response;
  try {
    response = await request(new URL(`wasmdbox/${version}`, registry), {
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new PublishError('Cannot reach npm.sea.com: check runner network access, TLS and registry availability.');
  }
  if (response.status !== 404) {
    if (!response.ok) throw new PublishError(`Internal registry version check failed (HTTP ${response.status}).`);
    let published;
    try {
      published = await response.json();
    } catch {
      throw new PublishError('Internal registry returned invalid package metadata.');
    }
    if (published?.dist?.integrity !== integrity) {
      throw new PublishError('This internal package version already exists with different contents.');
    }
    log(`wasmdbox@${version} already exists on npm.sea.com with the verified contents; skipped.`);
    return;
  }

  const temporary = await mkdtemp(join(temporaryRoot, 'wasmdbox-npm-internal-'));
  try {
    const userconfig = join(temporary, '.npmrc');
    const globalconfig = join(temporary, 'global.npmrc');
    // No raw or encoded credentials on disk, and authentication is host-scoped.
    await writeFile(userconfig, `registry=${registry}\n//npm.sea.com/:_auth=\${WASMDBOX_NPM_AUTH}\n`, { mode: 0o600 });
    await writeFile(globalconfig, '', { mode: 0o600 });
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/^npm_config_/i.test(key) && !['NPM_SEA_USERNAME', 'NPM_SEA_PASSWORD', 'NODE_AUTH_TOKEN', 'NPM_TOKEN'].includes(key)));
    childEnv.WASMDBOX_NPM_AUTH = auth;
    await new Promise((resolvePublish, reject) => {
      // CLI registry overrides the public registry in the tarball's publishConfig.
      // Never forward npm output or errors: registries can echo credentials back.
      const child = spawnProcess('npm', [
        'publish', archive, `--registry=${registry}`, '--ignore-scripts', '--provenance=false',
        '--access=public', `--tag=${npmTag}`, '--strict-ssl=true',
        `--userconfig=${userconfig}`, `--globalconfig=${globalconfig}`, `--cache=${join(temporary, 'cache')}`,
        '--loglevel=silent', '--logs-max=0', '--fetch-retries=0', '--fetch-timeout=30000',
      ], { cwd: temporary, env: childEnv, stdio: 'ignore', timeout: 120_000 });
      child.once('error', () => reject(new PublishError('Internal npm publish could not start.')));
      child.once('close', code => {
        if (code === 0) resolvePublish();
        else reject(new PublishError('Internal npm publish failed; check credentials, publish permissions and runner connectivity. Raw npm output is suppressed.'));
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  log(`Published verified wasmdbox@${version} to npm.sea.com (${npmTag}).`);
}

if (import.meta.main) {
  try {
    await publishInternal();
  } catch (error) {
    console.error(error instanceof PublishError ? error.message : 'Internal publication failed; raw diagnostics are suppressed to protect credentials.');
    process.exitCode = 1;
  }
}
