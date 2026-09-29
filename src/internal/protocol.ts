import type { CommandResult, SandboxOptions, CommandOptions } from '../types.js';
import type { CommandErrorCode, SandboxErrorCode } from '../errors.js';

export type WorkerOptions = Omit<SandboxOptions, 'signal' | 'startupTimeoutMs'> & {
  mode: 'prepare' | 'sandbox';
};
export type WireCommandOptions = Omit<CommandOptions, 'signal'> & {
  stdin?: 'pipe' | 'closed';
  input?: string | Uint8Array;
  stream: boolean;
};
export type ParentMessage =
  | { type: 'run'; id: number; argv: string[]; options: WireCommandOptions }
  | { type: 'cancel'; id: number }
  | { type: 'stdin'; id: number; requestId: number; bytes?: Uint8Array; end?: boolean }
  | { type: 'close' };
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'started'; id: number }
  | { type: 'chunk'; id: number; stream: 'stdout' | 'stderr'; bytes: Uint8Array }
  | { type: 'done'; id: number; result: CommandResult; terminated: boolean }
  | { type: 'commandError'; id: number; code: CommandErrorCode; message: string }
  | { type: 'io'; requestId: number; failed?: boolean }
  | { type: 'fatal'; code: SandboxErrorCode; message: string }
  | { type: 'closed'; failed: boolean };

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Process completion can precede a caller attaching wait(). It is still
  // observable by that caller, without a global unhandled-rejection event.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
