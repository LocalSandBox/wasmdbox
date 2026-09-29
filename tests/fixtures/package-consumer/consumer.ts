import {
  Sandbox, SandboxError, CommandError,
  type PrepareOptions, type SandboxOptions, type CommandResult, type SandboxProcess,
  type NetworkOptions, type HostMount,
} from 'wasmdbox';

const mount: HostMount = { hostPath: './data', guestPath: '/mounted', readOnly: true };
const network: NetworkOptions = {
  allow: ['example.com'],
  secrets: { API_KEY: { value: 'typed-example', hosts: ['example.com'] } },
};
const preparation: PrepareOptions = { extraPkgs: ['python/python@=3.13.20'], startupTimeoutMs: 180_000 };
const options: SandboxOptions = { extraPkgs: [], mounts: [mount], network, files: { '/workspace/input': new Uint8Array() } };

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
