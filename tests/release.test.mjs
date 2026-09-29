import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseMetadata } from '../scripts/release-metadata.mjs';

function metadata(version, ref = `refs/tags/v${version}`, changes = {}, lockVersion = version) {
  return releaseMetadata(ref, {
    name: 'wasmdbox', version,
    repository: { url: 'git+https://github.com/LocalSandBox/wasmdbox.git' },
    ...changes,
  }, { name: 'wasmdbox', version: lockVersion, packages: { '': { version: lockVersion } } });
}

test('releases select latest for stable versions and next for prereleases', () => {
  assert.deepEqual(metadata('0.1.0'), { version: '0.1.0', npmTag: 'latest' });
  assert.deepEqual(metadata('0.2.0-rc.1'), { version: '0.2.0-rc.1', npmTag: 'next' });
});

test('releases reject mismatched tags, lockfiles, repositories and private packages', () => {
  assert.throws(() => metadata('0.1.0', 'refs/tags/v0.2.0'), /Git tag/);
  assert.throws(() => metadata('0.1.0', 'refs/heads/main'), /Git tag/);
  assert.throws(() => metadata('0.1.0', undefined, {}, '0.2.0'), /lockfile version/);
  assert.throws(() => metadata('0.1.0', undefined, { name: 'another-package' }), /package name/);
  assert.throws(() => metadata('0.1.0', undefined, { repository: {} }));
  assert.throws(() => metadata('0.1.0', undefined, { private: true }), /public/);
});

test('releases reject malformed versions and build metadata', () => {
  for (const version of ['1.0', '01.0.0', '1.0.0-01', '1.0.0-rc..1', '1.0.0+build', '1.0.0\n', undefined]) {
    assert.throws(() => metadata(version));
  }
});
