import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { readBundledRuntime } from '../dist/internal/runtime-resource.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
test('runtime reader handles short reads and checks sizes, chunk hashes and ordered whole hash', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-runtime-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'runtime'));
  const parts = [Buffer.from('first chunk'), Buffer.from('second chunk')];
  const chunks = parts.map((bytes, index) => ({ file: `runtime/runtime-00${index + 1}.bin`, size: bytes.length, sha256: digest(bytes) }));
  for (const [index, chunk] of chunks.entries()) await writeFile(join(directory, chunk.file), parts[index]);
  const bytes = Buffer.concat(parts);
  const resource = { size: bytes.length, sha256: digest(bytes), chunks };
  const root = pathToFileURL(directory + sep);
  const read = (changes = {}) => readBundledRuntime(root, { ...resource, ...changes });
  const handle = await open(join(directory, chunks[0].file));
  const prototype = Object.getPrototypeOf(handle);
  const originalRead = prototype.read;
  await handle.close();
  // Actual files may return fewer bytes than requested; do not assume one read.
  t.mock.method(prototype, 'read', function (buffer, offset, length, position) {
    return originalRead.call(this, buffer, offset, Math.min(length, 3), position);
  });
  assert.deepEqual(await read(), bytes);
  await assert.rejects(read({ chunks: [...chunks].reverse() }), /integrity.*runtime.webc/);
  await assert.rejects(read({ size: resource.size + 1 }), /Invalid bundled runtime size/);
  await assert.rejects(read({ chunks: [chunks[0], chunks[0]] }), /Invalid bundled runtime chunk path/);
  await writeFile(join(directory, chunks[0].file), Buffer.alloc(parts[0].length));
  await assert.rejects(read(), /integrity.*runtime-001/);
  await writeFile(join(directory, chunks[0].file), parts[0].subarray(1));
  await assert.rejects(read(), /integrity.*runtime-001/);
  await writeFile(join(directory, chunks[0].file), Buffer.concat([parts[0], Buffer.from('extra')]));
  await assert.rejects(read(), /integrity.*runtime-001/);
  await rm(join(directory, chunks[0].file));
  await assert.rejects(read(), /Cannot read bundled runtime chunk/);
});
