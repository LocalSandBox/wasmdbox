import type { Readable, Writable } from 'node:stream';
import type { NetworkOptions } from './internal/proxy.js';

export type { NetworkOptions } from './internal/proxy.js';

export interface HostMount {
  hostPath: string;
  /** Exact /workspace replaces guest storage; descendants and overlaps are rejected. */
  guestPath: string;
  readOnly?: boolean;
  /** Mount-relative subtrees that remain readable but cannot be mutated. */
  denyWritePaths?: string[];
}

export interface SandboxOptions {
  /** Self-contained WEBC v3 or raw WASI bytes, including Buffers. External dependencies and strings are rejected. Node and Python are built in. */
  extraPkgs?: readonly Uint8Array[];
  /** Maximum creation time. Default: 180 seconds. */
  startupTimeoutMs?: number;
  /** Cancels creation only; commands have their own signal. */
  signal?: AbortSignal;
  /**
   * Initial /workspace files. With a /workspace host mount, writes persist and
   * overwrite matching host files. Subject to mount write restrictions. Creation
   * is not transactional: failure, timeout or cancellation may leave partial
   * writes. Without that mount, files belong to the temporary memory workspace.
   */
  files?: Readonly<Record<string, string | Uint8Array>>;
  env?: Readonly<Record<string, string>>;
  mounts?: readonly HostMount[];
  /** Omitted/false disables guest networking. An object enables managed proxying. */
  network?: false | NetworkOptions;
}

export interface CommandOptions {
  /** Select a bundled default command (including Python) when extra packages export the same name. */
  package?: 'default';
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
  /** Cumulative omitted directory entries in this sandbox; repeated scans count again. */
  hostEntriesOmitted?: number;
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
