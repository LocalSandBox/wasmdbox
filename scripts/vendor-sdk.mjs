import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replacements as mounts } from '../patches/wasmer-sdk-0.19.0.mjs';
import { replacements as network } from '../patches/wasmer-sdk-network-0.19.0.mjs';
import { replacements as workerFailures } from '../patches/wasmer-sdk-worker-failures-0.19.0.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const patchGroups = { mounts, network, workerFailures };
const manifest = JSON.parse(await readFile(new URL('../patches/wasmer-sdk-0.19.0.integrity.json', import.meta.url), 'utf8'));

/** Read only a byte-verified upstream package, never an already patched SDK. */
async function pristineSdk() {
  const candidates = process.env.WASMDBOX_SDK_SOURCE
    ? [resolve(process.env.WASMDBOX_SDK_SOURCE)]
    : [
        dirname(dirname(fileURLToPath(import.meta.resolve('@wasmer/sdk/node')))),
        join(projectRoot, '.artifacts/upstream/wasmer-sdk-0.19.0/package'),
      ];
  const errors = [];
  for (const directory of candidates) {
    try {
      const files = new Map();
      for (const [path, digest] of Object.entries(manifest.files)) {
        const bytes = await readFile(join(directory, path));
        if (createHash('sha256').update(bytes).digest('hex') !== digest) {
          throw new Error(`pristine SDK hash mismatch: ${path}`);
        }
        files.set(path, bytes);
      }
      return { directory, files };
    } catch (error) { errors.push(`${directory}: ${error.message}`); }
  }
  throw new Error(`A clean @wasmer/sdk@0.19.0 is required. Run npm ci --ignore-scripts, or set WASMDBOX_SDK_SOURCE to an extracted pristine package.\n${errors.join('\n')}`);
}

/** Build an isolated variant. This function never writes to node_modules. */
export async function materializeSdk({
  destination = join(projectRoot, 'dist/vendor/wasmer-sdk'),
  groups = Object.keys(patchGroups),
  omit = [],
  nodeOnly = true,
  adapters = true,
  adapterDirectory = join(projectRoot, 'dist/internal'),
} = {}) {
  const { directory, files } = await pristineSdk();
  const omitted = new Set(omit);
  const availableEdits = new Set();
  let edits = 0;
  for (const group of groups) {
    if (!(group in patchGroups)) throw new Error(`Unknown SDK patch group: ${group}`);
    for (const [path, replacements] of Object.entries(patchGroups[group])) {
      let source = files.get(path).toString('utf8');
      for (const [[before, after], index] of replacements.map((edit, index) => [edit, index])) {
        availableEdits.add(`${group}:${path}:${index}`);
        if (omitted.has(`${group}:${path}:${index}`)) continue;
        if (source.split(before).length !== 2) {
          throw new Error(`SDK patch anchor missing or ambiguous: ${group}:${path}:${index}`);
        }
        source = source.replace(before, after);
        edits++;
      }
      files.set(path, Buffer.from(source));
    }
  }
  for (const edit of omitted) {
    if (!availableEdits.has(edit)) throw new Error(`Unknown omitted SDK edit: ${edit}`);
  }
  // Validate and prepare everything before replacing the generated destination.
  if (adapters) {
    for (const name of ['node-host-filesystem', 'node-tcp-proxy']) {
      files.set(`dist/${name}.js`, await readFile(join(adapterDirectory, `${name}.js`)));
    }
  }
  await rm(destination, { recursive: true, force: true });
  for (const [path, input] of files) {
    if (nodeOnly && (/^dist\/(browser-worker|service-worker(?:-host)?|wisp-network)\./.test(path) || path.endsWith('.map'))) continue;
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    // Upstream source maps cannot describe our modified JS and ship no sources.
    const bytes = nodeOnly && /\.(?:js|ts)$/.test(path)
      ? Buffer.from(input.toString('utf8').replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/g, '\n'))
      : input;
    await writeFile(target, bytes);
  }
  return { sdk: manifest.version, source: directory, edits, destination };
}
