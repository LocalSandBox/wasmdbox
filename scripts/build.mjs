import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeSdk, projectRoot } from './vendor-sdk.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('wasmdbox requires Node.js 24 or newer');

await rm(join(projectRoot, 'dist'), { recursive: true, force: true });
// Public declaration imports can resolve the private SDK during compilation.
const sdk = await materializeSdk({ adapters: false });
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd: projectRoot, stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`TypeScript build failed (${signal ?? code})`)));
});
for (const name of ['node-host-filesystem', 'node-tcp-proxy']) {
  const source = await readFile(join(projectRoot, `dist/internal/${name}.js`), 'utf8');
  await writeFile(join(sdk.destination, `dist/${name}.js`), source.replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/g, '\n'));
}
await mkdir(join(projectRoot, 'dist/assets'), { recursive: true });
await copyFile(join(projectRoot, 'assets/edgejs-keepalive.cjs'), join(projectRoot, 'dist/assets/edgejs-keepalive.cjs'));
console.log(`Built wasmdbox with private Wasmer SDK ${sdk.sdk} (${sdk.edits} runtime edits); dependencies were not modified`);
