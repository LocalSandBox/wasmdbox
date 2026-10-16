# Host traps and cancellation in Wasmer 0.19.1

The synchronous JS backend represents WASIX exits as ordinary JavaScript
`Trap` objects. A guest WebAssembly `catch_all` can catch them. This is incorrect
for host control flow such as `proc_exit` or forced cancellation: execution must
leave the guest and return to Wasmer.

The failure observed during cancellation follows this chain:

1. `Process.kill()` marks the WASIX process finished. `wait()` can return before
   the executing worker has unwound.
2. The next WASIX checkpoint raises an exit through
   `wasmer::backend::js::error::raise` and `wasm_bindgen::throw_val`.
3. The binding throws the `Trap` as a JavaScript object. Guest exception
   handling can catch it and call back into the terminating runtime.
4. EdgeJS can repeatedly raise further exit traps from its exception cleanup.
   An instrumented copy showed successive SDK stack-pointer decreases of 176
   bytes during this recursion. The stack can overrun its allocation and
   damage the shared heap.
5. Subsequent work then traps in the allocator or spins on its lock. Thus the
   allocator stack in a CPU profile identifies the symptom, not the initial
   error. Raising the next-command readiness timeout cannot fix it.

The same cancellation failure was reproduced with the unmodified official
`@wasmer/sdk@0.19.1`, local package bytes and no Wasmdbox mount/network patches.
A Linux amd64 container on an M4 is useful for reproduction but is emulated.
The separate real Windows diagnostic run
[38943744730](https://github.com/LocalSandBox/wasmdbox/actions/runs/38943744730)
also failed after cancellation with allocator memory access out of bounds.
The first unrelated proxy-test child-process exit has no captured matching
stack, so this analysis does not establish its cause.

## Binding repair

`wasmer-host-traps.ts` wraps the SDK's two synchronous guest apply imports.
For a genuine Wasmer `Trap`, it retains the original object in the current
synchronous call frame and executes a tiny WebAssembly `unreachable` function.
An actual engine trap bypasses guest exception handlers. At the surrounding
JavaScript call boundary, the original Wasmer object is rethrown to the SDK's
existing error handler. Rust still owns its exit code and object lifetime.

The frame is restored in `finally`, is local to each worker, supports nested
calls, and is not retained across asynchronous returns. Ordinary JavaScript
and guest exceptions keep their existing semantics. Calls outside a wrapped
synchronous boundary keep the original throw behavior.

The official Wasmer WASM binary is byte-for-byte unchanged. No allocator locks
or stack pointers are reset; no Rust build or experimental V8 flags are needed.
Four checked binding replacements and one small JS adapter implement the repair.

## Reproduction and regression

`tests/fixtures/host-trap-probe.mjs` contains a tiny guest equivalent to:

```wat
(try
  (do (call $proc_exit (i32.const 7)))
  (catch_all (call $proc_exit (i32.const 8))))
```

The second exit must never run. A test-only observer counts actual Wasmer
traps inside the worker and fails if the guest catches the first one.
This deterministically fails with stock SDK bindings and passes with the
repair, including on macOS where the original timing-sensitive stress often
passed. `npm run test:ablation -- no-host-traps` checks the removed-patch control.

`tests/host-traps.test.mjs` also verifies exception identity, nesting, normal
returns, ordinary guest catches and asynchronous frame cleanup.
`tests/cancellation.test.mjs` runs 20 cold cancel/reuse cycles and asserts that
host writes stop after each cancellation. The manual diagnostic workflow runs
100 cycles on real Linux and Windows runners and retains worker traces.
The existing lifecycle, output, timeout, host-mount and package validation
tests remain required.
