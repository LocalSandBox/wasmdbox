import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { SecretReplacer, replaceSecrets } from '../dist/internal/secret-replacer.js';

const token = () => Buffer.from(`sandbox-${randomBytes(60).toString('hex')}`);
const collect = async stream => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test('binary replacement spans every possible token split and preserves surrounding bytes', async () => {
  const key = token();
  const value = Buffer.from('secret-world-🌍');
  const prefix = Buffer.from([255, 0, 195]);
  const suffix = Buffer.from([128, 10, 0, 254]);
  for (let split = 1; split < key.length; split++) {
    const replacement = new SecretReplacer([{ token: key, value }]);
    const output = collect(replacement);
    replacement.write(Buffer.concat([prefix, key.subarray(0, split)]));
    replacement.end(Buffer.concat([key.subarray(split), suffix]));
    assert.deepEqual(await output, Buffer.concat([prefix, value, suffix]), `split ${split}`);
  }
});

test('replacement is simultaneous and never recursively scans inserted values', async () => {
  const first = token();
  const second = token();
  const replacements = [{ token: first, value: second }, { token: second, value: Buffer.from('real') }];
  const input = Buffer.concat([first, second, first, Buffer.from('!')]);
  const expected = Buffer.concat([second, Buffer.from('real'), second, Buffer.from('!')]);
  assert.deepEqual(replaceSecrets(input, replacements), expected);
  const stream = new SecretReplacer(replacements);
  const output = collect(stream);
  for (const byte of input) stream.write(Buffer.from([byte]));
  stream.end();
  assert.deepEqual(await output, expected);
});

test('only literal tokens are scanned; near matches, base64 and arbitrary binary pass unchanged', () => {
  const key = token();
  const input = Buffer.concat([
    key.subarray(1), Buffer.from(' '), Buffer.from(key.toString('base64')),
    Buffer.from([0, 255, 128]), key.subarray(0, 127), Buffer.from('X'),
  ]);
  assert.deepEqual(replaceSecrets(input, [{ token: key, value: Buffer.from('secret') }]), input);
  assert.equal(replaceSecrets(Buffer.concat([key, key]), [{ token: key, value: Buffer.alloc(0) }]).length, 0);
});

test('a streaming transform retains at most 127 bytes until the next chunk', async () => {
  const stream = new SecretReplacer([{ token: token(), value: Buffer.from('secret') }]);
  const input = Buffer.alloc(1024 * 1024, 173);
  stream.write(input);
  assert.equal(stream.readableLength, input.length - 127);
  const first = stream.read();
  stream.end();
  assert.deepEqual(Buffer.concat([first, await collect(stream)]), input);
  assert.throws(() => new SecretReplacer([{ token: Buffer.from('short'), value: Buffer.alloc(0) }]), /128/);
});
