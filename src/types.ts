import type { Readable, Writable } from 'node:stream';
import type { NetworkOptions } from './internal/proxy.js';

export type { NetworkOptions } from './internal/proxy.js';

export interface HostMount {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
}

export interface PrepareOptions {
  cacheDir?: string;
  /** Additional Wasmer packages; the default runtime is always included. */
  extraPkgs?: readonly string[];
  /** Maximum preparation or creation time. Default: 180 seconds. */
  startupTimeoutMs?: number;
  /** Cancels preparation or creation only; commands have their own signal. */
  signal?: AbortSignal;
}

export interface SandboxOptions extends PrepareOptions {
  files?: Readonly<Record<string, string | Uint8Array>>;
  env?: Readonly<Record<string, string>>;
  mounts?: readonly HostMount[];
  /** Omitted/false disables guest networking. An object enables managed proxying. */
  network?: false | NetworkOptions;
}

export interface CommandOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Maximum captured and delivered bytes per output stream. Default: 512 KiB. */
  outputBytes?: number;
  /** Throw CommandError on nonzero exit. Default: false. */
  check?: boolean;
}

export interface ExecOptions extends CommandOptions {
  stdin?: string | Uint8Array;
}

export interface SpawnOptions extends CommandOptions {
  stdin?: 'pipe' | 'closed';
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface SandboxProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable | null;
  wait(): Promise<CommandResult>;
  /** Successful cancellation resolves here; wait() rejects with CommandError. */
  kill(): Promise<void>;
}
