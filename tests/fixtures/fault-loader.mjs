// Test-only fault injection into the supervisor realm. No production switches.
import workers, { isMainThread, workerData, parentPort } from 'node:worker_threads';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, writeFileSync } from 'node:fs';

const mode = !isMainThread && workerData?.env?.WASMDBOX_TEST_FAULT;
if (mode === 'spawn-close-race') {
  const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
  const report = workerData.env.WASMDBOX_TEST_WAIT_REPORT;
  let release;
  let disposing = false;
  const resumed = new Promise(resolve => { release = resolve; });
  const command = sdk.Sandbox.prototype.command;
  sdk.Sandbox.prototype.command = function (...args) {
    const builder = command.apply(this, args);
    const spawn = builder.spawn;
    builder.spawn = async function (...options) {
      const process = await spawn.apply(this, options);
      writeFileSync(report, 'spawn-pending\n');
      await resumed;
      return process;
    };
    return builder;
  };
  const terminate = sdk.Wasmer.prototype.terminateOwnedRuntime;
  sdk.Wasmer.prototype.terminateOwnedRuntime = async function (...args) {
    disposing = true;
    release();
    // Let the pending spawn continuation run during the ownership handoff.
    await new Promise(resolve => setImmediate(resolve));
    return terminate.apply(this, args);
  };
  for (const method of ['kill', 'wait']) {
    const original = sdk.Process.prototype[method];
    sdk.Process.prototype[method] = function (...args) {
      if (disposing) {
        appendFileSync(report, `${method}-during-dispose\n`);
        return new Promise(() => {});
      }
      return original.apply(this, args);
    };
  }
}
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
if (['stalled-command', 'startup-failure', 'close-failure', 'active-close-failure'].includes(mode)) {
  const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
  if (mode === 'stalled-command') sdk.Sandbox.prototype.command = () => ({ spawn: () => new Promise(() => {}) });
  if (mode === 'close-failure') sdk.Wasmer.prototype.close = async () => { throw new Error('injected close failure'); };
  if (mode === 'active-close-failure') sdk.Wasmer.prototype.terminateOwnedRuntime = async () => { throw new Error('injected active close failure'); };
  if (mode === 'startup-failure') {
    const core = await import('../../dist/vendor/wasmer-sdk/pkg/wasmer_sdk_js.js');
    core.SandboxBuilderCore.prototype.start = function () { this.free(); throw new Error('injected core startup failure'); };
  }
}
if (mode === 'stalled-output') {
  const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
  sdk.ReadableBytes.prototype[Symbol.asyncIterator] = async function* () {
    await new Promise(() => {});
  };
  const wait = sdk.Process.prototype.wait;
  sdk.Process.prototype.wait = async function (...args) {
    const output = await wait.apply(this, args);
    if (workerData.env.WASMDBOX_TEST_WAIT_REPORT) writeFileSync(workerData.env.WASMDBOX_TEST_WAIT_REPORT, 'finished');
    return output;
  };
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
