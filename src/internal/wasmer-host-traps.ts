// Wasmer's synchronous JS backend throws its Trap as an ordinary JS object.
// A guest catch_all can catch that object, including process exit/cancellation,
// and re-enter WASIX while it is terminating. EdgeJS's exception cleanup can
// then recursively raise more exit traps and overrun the SDK's linear stack.
// Use an actual WebAssembly trap to cross the guest, then return the original
// Wasmer object to its Rust caller (which owns the exit code and its lifetime).
// The official Wasmer WASM stays unchanged. This tiny module is only:
// (module (func (export "trap") unreachable))
const trap = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
  7, 8, 1, 4, 116, 114, 97, 112, 0, 0,
  10, 5, 1, 3, 0, 0, 11,
]))).exports.trap as () => never;

type TrapFrame = { raised: boolean; error?: unknown };
let current: TrapFrame | undefined;

/** Only the SDK binding's Wasmer Trap branch calls this function. */
export function raiseHostTrap(error: unknown): never {
  if (!current) throw error;
  current.raised = true;
  current.error = error;
  return trap();
}

/** A synchronous boundary; no state is retained across a returned Promise. */
export function callWithHostTrap(fn: Function, receiver: unknown, args: unknown[]): unknown {
  const previous = current;
  const frame: TrapFrame = { raised: false };
  current = frame;
  try {
    const result: unknown = Reflect.apply(fn, receiver, args);
    // A JS intermediary may catch engine errors; it still cannot turn a host
    // termination into success. Ordinary guest exceptions are left alone.
    if (frame.raised) throw frame.error;
    return result;
  } catch (error) {
    throw frame.raised ? frame.error : error;
  } finally {
    current = previous;
  }
}
