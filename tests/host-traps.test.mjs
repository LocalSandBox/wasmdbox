import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { callWithHostTrap, raiseHostTrap } from '../dist/internal/wasmer-host-traps.js';

// (module (import "host" "stop" (func))
//   (func (export "run") (result i32)
//     (try (result i32) (do (call 0) (i32.const 0))
//       (catch_all (i32.const 1)))))
const catchesHostExceptions = new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 8, 2, 96, 0, 0, 96, 0, 1, 127,
  2, 13, 1, 4, 104, 111, 115, 116, 4, 115, 116, 111, 112, 0, 0,
  3, 2, 1, 1, 7, 7, 1, 3, 114, 117, 110, 0, 1,
  10, 14, 1, 12, 0, 6, 127, 16, 0, 65, 0, 25, 65, 1, 11, 11,
]));
const guest = stop => new WebAssembly.Instance(catchesHostExceptions, { host: { stop } }).exports.run;

test('a guest catch_all can catch a JS exception but cannot catch a host control trap', () => {
  const original = { exitCode: 137 };
  assert.equal(guest(() => { throw original; })(), 1, 'unmodified Wasmer trap enters guest catch_all');
  assert.throws(() => callWithHostTrap(guest(() => raiseHostTrap(original)), undefined, []), error => error === original);
  assert.equal(callWithHostTrap(guest(() => {}), undefined, []), 0);
});

test('ordinary exceptions and return values keep their semantics', () => {
  const error = new Error('ordinary JS exception');
  assert.equal(callWithHostTrap(guest(() => { throw error; }), undefined, []), 1);
  assert.throws(() => callWithHostTrap(() => { throw error; }, undefined, []), value => value === error);
  assert.equal(callWithHostTrap(function (amount) { return this.base + amount; }, { base: 40 }, [2]), 42);
  assert.throws(() => raiseHostTrap(error), value => value === error);
});

test('nested calls restore their own trap state and do not poison subsequent calls', () => {
  const inner = {}, outer = {};
  assert.throws(() => callWithHostTrap(() => {
    assert.throws(() => callWithHostTrap(guest(() => raiseHostTrap(inner)), undefined, []), error => error === inner);
    raiseHostTrap(outer);
  }, undefined, []), error => error === outer);
  assert.equal(callWithHostTrap(() => 7, undefined, []), 7);
});

test('a JS intermediary cannot convert a host trap into success', () => {
  const original = {};
  assert.throws(() => callWithHostTrap(() => {
    try { raiseHostTrap(original); } catch { return 0; }
  }, undefined, []), error => error === original);
});

test('returned promises do not retain a synchronous trap frame', async () => {
  const original = {};
  const pending = callWithHostTrap(async () => {
    await Promise.resolve();
    raiseHostTrap(original);
  }, undefined, []);
  assert.equal(callWithHostTrap(() => 9, undefined, []), 9);
  await assert.rejects(pending, error => error === original);
});

test('JSPI returns the original host trap through its Promise without an unhandled rejection', {
  skip: typeof WebAssembly.promising !== 'function',
}, async () => {
  const original = { exitCode: 7 };
  const pending = callWithHostTrap(WebAssembly.promising(guest(() => raiseHostTrap(original))), undefined, []);
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, error => error === original);
  assert.equal(await callWithHostTrap(WebAssembly.promising(guest(() => {})), undefined, []), 0);
});

test('the actual SDK preserves proc_exit across a guest exception handler', { timeout: 30_000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    typeof WebAssembly.promising === 'function' ? '--experimental-wasm-jspi' : '--no-experimental-wasm-jspi',
    fileURLToPath(new URL('../scripts/ablation-probe.mjs', import.meta.url)),
    fileURLToPath(new URL('../dist/vendor/wasmer-sdk', import.meta.url)), 'host-traps',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 25_000 });
  assert.deepEqual(JSON.parse(stdout), { probe: 'host-traps', passed: true });
});
