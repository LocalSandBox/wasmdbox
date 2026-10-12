// Node-only client-wide TCP egress. Keep the existing host mount patch intact.
export const replacements = {
  'dist/node.js': [
    ['        const network = new NodeNetworkBridge();', '        const network = new NodeNetworkBridge(options.tcpProxy);'],
  ],
  'dist/node-network.js': [
    ['import dns from "node:dns/promises";', 'import dns from "node:dns/promises";\nimport { SocksConnector } from "./node-tcp-proxy.js";'],
    ['    constructor() {\n        this.id = nextBridgeId++;', `    #proxy;
    constructor(proxy) {
        this.#proxy = proxy === undefined ? undefined : new SocksConnector(proxy);
        this.id = nextBridgeId++;`],
    ['    close() {\n        for (const listener', '    close() {\n        this.#proxy?.close();\n        for (const listener'],
    ['    async resolve(host) {\n        return', '    async resolve(host) {\n        if (this.#proxy) return this.#proxy.resolve(host);\n        return'],
    ['        const peer = parseAddress(peerText);\n        const socket = net.createConnection({', `        const peer = parseAddress(peerText);
        if (this.#proxy) {
            const socket = await this.#proxy.connect(peer);
            const id = this.#registerSocket(socket);
            this.#sockets.get(id).peer = peerText;
            socket.resume();
            return this.#descriptor(id);
        }
        const socket = net.createConnection({`],
    ['    listenTcp(addressText) {\n        const address', `    listenTcp(addressText) {
        if (this.#proxy) throw Object.assign(new Error("Guest listeners are disabled with tcpProxy"), { code: "ENOTSUP" });
        const address`],
    ['            peer: formatAddress({', '            peer: this.#sockets.get(id).peer ?? formatAddress({'],
  ],
};
