// Rebuild the checked-in WEBC fixture; normal examples/tests need no toolchain.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-local-package-'));
try {
  for (const file of ['hello.rs', 'wasmer.toml']) {
    await copyFile(new URL(file, import.meta.url), join(directory, file));
  }
  execFileSync('rustc', [
    '--edition=2021', '--target=wasm32-wasip1', '-C', 'opt-level=z',
    '-C', 'strip=symbols', '-C', 'panic=abort', 'hello.rs', '-o', 'hello.wasm',
  ], { cwd: directory, stdio: 'inherit' });
  execFileSync('wasmer', ['package', 'build', directory, '--out', join(directory, 'hello.webc')], { stdio: 'inherit' });
  await copyFile(join(directory, 'hello.webc'), new URL('./hello.webc', import.meta.url));
  console.log(`Built ${fileURLToPath(new URL('./hello.webc', import.meta.url))}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
