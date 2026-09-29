import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('./', import.meta.url);
const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{2}-/.test(entry.name))
  .map((entry) => entry.name + '/main.js').sort();
const failed = [];
const unsupported = [];

for (const file of files) {
  const windowsMount = process.platform === 'win32' && /^2[34]-host-mount-/.test(file);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, directory))], {
    stdio: windowsMount ? 'pipe' : 'inherit',
    timeout: 240_000,
  });
  if (windowsMount) {
    process.stdout.write(result.stdout ?? '');
    const stderr = result.stderr?.toString() ?? '';
    if (!result.error && result.status === 1 &&
        stderr.includes('SandboxError: Failed to prepare sandbox: This host mount adapter currently supports macOS and Linux')) {
      console.log('UNSUPPORTED: ' + file + ' (host mounts require Linux or macOS)');
      unsupported.push(file);
      continue;
    }
    process.stderr.write(stderr);
  }
  if (result.error || result.status !== 0) {
    console.error('FAIL: ' + file, result.error ?? result.signal ?? result.status);
    failed.push(file);
  }
}

console.log('\nCases: ' + (files.length - failed.length - unsupported.length) + '/' + files.length + ' passed' +
  (unsupported.length ? '; ' + unsupported.length + ' unsupported' : ''));
if (failed.length) {
  console.error('Failed: ' + failed.join(', '));
  process.exitCode = 1;
}
