// A private SDK copy runs inside each wasmdbox worker. Forward nested worker
// failures to that owner without replacing the SDK's own error handling.
export const replacements = {
  'dist/node-worker-adapter.js': [
    ['let workerFailures = 0;', `let workerFailures = 0;
const failureListeners = new Set();
export function subscribeWorkerFailures(listener) {
    failureListeners.add(listener);
    return () => { failureListeners.delete(listener); };
}`],
    ['        workerFailures += 1;', `        workerFailures += 1;
        for (const listener of failureListeners) {
            try { listener(error); }
            catch { /* Observers must not interrupt SDK failure propagation. */ }
        }`],
  ],
};
