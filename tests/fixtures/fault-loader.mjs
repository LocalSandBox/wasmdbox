// Test-only fault injection into the supervisor realm. No production switches.
import workers, { isMainThread, workerData, parentPort } from 'node:worker_threads';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const mode = !isMainThread && workerData?.env?.WASMDBOX_TEST_FAULT;
if (mode === 'runtime-error') {
  const NativeWorker = workers.Worker;
  let injected = false;
  workers.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (!injected && String(url).endsWith('/node-worker.js')) {
        injected = true;
        setTimeout(() => this.emit('error', new Error('injected underlying runtime failure')), 100);
      }
    }
  };
  syncBuiltinESMExports();
}
if (['stalled-command', 'startup-failure', 'close-failure'].includes(mode)) {
  const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
  if (mode === 'stalled-command') sdk.Sandbox.prototype.command = () => ({ spawn: () => new Promise(() => {}) });
  if (mode === 'close-failure') sdk.Wasmer.prototype.close = async () => { throw new Error('injected close failure'); };
  if (mode === 'startup-failure') {
    const core = await import('../../dist/vendor/wasmer-sdk/pkg/wasmer_sdk_js.js');
    core.SandboxBuilderCore.prototype.start = function () { this.free(); throw new Error('injected core startup failure'); };
  }
}
if (mode === 'invalid-protocol' || mode === 'unexpected-exit') {
  parentPort.once('message', () => {
    if (mode === 'unexpected-exit') process.exit(1);
    parentPort.postMessage({ type: 'not-a-valid-protocol-message' });
  });
}
if (mode === 'proxy-failure') {
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    parentPort.once('message', () => this.emit('error', new Error('injected proxy listener failure')));
    return originalListen.apply(this, args);
  };
}
