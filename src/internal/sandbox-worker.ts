import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import type { Wasmer, Sandbox as WasmerSandbox, Process as WasmerProcess } from '@wasmer/sdk/node';
import { startProxy } from './proxy.js';
import type { ParentMessage, WorkerMessage, WorkerOptions, WireCommandOptions } from './protocol.js';
import type { SandboxErrorCode } from '../errors.js';

const port = parentPort!;
const options = workerData as WorkerOptions;
const DEFAULT_RUNTIME = 'wasmer/edgejs-quickjs@=0.1.4';
const INTERNAL = '/workspace/.wasmdbox';
const COMPAT = `${INTERNAL}/edgejs-keepalive.cjs`;
const CA = `${INTERNAL}/ca.pem`;
let client: Wasmer | undefined;
let sandbox: WasmerSandbox | undefined;
let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
let failed = false;
let closing = false;
let unsubscribe: (() => void) | undefined;
const running = new Map<number, { process?: WasmerProcess; cancelled: boolean; task?: Promise<void> }>();
let baseEnv: Record<string, string> = {};
let caBundle = false;

function send(message: WorkerMessage) { port.postMessage(message); }
function fatal(code: SandboxErrorCode, message: string) {
  if (failed || closing) return;
  failed = true;
  // The parent owns hard teardown. Latch before the SDK onerror handler can
  // turn this failure into a normal-looking exit code.
  send({ type: 'fatal', code, message });
}

async function initialize() {
  try {
    // Runtime-only imports keep upstream types and patch APIs out of our ABI.
    const workerAdapterURL = new URL('../vendor/wasmer-sdk/dist/node-worker-adapter.js', import.meta.url);
    const adapter = await import(workerAdapterURL.href) as { subscribeWorkerFailures(listener: (error: Error) => void): () => void };
    unsubscribe = adapter.subscribeWorkerFailures(() => fatal('WORKER_FAILED', 'Wasmer runtime worker failed'));
    const sdkURL = new URL('../vendor/wasmer-sdk/dist/node.js', import.meta.url);
    const sdk = await import(sdkURL.href) as typeof import('@wasmer/sdk/node');
    const files = { ...options.files };
    for (const [path, contents] of Object.entries(files)) {
      if (!path.startsWith('/workspace/') || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')
          || path === INTERNAL || path.startsWith(`${INTERNAL}/`)) throw new Error('Invalid or reserved guest file path');
      if (typeof contents !== 'string' && !(contents instanceof Uint8Array)) throw new Error('Invalid guest file contents');
    }
    const network = options.mode === 'sandbox' && options.network;
    if (network) proxy = await startProxy(network, () => fatal('PROXY_FAILED', 'Managed network proxy failed'));
    if (failed) return;
    const sdkOptions = {
      parallelism: 2, outputBytes: 512 * 1024,
      cache: { directory: options.cacheDir! },
      ...(proxy ? { tcpProxy: { host: proxy.host, port: proxy.port } } : {}),
    };
    client = new sdk.Wasmer(sdkOptions);
    const sources = [...new Set([DEFAULT_RUNTIME, ...(options.extraPkgs ?? [])])];
    const loaded = await client.packages.loadMany(sources);
    const packages = [...new Map(loaded.map(pkg => [pkg.id, pkg])).values()];
    if (failed) return;
    if (options.mode === 'prepare') { send({ type: 'ready' }); return; }
    files[COMPAT] = await readFile(new URL('../assets/edgejs-keepalive.cjs', import.meta.url));
    const certificates = [...(network ? network.caCerts ?? [] : []), ...(proxy?.caCert ? [proxy.caCert] : [])];
    const extraCAPath = options.env?.NODE_EXTRA_CA_CERTS;
    if (extraCAPath && certificates.length) {
      const extra = files[extraCAPath];
      if (extra === undefined) throw new Error('NODE_EXTRA_CA_CERTS must refer to an imported file when managed CA trust is enabled');
      certificates.push(typeof extra === 'string' ? extra : new TextDecoder().decode(extra));
    }
    if (certificates.length) { files[CA] = certificates.join('\n'); caBundle = true; }
    baseEnv = { ...options.env };
    const settings = {
      packages, files, mounts: options.mounts,
      env: commandEnv(), network: { mode: proxy ? 'host' as const : 'disabled' as const },
    };
    sandbox = await client.sandboxes.create(settings);
    if (!failed) send({ type: 'ready' });
  } catch (error) {
    const preparing = options.mode === 'prepare';
    fatal(preparing ? 'PREPARE_FAILED' : 'CREATE_FAILED', `Failed to prepare ${preparing ? 'runtime packages' : 'sandbox'}: ${diagnostic(error)}`);
  }
}

function diagnostic(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Unknown runtime error';
  const values = Object.values(options.network ? options.network.secrets ?? {} : {})
    .flatMap(secret => typeof secret?.value === 'string' ? [secret.value] : []);
  for (const value of values.filter(value => typeof value === 'string' && value.length).sort((a, b) => b.length - a.length)) {
    message = message.split(value).join('[redacted]');
  }
  return message.slice(0, 1_024);
}

