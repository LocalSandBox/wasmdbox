import {
  Sandbox, SandboxError, CommandError, NETWORK_PORT_POLICY_VERSION,
  type SandboxOptions, type CommandResult, type SandboxProcess,
  type NetworkOptions, type HostMount,
} from 'wasmdbox';
import { readFile } from 'node:fs/promises';
// @ts-expect-error Preparation is no longer part of the public API.
import type { PrepareOptions } from 'wasmdbox';

const policyVersion: 1 = NETWORK_PORT_POLICY_VERSION;
void policyVersion;
const mount: HostMount = { hostPath: './data', guestPath: '/mounted', readOnly: true };
const network: NetworkOptions = {
  allow: ['example.com'], ports: [443],
  secrets: { API_KEY: { value: 'typed-example', hosts: ['example.com'] } },
};
const bytes = await readFile(new URL('./node_modules/wasmdbox/examples/local-package/hello.webc', import.meta.url));
const packages = [bytes, new Uint8Array(bytes)] as const;
const options: SandboxOptions = { extraPkgs: packages, mounts: [mount], network, files: { '/workspace/input': new Uint8Array() } };
// @ts-expect-error Raw ArrayBuffers are not package byte views.
const invalid: SandboxOptions = { extraPkgs: [new ArrayBuffer(8)] };
void invalid;
// @ts-expect-error Even built-in package names are not accepted as extraPkgs.
const named: SandboxOptions = { extraPkgs: ['python/python@=3.13.20'] };
void named;
// @ts-expect-error Runtime cache configuration was removed with bundled resources.
const removedCache: SandboxOptions = { cacheDir: './cache' };
void removedCache;
function invalidPackageInputs() {
  // @ts-expect-error A mixed list cannot bypass the bytes-only create API.
  return Sandbox.create({ extraPkgs: [bytes, 'wasmer/bash'] });
}
void invalidPackageInputs;

async function consume(): Promise<CommandResult> {
  const sandbox: Sandbox = await Sandbox.create(options);
  try {
    // @ts-expect-error Only the explicit default runtime selector is supported.
    void sandbox.exec(['bash'], { package: 'other' });
    const child: SandboxProcess = await sandbox.spawn(['bash', '-c', 'cat'], { stdin: 'pipe', check: true, package: 'default' });
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
