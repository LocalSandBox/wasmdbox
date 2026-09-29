import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('./', import.meta.url);
// These examples have separate entry points because they load extra packages or
// download an npm archive. Keep the default batch limited to the local cases.
const optionalExamples = new Set(['prepare', 'extra-packages', 'package-install']);
const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !optionalExamples.has(entry.name))
  .map((entry) => entry.name + '/main.js').sort();
const failed = [];

for (const file of files) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, directory))], {
    stdio: 'inherit',
    timeout: 240_000,
  });
  if (result.error || result.status !== 0) {
    console.error('FAIL: ' + file, result.error ?? result.signal ?? result.status);
    failed.push(file);
  }
}

console.log('\nCases: ' + (files.length - failed.length) + '/' + files.length + ' passed');
if (failed.length) {
  console.error('Failed: ' + failed.join(', '));
  process.exitCode = 1;
}
