// Exact replacement anchors make this patch repeatable and fail on SDK drift.
// Only the JS integration layer is changed; the distributed WASM is untouched.
// wasmdbox owns one client per sandbox. Its client shutdown owns mount cleanup,
// including failed startup; a second per-Sandbox lease owner is unnecessary.
export const replacements = {
  'dist/index.js': [
    ['            const core = await rethrow(builder.start());\n            return new Sandbox(this, core, options.shell, networkBridge);', `            if (options.mounts !== undefined) {
                const hostMounts = this.constructor.prepareHostMounts(client, options.mounts);
                for (const mount of hostMounts.mounts) {
                    builder.mountHost(mount.guestPath, mount.id, mount.readOnly);
                }
            }
            const core = await rethrow(builder.start());
            return new Sandbox(this, core, options.shell, networkBridge);`],
  ],
  'dist/node.js': [
    ['import { NodeWorkerAdapter } from "./node-worker-adapter.js";', `import { NodeWorkerAdapter } from "./node-worker-adapter.js";
import { registerHostMounts, closeHostMounts } from "./node-host-filesystem.js";`],
    ['export class Wasmer extends BrowserWasmer {', `export class Wasmer extends BrowserWasmer {
    static prepareHostMounts(client, mounts) {
        return registerHostMounts(client, mounts);
    }`],
    ['            nodeNetworks.get(client)?.close();\n            nodeNetworks.delete(client);\n            nodeCaches.get(client)?.close();\n            nodeCaches.delete(client);', `            try { closeHostMounts(client); }
            finally {
                nodeNetworks.get(client)?.close();
                nodeNetworks.delete(client);
                nodeCaches.get(client)?.close();
                nodeCaches.delete(client);
            }`],
  ],
  'dist/node-worker.js': [
    ['import { parentPort } from "node:worker_threads";',
      'import { parentPort } from "node:worker_threads";\nimport { installHostFileSystemWorkerBridge } from "./host-filesystem.js";'],
    ['let worker;\nconst pendingMessages = [];',
      'installHostFileSystemWorkerBridge();\nlet worker;\nconst pendingMessages = [];'],
  ],
  'dist/node-worker-adapter.js': [
    ['import { NETWORK_RPC_CONTROL_BYTES } from "./node-network-rpc.js";', `import { NETWORK_RPC_CONTROL_BYTES } from "./node-network-rpc.js";
import { isHostFileSystemRequest, respondToHostFileSystem } from "./host-filesystem.js";
import { dispatchHostFileSystem } from "./node-host-filesystem.js";`],
    ['            if (isNetworkRequest(data)) {\n                void respondToNetworkRequest(data);', `            if (isHostFileSystemRequest(data)) {
                respondToHostFileSystemRequest(data);
            }
            else if (isNetworkRequest(data)) {
                void respondToNetworkRequest(data);`],
    ['function isCacheRequest(value) {', `function respondToHostFileSystemRequest(request) {
    let result;
    try {
        result = { value: dispatchHostFileSystem(request.mount, request.method, request.args) };
    } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "EIO";
        // Do not send native absolute paths or stack traces into the guest.
        result = { error: { code, message: "Host filesystem operation failed (" + code + ")" } };
    }
    respondToHostFileSystem(request, result);
}
function isCacheRequest(value) {`],
  ],
};
