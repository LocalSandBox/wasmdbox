/** Synchronous guest-to-host bridge. Only readDir can retry an oversized reply. */
export const HOST_FS_MESSAGE = 'wasmer-filesystem-rpc';
const RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const HEADER_BYTES = 8;
const TIMEOUT_MS = 30_000;
interface Request {
  type: string;
  mount: number;
  method: string;
  args: unknown;
  response: SharedArrayBuffer;
  binary?: boolean;
}
export function isHostFileSystemRequest(value: unknown): value is Request {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === HOST_FS_MESSAGE;
}
/** The client also performs synchronous WASM filesystem calls during start/cwd. */
export function installHostFileSystemClientBridge(dispatch: (mount: unknown, method: unknown, args: unknown) => unknown) {
  (globalThis as unknown as { __wasmerHostFileSystem: typeof dispatch }).__wasmerHostFileSystem = dispatch;
}
export function installHostFileSystemWorkerBridge(route?: (request: Request) => boolean) {
  let responseBuffer: SharedArrayBuffer | undefined;
  const scope = globalThis as unknown as {
    window?: unknown;
    postMessage(message: unknown): void;
    __wasmerHandleFileSystemRpc: (message: unknown) => boolean;
    __wasmerHostFileSystem: (mount: number, method: string, args: unknown) => unknown;
  };
  scope.__wasmerHandleFileSystemRpc = message => {
    if (!isHostFileSystemRequest(message)) return false;
    if (!route?.(message)) scope.postMessage(message);
    return true;
  };
  scope.__wasmerHostFileSystem = (mount, method, args) => {
    if (scope.window !== undefined) throw new Error('Native filesystem calls require a worker');
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const response = responseBuffer ??= new SharedArrayBuffer(RESPONSE_BYTES);
      const control = new Int32Array(response, 0, 2);
      control.fill(0);
      const request = { type: HOST_FS_MESSAGE, mount, method, args, response, binary: true };
      if (!route?.(request)) scope.postMessage(request);
      while (Atomics.load(control, 0) === 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || Atomics.wait(control, 0, 0, remaining) === 'timed-out') {
          // The timed-out host operation can still own and write its old buffer.
          responseBuffer = undefined;
          throw Object.assign(new Error(`Native filesystem ${method} timed out`), { code: 'ETIMEDOUT' });
        }
      }
      const bytes = new Uint8Array(response, HEADER_BYTES, control[1]).slice();
      if (Atomics.load(control, 0) === 2) return bytes;
      const result = JSON.parse(new TextDecoder().decode(bytes));
      if (method === 'readDir' && result.error?.code === 'ENOBUFS' &&
          Number.isSafeInteger(result.requiredBytes) && result.requiredBytes > response.byteLength && result.requiredBytes <= MAX_RESPONSE_BYTES) {
        responseBuffer = new SharedArrayBuffer(Math.min(MAX_RESPONSE_BYTES, Math.max(response.byteLength * 2, result.requiredBytes)));
        continue;
      }
      if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    }
  };
}
/** Oversize errors wake the worker too; mutating operations are never retried. */
export function respondToHostFileSystem(request: Request, result: { value?: unknown; error?: unknown }) {
  const control = new Int32Array(request.response, 0, 2);
  const value = result.value;
  let binary = request.binary === true && !result.error && value instanceof Uint8Array;
  let bytes = binary ? value as Uint8Array : new TextEncoder().encode(JSON.stringify(value instanceof Uint8Array ? { ...result, value: Array.from(value) } : result));
  const requiredBytes = bytes.length + HEADER_BYTES;
  if (requiredBytes > request.response.byteLength) {
    binary = false;
    const retry = request.method === 'readDir' && requiredBytes <= MAX_RESPONSE_BYTES;
    bytes = new TextEncoder().encode(JSON.stringify({
      error: { code: retry ? 'ENOBUFS' : 'EOVERFLOW', message: retry ? 'Host directory response requires a larger buffer' : 'Host filesystem response exceeds the 32 MiB bridge limit or cannot be retried' },
      ...(retry ? { requiredBytes } : {}),
    }));
  }
  new Uint8Array(request.response, HEADER_BYTES, bytes.length).set(bytes);
  control[1] = bytes.length;
  Atomics.store(control, 0, binary ? 2 : 1);
  Atomics.notify(control, 0);
}
