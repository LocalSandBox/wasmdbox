import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

interface Resource { size: number; sha256: string }
export interface RuntimeResource extends Resource { chunks: (Resource & { file: string })[] }

/** Shared by runtime loading and maintainer verification; allocates one payload buffer. */
export async function readBundledRuntime(root: URL, resource: RuntimeResource): Promise<Buffer> {
  const paths = new Set<string>();
  let size = 0;
  for (const chunk of resource.chunks) {
    if (!/^runtime\/runtime-\d{3}\.bin$/.test(chunk.file) || paths.has(chunk.file)) throw new Error('Invalid bundled runtime chunk path');
    if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0) throw new Error('Invalid bundled runtime chunk size');
    paths.add(chunk.file);
    size += chunk.size;
  }
  if (!Number.isSafeInteger(resource.size) || resource.size <= 0 || size !== resource.size) throw new Error('Invalid bundled runtime size');
  const bytes = Buffer.allocUnsafe(resource.size);
  const hash = createHash('sha256');
  let offset = 0;
  for (const chunk of resource.chunks) {
    let file;
    try { file = await open(new URL(chunk.file, root), 'r'); }
    catch { throw new Error(`Cannot read bundled runtime chunk ${chunk.file}`); }
    try {
      if ((await file.stat()).size !== chunk.size) integrityFailure(chunk.file);
      const chunkHash = createHash('sha256');
      let position = 0;
      while (position < chunk.size) {
        const { bytesRead } = await file.read(bytes, offset, Math.min(1024 * 1024, chunk.size - position), position);
        if (!bytesRead) integrityFailure(chunk.file);
        const part = bytes.subarray(offset, offset + bytesRead);
        chunkHash.update(part);
        hash.update(part);
        position += bytesRead;
        offset += bytesRead;
      }
      if ((await file.stat()).size !== chunk.size || chunkHash.digest('hex') !== chunk.sha256) integrityFailure(chunk.file);
    } finally { await file.close(); }
  }
  if (hash.digest('hex') !== resource.sha256) integrityFailure('runtime.webc');
  return bytes;
}

function integrityFailure(name: string): never { throw new Error(`Bundled runtime integrity check failed: ${name}`); }