function commandEnv(override: Readonly<Record<string, string>> = {}) {
  const env = { ...baseEnv, ...override, ...proxy?.env };
  if (caBundle) env.NODE_EXTRA_CA_CERTS = CA;
  // TODO(edgejs-keepalive): remove the preload after the fixed upstream release
  // passes the direct-IP fetch and Node/Bash keepalive ablation regressions.
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${COMPAT}`.trim();
  return env;
}

async function run(id: number, argv: string[], settings: WireCommandOptions) {
  const record: { process?: WasmerProcess; cancelled: boolean; task?: Promise<void> } = { cancelled: false };
  running.set(id, record);
  record.task = (async () => {
    let started = false;
    try {
      if (!sandbox || closing || failed) return;
      record.process = await sandbox.command(argv[0]!, argv.slice(1), {
        cwd: settings.cwd ?? '/workspace', env: commandEnv(settings.env),
      }).spawn({
        stdin: settings.stdin ?? 'closed', stdout: 'pipe', stderr: 'pipe',
        outputBytes: settings.outputBytes,
      });
      started = true;
      if (record.cancelled || closing || failed) await record.process.kill();
      if (!failed && !closing) send({ type: 'started', id });
      const drains = Promise.all([
        drain(id, 'stdout', record.process.stdout!, settings),
        drain(id, 'stderr', record.process.stderr!, settings),
      ]);
      // Start draining and waiting immediately, even without a stream consumer.
      // Every promise has a rejection observer before the next asynchronous step.
      void drains.catch(() => {});
      let inputFailed = false;
      const input = settings.input === undefined ? Promise.resolve() : (async () => {
        try {
          await record.process!.stdin!.write(settings.input!);
          await record.process!.stdin!.close();
        } catch { inputFailed = true; }
      })();
      const output = await record.process.wait();
      await Promise.all([drains, input]);
      if (failed || closing) return;
      const result = {
        exitCode: output.exitCode,
        stdout: output.stdout.text(), stderr: output.stderr.text(),
        stdoutTruncated: output.stdout.truncated, stderrTruncated: output.stderr.truncated,
      };
      if (inputFailed && !record.cancelled && output.exitCode === 0) {
        send({ type: 'commandError', id, code: 'STDIN_FAILED', message: 'Failed to deliver command stdin' });
      } else send({ type: 'done', id, result, terminated: output.reason !== 'exited' });
    } catch (error) {
      if (failed || closing) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (!started && (code === 'COMMAND_NOT_FOUND' || code === 'COMMAND_AMBIGUOUS')) {
        send({ type: 'commandError', id, code, message: code === 'COMMAND_NOT_FOUND' ? 'Guest command was not found' : 'Guest command is ambiguous' });
      } else fatal('WORKER_FAILED', 'Sandbox command transport or runtime failed');
    } finally { running.delete(id); }
  })();
  await record.task;
}

async function drain(id: number, stream: 'stdout' | 'stderr', source: AsyncIterable<Uint8Array>, settings: WireCommandOptions) {
  let remaining = settings.outputBytes!;
  for await (const bytes of source) {
    if (settings.stream && remaining > 0 && !failed && !closing) {
      const chunk = bytes.slice(0, remaining);
      remaining -= chunk.length;
      send({ type: 'chunk', id, stream, bytes: chunk });
    }
  }
}

async function close() {
  if (closing) return;
  closing = true;
  let cleanupFailed = false;
  for (const record of running.values()) {
    record.cancelled = true;
    try { await record.process?.kill(); } catch { cleanupFailed = true; }
  }
  await Promise.allSettled([...running.values()].map(record => record.task));
  for (const action of [() => sandbox?.close(), () => client?.close(), () => proxy?.close()]) {
    try { await action(); } catch { cleanupFailed = true; }
  }
  unsubscribe?.();
  send({ type: 'closed', failed: cleanupFailed });
  port.close();
}

port.on('message', (message: ParentMessage) => {
  if (message.type === 'close') { void close(); return; }
  if (closing || failed) return;
  switch (message.type) {
    case 'run': void run(message.id, message.argv, message.options); break;
    case 'cancel': {
      const record = running.get(message.id);
      if (record) {
        record.cancelled = true;
        void record.process?.kill().catch(() => fatal('WORKER_FAILED', 'Cannot terminate guest process'));
      }
      break;
    }
    case 'stdin': {
      void (async () => {
        try {
          const stdin = running.get(message.id)?.process?.stdin;
          if (!stdin) throw new Error('Closed stdin');
          if (message.end) await stdin.close();
          else await stdin.write(message.bytes!);
          send({ type: 'io', requestId: message.requestId });
        } catch { send({ type: 'io', requestId: message.requestId, failed: true }); }
      })();
      break;
    }
    default: fatal('PROTOCOL_ERROR', 'Unknown sandbox request');
  }
});

void initialize();
