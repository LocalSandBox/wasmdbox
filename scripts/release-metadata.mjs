import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';

export function releaseMetadata(ref, manifest, lockfile) {
  assert.equal(manifest.name, 'wasmdbox', 'unexpected npm package name');
  assert.notEqual(manifest.private, true, 'the npm package must be public');
  assert.equal(manifest.repository?.url, 'git+https://github.com/LocalSandBox/wasmdbox.git');
  const version = manifest.version;
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  const match = typeof version === 'string' && version.match(semver);
  assert.ok(match && match[0] === version, 'release version must be SemVer without build metadata');
  const prerelease = match[4];
  assert.ok(!prerelease?.split('.').some(part => /^0\d+$/.test(part)), 'numeric prerelease identifiers cannot have leading zeroes');
  assert.equal(ref, `refs/tags/v${version}`, 'Git tag must match package.json version');
  assert.equal(lockfile.name, manifest.name, 'lockfile package name must match');
  assert.equal(lockfile.version, version, 'lockfile version must match');
  assert.equal(lockfile.packages?.['']?.version, version, 'lockfile root version must match');
  return { version, npmTag: prerelease ? 'next' : 'latest' };
}

if (import.meta.main) {
  assert.equal(process.env.GITHUB_REPOSITORY, 'LocalSandBox/wasmdbox', 'releases must originate from LocalSandBox/wasmdbox');
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const lockfile = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const { version, npmTag } = releaseMetadata(process.env.GITHUB_REF, manifest, lockfile);
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'inherit' });
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nnpm-tag=${npmTag}\n`);
  console.log(`Validated wasmdbox@${version} from main; npm tag: ${npmTag}`);
}
