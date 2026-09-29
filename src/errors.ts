import type { CommandResult } from './types.js';

export type SandboxErrorCode =
  | 'INVALID_OPTIONS' | 'STARTUP_TIMEOUT' | 'STARTUP_ABORTED' | 'CREATE_FAILED' | 'PREPARE_FAILED'
  | 'SANDBOX_CLOSED' | 'WORKER_FAILED' | 'PROXY_FAILED' | 'PROTOCOL_ERROR'
  | 'SANDBOX_UNRESPONSIVE' | 'CLOSE_FAILED';

export class SandboxError extends Error {
  override readonly name = 'SandboxError';
  constructor(readonly code: SandboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type CommandErrorCode =
  | 'NON_ZERO_EXIT' | 'TIMEOUT' | 'ABORTED' | 'KILLED'
  | 'COMMAND_NOT_FOUND' | 'COMMAND_AMBIGUOUS' | 'STDIN_FAILED';

export class CommandError extends Error {
  override readonly name = 'CommandError';
  constructor(readonly code: CommandErrorCode, message: string, readonly result?: CommandResult) {
    super(message);
  }
}
