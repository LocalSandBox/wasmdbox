import { createHash } from 'node:crypto';
import cbor from 'cbor';

const magic = Buffer.from('\0webc003');
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const maxMetadataBytes = 4 * 1024 * 1024;

/** Read the indexed v3 manifest, exactly as webc's OwnedReader does. */
export function readWebcManifest(input: Uint8Array): Map<string, unknown> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, 8).equals(magic) || bytes[8] !== 2) {
    throw new Error('Expected a WEBC v3 package; rebuild older containers with the Wasmer CLI');
  }
  const indexLength = lengthAt(bytes, 9);
  const indexEnd = 17 + indexLength;
  if (indexLength > maxMetadataBytes || indexEnd > bytes.length) throw new Error('Invalid WEBC index length');
  // The v3 index explicitly allows trailing padding. The manifest does not.
  const index = map(decode(bytes.subarray(17, indexEnd), true), 'index');
  const span = map(map(index.get('manifest'), 'manifest index').get('span'), 'manifest span');
  const start = integer(span.get('start'));
  const length = integer(span.get('len'));
  if (start < indexEnd || length < 41 || length > maxMetadataBytes + 41 || start > bytes.length - length || bytes[start] !== 1) {
    throw new Error('Invalid WEBC manifest span');
  }
  const payloadLength = lengthAt(bytes, start + 33);
  if (payloadLength !== length - 41) throw new Error('Invalid WEBC manifest length');
  return map(decode(bytes.subarray(start + 41, start + length), false), 'manifest');
}

/** This is an admission check, not a dependency resolver or a WASM validator. */
export function assertSelfContained(input: Uint8Array): void {
  const prefix = Buffer.from(input.buffer, input.byteOffset, Math.min(input.byteLength, 8));
  if (prefix.equals(wasm)) return; // Raw WASI modules have no WEBC dependencies.
  const manifest = readWebcManifest(input);
  if (manifest.has('use') && map(manifest.get('use'), 'use').size) {
    throw new Error('External package dependencies are not supported; bundle dependencies into one self-contained WEBC before passing extraPkgs');
  }
  const commands = map(manifest.get('commands'), 'commands');
  for (const command of commands.values()) {
    const annotations = map(map(command, 'command').get('annotations'), 'annotations');
    const atom = annotations.get('atom');
    if (atom !== undefined && map(atom, 'atom').get('dependency') != null) {
      throw new Error('External command atom dependencies are not supported');
    }
  }
  if (manifest.has('package')) {
    const fs = map(manifest.get('package'), 'package').get('fs');
    if (fs !== undefined) {
      if (!Array.isArray(fs)) throw new Error('Invalid WEBC filesystem mappings');
      for (const mapping of fs) {
        if (map(mapping, 'filesystem mapping').get('from') != null) {
          throw new Error('External filesystem dependencies are not supported');
        }
      }
    }
  }
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid WEBC offset');
  return value;
}

function lengthAt(bytes: Buffer, offset: number): number {
  if (offset > bytes.length - 8) throw new Error('Truncated WEBC header');
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid WEBC length');
  return Number(value);
}

function map(value: unknown, name: string): Map<string, unknown> {
  if (!(value instanceof Map) || [...value.keys()].some(key => typeof key !== 'string')) throw new Error(`Invalid WEBC ${name}`);
  return value;
}

function decode(bytes: Buffer, padding: boolean): unknown {
  // Bound caller-controlled metadata and reject duplicate keys. Preserve CBOR
  // tags as Tagged values so they cannot masquerade as dependency maps.
  const decoded = cbor.decodeFirstSync(bytes, {
    preferMap: true, preventDuplicateKeys: true, max_depth: 32, required: true,
    extendedResults: padding, tags: new Proxy({}, { get: () => null }),
  });
  return padding ? decoded.value : decoded;
}
