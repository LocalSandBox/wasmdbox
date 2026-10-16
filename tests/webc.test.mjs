import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import cbor from 'cbor';
import { assertSelfContained, readWebcManifest } from '../dist/internal/webc.js';

const hello = await readFile(new URL('../examples/local-package/hello.webc', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest();

test('self-contained WEBC and visible byte subarrays are accepted', () => {
  assert.doesNotThrow(() => assertSelfContained(hello));
  const padded = Buffer.concat([Buffer.alloc(17), hello, Buffer.alloc(11)]);
  assert.doesNotThrow(() => assertSelfContained(padded.subarray(17, 17 + hello.length)));
  assert.doesNotThrow(() => assertSelfContained(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])));
});

test('uses the indexed manifest rather than a benign earlier manifest', () => {
  for (const reference of ['wasmer/bash@*', 'https://example.invalid/package.webc', './local.webc', 'sha256:' + 'a'.repeat(64)]) {
    const manifest = readWebcManifest(hello);
    manifest.set('use', new Map([['dep', reference]]));
    assert.throws(() => assertSelfContained(withManifest(cbor.encode(manifest))), /External package dependencies/);
  }
});

test('rejects ambiguous CBOR, invalid spans, unsupported formats and excessive metadata', () => {
  const duplicate = Buffer.concat([Buffer.from([0xa2]), cbor.encode('use'), cbor.encode(new Map()), cbor.encode('use'), cbor.encode(new Map([['dep', 'wasmer/bash@*']]))]);
  assert.throws(() => assertSelfContained(withManifest(duplicate)), /Duplicate/);
  const manifest = readWebcManifest(hello);
  manifest.set('use', new cbor.Tagged(55799, new Map()));
  assert.throws(() => assertSelfContained(withManifest(cbor.encode(manifest))), /Invalid WEBC use/);
  manifest.set('use', null);
  assert.throws(() => assertSelfContained(withManifest(cbor.encode(manifest))), /Invalid WEBC use/);
  manifest.delete('use');
  let nested = [];
  for (let i = 0; i < 40; i++) nested = [nested];
  manifest.set('nested', nested);
  assert.throws(() => assertSelfContained(withManifest(cbor.encode(manifest))), /Maximum depth/);
  // Truncate the header/index/manifest; atom and volume validation is Wasmer's job.
  for (const offset of [0, 9, 17, 443, 847]) assert.throws(() => assertSelfContained(hello.subarray(0, offset)));
  const old = Buffer.from(hello); old[7] = 50;
  assert.throws(() => assertSelfContained(old), /WEBC v3/);
  const huge = Buffer.from(hello); huge.writeBigUInt64LE(2n ** 63n, 9);
  assert.throws(() => assertSelfContained(huge), /length/);
  for (const start of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => assertSelfContained(withManifest(cbor.encode(readWebcManifest(hello)), index => index.get('manifest').get('span').set('start', start))));
  }
  const truncated = Buffer.from(hello); truncated.writeBigUInt64LE(2n ** 63n, 444 + 33);
  assert.throws(() => assertSelfContained(truncated), /length/);
});

test('rejects command and filesystem references outside the container', () => {
  const manifest = readWebcManifest(hello);
  const command = [...manifest.get('commands').values()][0];
  command.get('annotations').get('atom').set('dependency', 'another-package');
  assert.throws(() => assertSelfContained(withManifest(cbor.encode(manifest))), /External command atom/);
  const fs = readWebcManifest(hello);
  fs.get('package').set('fs', [new Map([['from', 'another-package'], ['volume_name', '/data'], ['mount_path', '/data']])]);
  assert.throws(() => assertSelfContained(withManifest(cbor.encode(fs))), /External filesystem/);
});

test('the vendored engine retains the official npm WASM and bindings', async () => {
  const integrity = JSON.parse(await readFile(new URL('../patches/wasmer-sdk-0.19.1.integrity.json', import.meta.url), 'utf8'));
  let wasm = 0;
  for (const [file, sha256] of Object.entries(integrity.files)) {
    if (!file.startsWith('pkg/') || file.endsWith('.map')) continue;
    const original = await readFile(new URL('../node_modules/@wasmer/sdk/' + file, import.meta.url));
    assert.equal(hash(original).toString('hex'), sha256);
    const expected = /\.(?:js|ts)$/.test(file) ? Buffer.from(original.toString().replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/g, '\n')) : original;
    assert.deepEqual(await readFile(new URL('../dist/vendor/wasmer-sdk/' + file, import.meta.url)), expected, file);
    if (file.endsWith('.wasm')) wasm++;
  }
  assert.ok(wasm > 0);
});

// Keep the original atoms and volumes intact, append another manifest, and
// repoint the index. A scanner that trusts the first manifest would be bypassed.
function withManifest(payload, alter = () => {}) {
  const section = Buffer.alloc(41 + payload.length);
  section[0] = 1;
  hash(payload).copy(section, 1);
  section.writeBigUInt64LE(BigInt(payload.length), 33);
  payload.copy(section, 41);
  const length = Number(hello.readBigUInt64LE(9));
  const index = cbor.decodeFirstSync(hello.subarray(17, 17 + length), { extendedResults: true, preferMap: true }).value;
  const entry = index.get('manifest');
  entry.set('span', new Map([['start', hello.length], ['len', section.length]]));
  entry.get('checksum').set('value', hash(payload));
  alter(index);
  const encoded = cbor.encode(index);
  assert.ok(encoded.length <= length);
  const result = Buffer.concat([hello, section]);
  result.fill(0, 17, 17 + length);
  encoded.copy(result, 17);
  return result;
}
