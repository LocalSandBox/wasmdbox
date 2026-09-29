import { Worker } from 'node:worker_threads';
import { Readable, Writable } from 'node:stream';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SandboxError, CommandError, type CommandErrorCode } from './errors.js';
import type { PrepareOptions, SandboxOptions, ExecOptions, SpawnOptions, CommandResult, SandboxProcess } from './types.js';
import { deferred, type ParentMessage, type WorkerMessage, type WireCommandOptions, type WorkerOptions } from './internal/protocol.js';

const OUTPUT_BYTES = 512 * 1024;
const CLEANUP_MS = 2_000;
type Cancellation = 'TIMEOUT' | 'ABORTED' | 'KILLED';
type Running = {
  started: ReturnType<typeof deferred<void>>;
  finished: ReturnType<typeof deferred<CommandResult>>;
  options: WireCommandOptions;
  stdout: Readable;
  stderr: Readable;
  stdin: Writable | null;
  cancel?: Cancellation;
  timer?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
};

/** A ready guest environment with an owned runtime and optional egress proxy. */
export class Sandbox {
  #worker: Worker;
  #state: 'starting' | 'open' | 'closing' | 'closed' | 'failed' = 'starting';
  #failure?: SandboxError;
  #ready = deferred<void>();
  #closed = deferred<void>();
  #closePromise?: Promise<void>;
  #termination?: Promise<number>;
  #nextId = 1;
  #running = new Map<number, Running>();
  #io = new Map<number, ReturnType<typeof deferred<void>>>();

