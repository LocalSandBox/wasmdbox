import { readFile } from 'node:fs/promises';
import { assertSelfContained, digest } from './webc.js';
import { readBundledRuntime, type RuntimeResource } from './runtime-resource.js';

interface RuntimeLock {
  schemaVersion: number;
  runtime: RuntimeResource;
}

export async function bundledPackages(extraPkgs: readonly Uint8Array[] = []) {
  // Validate every extra before asking the upstream SDK to load anything.
  for (const [index, bytes] of extraPkgs.entries()) {
    try { assertSelfContained(bytes); }
    catch (error) { throw new Error(`Invalid extraPkgs[${index}]: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const root = new URL('../assets/', import.meta.url);
  const lock: RuntimeLock = JSON.parse(await readFile(new URL('runtime-lock.json', root), 'utf8'));
  if (lock.schemaVersion !== 2 || !lock.runtime?.chunks?.length) throw new Error('Unsupported bundled runtime manifest');
  const runtime = await readBundledRuntime(root, lock.runtime);
  assertSelfContained(runtime);
  const sources: Uint8Array[] = [runtime];
  const seen = new Set([lock.runtime.sha256]);
  for (const bytes of extraPkgs) {
    const hash = digest(bytes);
    if (seen.has(hash)) continue;
    seen.add(hash);
    sources.push(bytes);
  }
  return { sources, builtin: sources.map((_, index) => index === 0) };
}
