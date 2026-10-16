// Test-only ordering trace. Never log command arguments, environment or data.
import workers, { isMainThread, threadId, workerData } from 'node:worker_threads';
import { appendFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const report = process.env.WASMDBOX_RUNTIME_ORDER_REPORT;
if (report) {
  const record = event => appendFileSync(report, JSON.stringify({ time: Date.now(), pid: process.pid, threadId, ...event }) + '\n');
  const Worker = workers.Worker;
  workers.Worker = class extends Worker {
    constructor(url, options) {
      const profileDirectory = process.env.WASMDBOX_RUNTIME_CPU_DIRECTORY;
      super(url, profileDirectory ? {
        ...options,
        execArgv: [...(options?.execArgv ?? process.execArgv), '--cpu-prof', `--cpu-prof-dir=${profileDirectory}`],
      } : options);
      const id = this.threadId;
      record({ event: 'worker-created', worker: id, name: options?.name });
      this.on('message', message => record({ event: 'worker-message', worker: id, type: message?.type, nestedType: message?.msg?.type }));
      if (isMainThread && process.env.WASMDBOX_RUNTIME_PROFILE === '1') {
        this.once('message', () => {
          void this.startCpuProfile().then(profile => {
            setTimeout(async () => {
              try {
                record({ event: 'worker-cpu', worker: id, usage: await this.cpuUsage() });
                const output = await profile.stop();
                writeFileSync(`${report}.${id}.cpuprofile`, typeof output === 'string' ? output : JSON.stringify(output));
              } catch (error) { record({ event: 'profile-error', worker: id, message: String(error) }); }
            }, 3000).unref();
          }).catch(error => record({ event: 'profile-error', worker: id, message: String(error) }));
        });
      }
      this.on('exit', code => record({ event: 'worker-exit', worker: id, code }));
      this.on('error', error => record({ event: 'worker-error', worker: id, name: error.name, message: error.message, stack: error.stack }));
    }
    terminate() {
      record({ event: 'worker-terminate', worker: this.threadId });
      return super.terminate();
    }
    postMessage(message, ...args) {
      record({ event: 'worker-post', worker: this.threadId, type: message?.type, id: message?.id });
      return super.postMessage(message, ...args);
    }
  };
  syncBuiltinESMExports();
  if (!isMainThread && workerData && Object.hasOwn(workerData, 'runtimeDirectory')) {
    const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
    for (const [Class, method] of [[sdk.Command, 'spawn'], [sdk.Process, 'kill'], [sdk.Process, 'wait'], [sdk.Wasmer, 'terminateOwnedRuntime']]) {
      const original = Class.prototype[method];
      Class.prototype[method] = async function (...args) {
        record({ event: 'operation', operation: `${Class.name}.${method}`, phase: 'start', process: Class === sdk.Process ? this.id : undefined });
        try { return await original.apply(this, args); }
        finally { record({ event: 'operation', operation: `${Class.name}.${method}`, phase: 'end', process: Class === sdk.Process ? this.id : undefined }); }
      };
    }
  }
}
