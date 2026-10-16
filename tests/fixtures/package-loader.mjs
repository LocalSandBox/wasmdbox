// Test-only observation and fault injection inside each supervisor worker.
import { isMainThread, workerData } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import './package-consumer/block-fetch.mjs';

const report = process.env.WASMDBOX_PACKAGE_REPORT;
if (!isMainThread && workerData && Object.hasOwn(workerData, 'runtimeDirectory') && report) {
  const fault = process.env.WASMDBOX_PACKAGE_FAULT;
  const record = event => appendFileSync(report, JSON.stringify(event) + '\n');
  record({ type: 'worker' });
  const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
  const uninitialized = new sdk.Wasmer();
  const packages = Object.getPrototypeOf(uninitialized.packages);
  const loadMany = packages.loadMany;
  packages.loadMany = async function (sources, options) {
    const references = sources.filter(source => typeof source === 'string');
    record({ type: 'load', sources: references, bytes: sources.filter(source => source instanceof Uint8Array).map(source => ({
      length: source.byteLength, offset: source.byteOffset, bufferLength: source.buffer.byteLength,
      sha256: createHash('sha256').update(source).digest('hex'),
    })) });
    if (fault === 'stalled-load') {
      setInterval(() => record({ type: 'tick' }), 20);
      return new Promise(() => {});
    }
    const loaded = await loadMany.call(this, sources, options);
    record({ type: 'loaded', ids: loaded.map(pkg => pkg.id) });
    return loaded;
  };

  const sandboxes = Object.getPrototypeOf(uninitialized.sandboxes);
  const create = sandboxes.create;
  sandboxes.create = function (options) {
    record({ type: 'sandbox', ids: options.packages.map(pkg => pkg.id) });
    if (process.env.WASMDBOX_FORBID_SANDBOX) throw new Error('Sandbox creation is forbidden by this test');
    return create.call(this, options);
  };
  if (fault === 'close-failure') {
    sdk.Wasmer.prototype.close = async () => { throw new Error('Injected client close failure'); };
  }
}
