// Maintainer-only fixture rebuild; regular tests use the checked-in WEBC files.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const temporary = await mkdtemp(join(tmpdir(), 'wasmdbox-package-fixtures-'));
try {
  await copyFile(new URL('../../../examples/local-package/hello.rs', import.meta.url), join(temporary, 'hello.rs'));
  execFileSync(process.env.RUSTC ?? 'rustc', ['--edition=2021', '--target=wasm32-wasip1', '-C', 'opt-level=z', '-C', 'strip=symbols', '-C', 'panic=abort', 'hello.rs', '-o', 'hello.wasm'], { cwd: temporary, stdio: 'inherit' });
  const signature = `sha256:${createHash('sha256').update(await readFile(join(temporary, 'hello.wasm'))).digest('base64')}`;
  const manifestPath = fileURLToPath(new URL('./writer/Cargo.toml', import.meta.url));
  const targetDir = fileURLToPath(new URL('../../../.artifacts/fixture-writer', import.meta.url));
  execFileSync(process.env.CARGO ?? 'cargo', ['build', '--locked', '--manifest-path', manifestPath, '--target-dir', targetDir], { stdio: 'inherit' });
  for (const [name, command, dependency, identity, version = '1.0.0'] of [
    ['bash-shadow', 'bash'],
    ['local-dependency', 'local-dependency'],
    ['local-parent', 'local-parent', 'wasmdbox-tests/local-dependency'],
    ['wrong-version', 'local-dependency', undefined, 'wasmdbox-tests/local-dependency', '2.0.0'],
    ['builtin-override', 'bash', undefined, 'wasmer/bash', '1.0.99'],
  ]) {
    // The Wasmer CLI deliberately strips name/version from WEBC files. Write
    // an explicit wapm identity so named local dependencies are testable.
    const manifest = {
      package: { wapm: { name: identity ?? `wasmdbox-tests/${name}`, version, license: 'MIT' } },
      atoms: { hello: { kind: 'https://webc.org/kind/wasm', signature } },
      commands: { [command]: { runner: 'https://webc.org/runner/wasi', annotations: { atom: { name: 'hello' }, wasi: { atom: 'hello' } } } },
      entrypoint: command,
      ...(dependency ? { use: { [dependency]: `${dependency}@=1.0.0` } } : {}),
    };
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest));
    execFileSync(join(targetDir, 'debug', `fixture-writer${process.platform === 'win32' ? '.exe' : ''}`), [
      join(temporary, 'manifest.json'), join(temporary, 'hello.wasm'), fileURLToPath(new URL(`./${name}.webc`, import.meta.url)),
    ], { stdio: 'inherit' });
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
