import { isMainThread, workerData } from 'node:worker_threads';
if (!isMainThread && workerData?.mode === 'sandbox') {
 const sdk = await import('../../dist/vendor/wasmer-sdk/dist/node.js');
 if (process.env.WASMDBOX_CLOSE_PROBE === 'client-only') sdk.Sandbox.prototype.close = async () => {};
 if (process.env.WASMDBOX_CLOSE_PROBE === 'deferred') {
  const close = sdk.Sandbox.prototype.close;
  sdk.Sandbox.prototype.close = async function () { await new Promise(r=>setTimeout(r,100)); return close.call(this); };
 }
}
