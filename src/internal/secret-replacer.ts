import { Transform, type TransformCallback } from 'node:stream';

export const SECRET_TOKEN_BYTES = 128;

export interface SecretReplacement {
  token: Buffer;
  value: Buffer;
}

/** Scan the original input once: inserted values never become replacement input. */
export function replaceSecrets(input: Buffer, replacements: readonly SecretReplacement[]): Buffer {
  const chunks: Buffer[] = [];
  replacePrefix(input, input.length, replacements, chunk => chunks.push(chunk));
  return Buffer.concat(chunks);
}

/** Binary-safe replacement with at most 127 bytes retained between chunks. */
export class SecretReplacer extends Transform {
  #pending: Buffer = Buffer.alloc(0);

  constructor(private readonly replacements: readonly SecretReplacement[]) {
    super();
    for (const { token } of replacements) {
      if (token.length !== SECRET_TOKEN_BYTES) throw new TypeError('Secret tokens must contain 128 bytes');
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const input = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
      const safeLength = Math.max(0, input.length - (SECRET_TOKEN_BYTES - 1));
      const consumed = replacePrefix(input, safeLength, this.replacements, data => this.push(data));
      // Copy the short suffix instead of retaining the backing store of a large chunk.
      this.#pending = Buffer.from(input.subarray(consumed));
      callback();
    } catch (error) { callback(error as Error); }
  }

  override _flush(callback: TransformCallback): void {
    if (this.#pending.length) this.push(this.#pending);
    this.#pending = Buffer.alloc(0);
    callback();
  }
}

function replacePrefix(
  input: Buffer,
  safeLength: number,
  replacements: readonly SecretReplacement[],
  emit: (chunk: Buffer) => void,
): number {
  let cursor = 0;
  while (cursor < safeLength) {
    let first = safeLength;
    let match: SecretReplacement | undefined;
    for (const replacement of replacements) {
      const index = input.indexOf(replacement.token, cursor);
      if (index !== -1 && index < first) { first = index; match = replacement; }
    }
    if (!match) break;
    if (first > cursor) emit(input.subarray(cursor, first));
    if (match.value.length) emit(match.value);
    cursor = first + match.token.length;
  }
  if (cursor < safeLength) { emit(input.subarray(cursor, safeLength)); cursor = safeLength; }
  return cursor;
}
