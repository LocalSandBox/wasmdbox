import assert from 'node:assert/strict';
import { setEnvironmentData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const count = new SharedArrayBuffer(4);
setEnvironmentData('wasmdbox:host-traps', count);
const directory = process.argv[2] ?? 'dist/vendor/wasmer-sdk';
const { Wasmer } = await import(pathToFileURL(resolve(directory, 'dist/node.js')));
const wasmer = await Wasmer.create({ cache: false });
// (module (import "wasi_snapshot_preview1" "proc_exit" (func (param i32)))
//   (memory (export "memory") 1) (func (export "_start")
//     (try (do (call 0 (i32.const 7)))
//       (catch_all (call 0 (i32.const 8))))))
// The second proc_exit must be unreachable: host exits are not guest errors.
const name = value => [value.length, ...Buffer.from(value)];
const section = (id, bytes) => [id, bytes.length, ...bytes];
const module = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [2, 96, 1, 127, 0, 96, 0, 0]),
  ...section(2, [1, ...name('wasi_snapshot_preview1'), ...name('proc_exit'), 0, 0]),
  ...section(3, [1, 1]),
  ...section(5, [1, 0, 1]),
  ...section(7, [2, ...name('memory'), 2, 0, ...name('_start'), 0, 1]),
  ...section(10, [1, 14, 0, 6, 64, 65, 7, 16, 0, 25, 65, 8, 16, 0, 11, 11]),
]);
try {
  const sandbox = await wasmer.sandboxes.create({ packages: [module] });
  const output = await sandbox.command('main').run({ check: false });
  assert.equal(output.exitCode, 7);
  await sandbox.close();
} finally {
  await wasmer.close();
}
assert.equal(Atomics.load(new Int32Array(count), 0), 1, 'guest intercepted WASIX exit');
console.log('PASS: WASIX exit bypassed guest catch_all');