  private constructor(options: WorkerOptions) {
    this.#worker = new Worker(new URL('./internal/sandbox-worker.js', import.meta.url), {
      workerData: options, stdout: true, stderr: true, execArgv: workerModuleHooks(),
    });
    // SDK diagnostic output is not part of guest stdout/stderr or our public API.
    this.#worker.stdout.resume();
    this.#worker.stderr.resume();
    this.#worker.on('message', (message: unknown) => this.#receive(message));
    this.#worker.on('error', () => this.#fail(new SandboxError('WORKER_FAILED', 'Sandbox worker failed')));
    this.#worker.on('exit', () => {
      if (this.#state !== 'closed' && this.#state !== 'failed') {
        this.#fail(new SandboxError('WORKER_FAILED', 'Sandbox worker exited unexpectedly'));
      }
    });
  }

  static async create(options: SandboxOptions = {}): Promise<Sandbox> {
    return Sandbox.#initialize(options, 'sandbox');
  }

  /** Warm the package cache without creating a guest or a network proxy. */
  static async prepare(options: PrepareOptions = {}): Promise<void> {
    validateObject(options, 'options');
    const { cacheDir, extraPkgs, startupTimeoutMs, signal } = options;
    await Sandbox.#initialize({ cacheDir, extraPkgs, startupTimeoutMs, signal }, 'prepare');
  }

  static async #initialize(options: SandboxOptions, mode: WorkerOptions['mode']): Promise<Sandbox> {
    validateObject(options, 'options');
    const operation = mode === 'prepare' ? 'Runtime preparation' : 'Sandbox creation';
    const timeout = options.startupTimeoutMs ?? 180_000;
    validateDuration(timeout, 'startupTimeoutMs');
    validateSignal(options.signal);
    validateExtraPkgs(options.extraPkgs);
    if (options.signal?.aborted) throw new SandboxError('STARTUP_ABORTED', `${operation} was cancelled`);
    validateEnv(options.env);
    if (options.network !== undefined && options.network !== false) validateObject(options.network, 'network');
    const { signal, startupTimeoutMs: _, ...settings } = options;
    let sandbox: Sandbox;
    try {
      sandbox = new Sandbox(structuredClone({
        ...settings, mode,
        cacheDir: resolve(options.cacheDir ?? defaultCacheDir()),
        mounts: options.mounts?.map(mount => ({ ...mount, hostPath: resolve(mount.hostPath) })),
      }));
    } catch {
      throw new SandboxError('INVALID_OPTIONS', `${operation} cannot start with the supplied options`);
    }
    const cancel = () => sandbox.#fail(new SandboxError('STARTUP_ABORTED', `${operation} was cancelled`));
    const timer = setTimeout(() => sandbox.#fail(new SandboxError('STARTUP_TIMEOUT', `${operation} timed out`)), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await sandbox.#ready.promise;
      if (mode === 'prepare') await sandbox.close();
      return sandbox;
    } catch (error) {
      await sandbox.#terminate();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async exec(argv: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    validateObject(options, 'command options');
    validateSignal(options.signal);
    const { signal, stdin, ...settings } = options;
    if (stdin !== undefined && typeof stdin !== 'string' && !(stdin instanceof Uint8Array)) invalid('stdin must be text or bytes');
    const { running } = this.#start(argv, {
      ...settings, input: stdin, stdin: stdin === undefined ? 'closed' : 'pipe', stream: false,
    }, signal);
    return running.finished.promise;
  }

  async spawn(argv: readonly string[], options: SpawnOptions = {}): Promise<SandboxProcess> {
    validateObject(options, 'command options');
    validateSignal(options.signal);
    const { signal, ...settings } = options;
    if (options.stdin !== undefined && !['pipe', 'closed'].includes(options.stdin)) invalid('stdin must be pipe or closed');
    const { id, running } = this.#start(argv, { ...settings, stream: true }, signal);
    await running.started.promise;
    return Object.freeze({
      stdout: running.stdout, stderr: running.stderr, stdin: running.stdin,
      wait: () => running.finished.promise,
      kill: async () => {
        if (!this.#running.has(id)) return;
        this.#cancel(id, 'KILLED');
        try { await running.finished.promise; }
        catch (error) {
          if (!(error instanceof CommandError)) throw error;
        }
      },
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'failed') {
      await this.#terminate();
      return;
    }
    this.#state = 'closing';
    const error = new SandboxError('SANDBOX_CLOSED', 'Sandbox was closed');
    for (const running of this.#running.values()) {
      clearTimeout(running.timer); clearTimeout(running.grace); running.unsubscribe?.();
    }
    this.#post({ type: 'close' });
    const timer = setTimeout(() => this.#fail(new SandboxError('SANDBOX_UNRESPONSIVE', 'Sandbox did not close within the cleanup deadline')), CLEANUP_MS);
    try { await this.#closed.promise; }
    finally {
      clearTimeout(timer);
      await this.#terminate();
      for (const id of this.#running.keys()) this.#finish(id, undefined, error);
      this.#rejectIO(error);
    }
  }

  #start(argv: readonly string[], options: WireCommandOptions, signal?: AbortSignal) {
    this.#assertOpen();
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || value.includes('\0')) || !argv[0]) {
      invalid('argv must be a nonempty array of strings without NUL bytes');
    }
    validateEnv(options.env);
    if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !options.cwd.startsWith('/') || options.cwd.includes('\0'))) invalid('cwd must be an absolute guest path');
    if (options.check !== undefined && typeof options.check !== 'boolean') invalid('check must be boolean');
    if (options.timeoutMs !== undefined) validateDuration(options.timeoutMs, 'timeoutMs');
    const outputBytes = options.outputBytes ?? OUTPUT_BYTES;
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > 0xffff_ffff) invalid('outputBytes must be an unsigned 32-bit integer');
    if (signal?.aborted) throw new CommandError('ABORTED', 'Command was cancelled');
    const id = this.#nextId++;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = options.stdin === 'pipe' && options.stream ? new Writable({
      write: (chunk: Buffer, _encoding, callback) => { this.#input(id, chunk).then(() => callback(), error => callback(error)); },
      final: callback => { this.#input(id).then(() => callback(), error => callback(error)); },
    }) : null;
    // wait() is the error channel even if the caller never subscribes to stdin.
    stdin?.on('error', () => {});
    const running: Running = {
      started: deferred<void>(), finished: deferred<CommandResult>(),
      options: { ...options, outputBytes }, stdout, stderr, stdin,
    };
    this.#running.set(id, running);
    const cancel = () => this.#cancel(id, 'ABORTED');
    signal?.addEventListener('abort', cancel, { once: true });
    running.unsubscribe = () => signal?.removeEventListener('abort', cancel);
    if (options.timeoutMs !== undefined) running.timer = setTimeout(() => this.#cancel(id, 'TIMEOUT'), options.timeoutMs);
    this.#post({ type: 'run', id, argv: [...argv], options: running.options });
    if (signal?.aborted) cancel();
    return { id, running };
  }

  #cancel(id: number, code: Cancellation) {
    const running = this.#running.get(id);
    if (!running || running.cancel) return;
    running.cancel = code;
    clearTimeout(running.timer);
    this.#post({ type: 'cancel', id });
    running.grace = setTimeout(() => this.#fail(new SandboxError('SANDBOX_UNRESPONSIVE', 'Command cancellation could not stop the sandbox')), CLEANUP_MS);
  }

  #input(id: number, bytes?: Uint8Array): Promise<void> {
    if (!this.#running.has(id)) return Promise.reject(new CommandError('STDIN_FAILED', 'Command stdin is closed'));
    this.#assertOpen();
    const requestId = this.#nextId++;
    const pending = deferred<void>();
    this.#io.set(requestId, pending);
    this.#post({ type: 'stdin', id, requestId, bytes, end: bytes === undefined });
    return pending.promise;
  }

  #receive(input: unknown) {
    if (this.#state === 'closed' || this.#state === 'failed') return;
    if (!validMessage(input)) {
      this.#fail(new SandboxError('PROTOCOL_ERROR', 'Invalid sandbox worker response')); return;
    }
    const message = input;
    if (this.#state === 'closing' && !['closed', 'fatal'].includes(message.type)) return;
    switch (message.type) {
      case 'ready':
        if (this.#state !== 'starting') return this.#fail(new SandboxError('PROTOCOL_ERROR', 'Unexpected sandbox readiness event'));
        this.#state = 'open'; this.#ready.resolve(); return;
      case 'fatal':
        this.#fail(new SandboxError(message.code, message.message)); return;
      case 'closed':
        if (this.#state !== 'closing') return this.#fail(new SandboxError('PROTOCOL_ERROR', 'Unexpected sandbox closure'));
        this.#state = 'closed';
        if (message.failed) this.#closed.reject(new SandboxError('CLOSE_FAILED', 'Sandbox resource cleanup failed'));
        else this.#closed.resolve();
        return;
      case 'io': {
        const io = this.#io.get(message.requestId);
        this.#io.delete(message.requestId);
        if (message.failed) io?.reject(new CommandError('STDIN_FAILED', 'Cannot write to command stdin'));
        else io?.resolve();
        return;
      }
      case 'started': {
        const running = this.#running.get(message.id);
        if (running && !running.cancel) running.started.resolve();
        return;
      }
      case 'chunk': {
        const running = this.#running.get(message.id);
        if (!running) return;
        if (!running[message.stream].destroyed) running[message.stream].push(Buffer.from(message.bytes));
        return;
      }
      case 'done': {
        const running = this.#running.get(message.id);
        if (!running) return;
        const code: CommandErrorCode | undefined = running.cancel ?? (message.terminated ? 'KILLED' : running.options.check && message.result.exitCode !== 0 ? 'NON_ZERO_EXIT' : undefined);
        this.#finish(message.id, message.result, code ? new CommandError(code, commandMessage(code), message.result) : undefined);
        return;
      }
      case 'commandError': {
        const running = this.#running.get(message.id);
        const code = running?.cancel ?? message.code;
        this.#finish(message.id, undefined, new CommandError(code, running?.cancel ? commandMessage(code) : message.message));
        return;
      }
      default: this.#fail(new SandboxError('PROTOCOL_ERROR', 'Unknown sandbox worker response'));
    }
  }

  #finish(id: number, result?: CommandResult, error?: Error) {
    const running = this.#running.get(id);
    if (!running) return;
    this.#running.delete(id);
    clearTimeout(running.timer); clearTimeout(running.grace); running.unsubscribe?.();
    running.stdout.push(null); running.stderr.push(null); running.stdin?.destroy();
    if (error) { running.started.reject(error); running.finished.reject(error); }
    else if (result) { running.started.resolve(); running.finished.resolve(result); }
  }

  #assertOpen() {
    if (this.#failure) throw this.#failure;
    if (this.#state !== 'open') throw new SandboxError('SANDBOX_CLOSED', 'Sandbox is not open');
  }

  #post(message: ParentMessage) {
    try { this.#worker.postMessage(message); }
    catch { this.#fail(new SandboxError('PROTOCOL_ERROR', 'Cannot communicate with sandbox worker')); }
  }

  #fail(error: SandboxError) {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    this.#failure = error;
    this.#state = 'failed';
    // An operation must not settle while its failed runtime can still produce
    // side effects. Worker termination also stops the nested Wasmer workers.
    const settle = () => {
      this.#ready.reject(error); this.#closed.reject(error);
      for (const id of this.#running.keys()) this.#finish(id, undefined, error);
      this.#rejectIO(error);
    };
    void this.#terminate().then(settle, settle);
  }

  #rejectIO(error: Error) {
    for (const pending of this.#io.values()) pending.reject(error);
    this.#io.clear();
  }

  #terminate(): Promise<number> {
    return this.#termination ??= this.#worker.terminate();
  }
}

function defaultCacheDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'wasmdbox');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'wasmdbox', 'Cache');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'wasmdbox');
}
function invalid(message: string): never { throw new SandboxError('INVALID_OPTIONS', message); }
function validateObject(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
}
function validateDuration(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fff_ffff) invalid(`${name} must be an integer between 0 and 2147483647`);
}
function validateSignal(signal: AbortSignal | undefined) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid('signal must be an AbortSignal');
}
function validateEnv(env: Readonly<Record<string, string>> | undefined) {
  if (env === undefined) return;
  validateObject(env, 'env');
  for (const [name, value] of Object.entries(env)) {
    if (!name || /[=\0]/.test(name) || typeof value !== 'string' || value.includes('\0')) invalid('env must contain valid names and string values');
  }
}
function validateExtraPkgs(packages: readonly string[] | undefined) {
  if (packages === undefined) return;
  if (!Array.isArray(packages)) invalid('extraPkgs must be an array of package references');
  for (const pkg of packages) {
    if (typeof pkg !== 'string' || !pkg.trim() || pkg.includes('\0')) invalid('extraPkgs must contain nonempty package references without NUL bytes');
  }
}
function validResult(result: CommandResult): boolean {
  return !!result && Number.isInteger(result.exitCode) && typeof result.stdout === 'string' && typeof result.stderr === 'string'
    && typeof result.stdoutTruncated === 'boolean' && typeof result.stderrTruncated === 'boolean';
}
function validMessage(input: unknown): input is WorkerMessage {
  if (!input || typeof input !== 'object' || !('type' in input)) return false;
  const value = input as Record<string, unknown>;
  const id = (key: string) => Number.isSafeInteger(value[key]) && Number(value[key]) > 0;
  switch (value.type) {
    case 'ready': return true;
    case 'closed': return typeof value.failed === 'boolean';
    case 'started': return id('id');
    case 'chunk': return id('id') && ['stdout', 'stderr'].includes(value.stream as string) && value.bytes instanceof Uint8Array;
    case 'done': return id('id') && typeof value.terminated === 'boolean' && validResult(value.result as CommandResult);
    case 'io': return id('requestId') && (value.failed === undefined || typeof value.failed === 'boolean');
    case 'commandError': return id('id') && typeof value.message === 'string' && [
      'NON_ZERO_EXIT', 'TIMEOUT', 'ABORTED', 'KILLED', 'COMMAND_NOT_FOUND', 'COMMAND_AMBIGUOUS', 'STDIN_FAILED',
    ].includes(value.code as string);
    case 'fatal': return typeof value.message === 'string' && [
      'INVALID_OPTIONS', 'STARTUP_TIMEOUT', 'STARTUP_ABORTED', 'CREATE_FAILED', 'PREPARE_FAILED', 'SANDBOX_CLOSED', 'WORKER_FAILED',
      'PROXY_FAILED', 'PROTOCOL_ERROR', 'SANDBOX_UNRESPONSIVE', 'CLOSE_FAILED',
    ].includes(value.code as string);
    default: return false;
  }
}
function commandMessage(code: CommandErrorCode): string {
  return ({ TIMEOUT: 'Command timed out', ABORTED: 'Command was cancelled', KILLED: 'Command was terminated', NON_ZERO_EXIT: 'Command exited with a nonzero status' } as Partial<Record<CommandErrorCode, string>>)[code] ?? 'Command failed';
}

function workerModuleHooks(): string[] {
  // Preserve module instrumentation. CLI input and process-only flags do not
  // apply to our file worker or the nested Wasmer workers it creates.
  const hooks = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
  const args: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i]!;
    if (hooks.has(arg)) args.push(arg, process.execArgv[++i]!);
    else if (hooks.has(arg.split('=', 1)[0]!)) args.push(arg);
  }
  return args;
}
