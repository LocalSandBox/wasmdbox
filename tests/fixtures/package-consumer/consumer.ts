import {
  Sandbox, SandboxError, CommandError,
  type PrepareOptions, type SandboxOptions, type CommandResult, type SandboxProcess,
  type NetworkOptions, type HostMount,
} from 'wasmdbox';
import { readFile } from 'node:fs/promises';

const mount: HostMount = { hostPath: './data', guestPath: '/mounted', readOnly: true };
const network: NetworkOptions = {
  allow: ['example.com'],
  secrets: { API_KEY: { value: 'typed-example', hosts: ['example.com'] } },
};
const bytes = await readFile(new URL('./node_modules/wasmdbox/examples/local-package/hello.webc', import.meta.url));
const packages = ['python/python@=3.13.20', bytes, new Uint8Array(bytes)] as const;
const preparation: PrepareOptions = { extraPkgs: packages, startupTimeoutMs: 180_000 };
const options: SandboxOptions = { extraPkgs: packages, mounts: [mount], network, files: { '/workspace/input': new Uint8Array() } };
// @ts-expect-error Raw ArrayBuffers are not package byte views.
const invalid: PrepareOptions = { extraPkgs: [new ArrayBuffer(8)] };
void invalid;

async function consume(): Promise<CommandResult> {
  const prepared: void = await Sandbox.prepare(preparation);
  void prepared;
  const sandbox: Sandbox = await Sandbox.create(options);
  try {
    const child: SandboxProcess = await sandbox.spawn(['bash', '-c', 'cat'], { stdin: 'pipe', check: true });
    child.stdin?.end('hello');
    child.stdout.resume();
    child.stderr.resume();
    return await child.wait();
  } catch (error) {
    if (error instanceof CommandError) console.error(error.code, error.result?.exitCode);
    if (error instanceof SandboxError) console.error(error.code);
    throw error;
  } finally { await sandbox.close(); }
}
void consume;
