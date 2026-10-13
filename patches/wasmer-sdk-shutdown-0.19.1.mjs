// Each wasmdbox supervisor owns one Wasmer client. For active commands, stop
// and await its Node workers before releasing native resources, then the parent
// destroys the supervisor (and its WASM memory). Wasmer 0.19.1's cooperative
// Process.kill()/core shutdown can race while unwinding a running WASIX guest.
export const replacements = {
  'dist/node-worker-adapter.js': [
    ['let activeWorkers = 0;', `let activeWorkers = 0;
const liveWorkers = new Set();
let shuttingDown = false;
export async function terminateNodeWorkers() {
    shuttingDown = true;
    await Promise.all([...liveWorkers].map(worker => worker.terminate()));
}`],
    ['    #terminating = false;', '    #terminating = false;\n    #termination;'],
    ['    constructor(url, options = {}) {', `    constructor(url, options = {}) {
        if (shuttingDown) throw new Error("Wasmer worker owner is closing");
`],
    ['        workersCreated += 1;', '        workersCreated += 1;\n        liveWorkers.add(this);'],
    ['            activeWorkers -= 1;', '            activeWorkers -= 1;\n            liveWorkers.delete(this);'],
    ['        void this.#worker.terminate();', '        return this.#termination ??= this.#worker.terminate();'],
  ],
  'dist/node.js': [
    ['import { NodeWorkerAdapter } from "./node-worker-adapter.js";', 'import { NodeWorkerAdapter, terminateNodeWorkers } from "./node-worker-adapter.js";'],
    ['    async closeCore(client) {', `    // Internal owner-only disposal. The supervisor is destroyed immediately
    // afterwards; this method does not leave a reusable Wasmer/WASM instance.
    async terminateOwnedRuntime() {
        const client = await this.getCore();
        await terminateNodeWorkers();
        try { closeHostMounts(client); }
        finally {
            nodeNetworks.get(client)?.close();
            nodeNetworks.delete(client);
            nodeCaches.get(client)?.close();
            nodeCaches.delete(client);
        }
    }
    async closeCore(client) {`],
  ],
};
