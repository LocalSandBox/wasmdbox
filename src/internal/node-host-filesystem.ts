// Node adapter for the experimental HostFileSystem ABI in @wasmer/sdk 0.19.1.
// The build copies this compiled module into the private SDK distribution.
import * as fs from 'node:fs';
import { isAbsolute, join, posix, sep } from 'node:path';

const INTERNAL_MOUNT = Symbol('wasmdbox internal mount');
const INTERNAL_PATH = '/.wasmdbox';

/** Only private runtime code can mint this capability; it never crosses workerData. */
export function internalRuntimeMount(hostPath: string): HostDirectoryMount {
  return { hostPath, guestPath: INTERNAL_PATH, readOnly: true, [INTERNAL_MOUNT]: true } as HostDirectoryMount;
}

const CHUNK_BYTES = 64 * 1024;
const MAX_U32 = 0xffff_ffff;
export interface HostDirectoryMount {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
  /** Mount-relative subtrees that remain readable but cannot be mutated. */
  denyWritePaths?: string[];
}

export interface RegisteredHostMount {
  id: number;
  guestPath: string;
  readOnly: boolean;
}

export interface HostMountLease {
  mounts: RegisteredHostMount[];
  close(): void;
}

interface HostFileHandle {
  fd: number;
  path: string;
  read: boolean;
  write: boolean;
  append: boolean;
}

interface HostFileMetadata {
  kind: 'directory' | 'file';
  size: number;
  accessed: string;
  modified: string;
  created: string;
}

const mounts = new Map<number, DirectoryFileSystem>();
const owners = new WeakMap<object, Set<HostMountLease>>();
let nextMount = 1;

function error(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw error('EINVAL', `Invalid ${name}`);
  }
  return value;
}

function overlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** Internal path policy, also exercised on non-Windows CI hosts. */
export function hostRelativePathParts(relative: unknown, windows: boolean): string[] {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') ||
      relative.startsWith('/') || relative.split('/').includes('..')) {
    throw error('EPERM', 'Only paths relative to the mount root are allowed');
  }
  const parts = relative.split('/').filter(part => part !== '' && part !== '.');
  if (windows && parts.some(part =>
    /[\x00-\x1f<>:"|?*]/.test(part) || /[ .]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?: *\.|$)/i.test(part))) {
    throw error('EPERM', 'Windows device names, streams and ambiguous paths are not supported');
  }
  return parts;
}

function sameFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function validateMounts(configs: readonly HostDirectoryMount[]) {
  if (!Array.isArray(configs)) throw error('EINVAL', 'mounts must be an array');
  const reserved = ['/workspace', '/tmp', '/dev', '/bin', '/sbin', '/usr', '/etc', '/lib', '/proc', '/sys'];
  const destinations: string[] = [];
  return configs.map((config) => {
    if (!config || typeof config.hostPath !== 'string' || !isAbsolute(config.hostPath)) {
      throw error('EINVAL', 'hostPath must be an absolute directory path');
    }
    const { guestPath, hostPath } = config;
    if (typeof guestPath !== 'string' || !guestPath.startsWith('/') || guestPath === '/' ||
        guestPath.includes('\0') || guestPath.includes('\\') || guestPath.endsWith('/') ||
        posix.normalize(guestPath) !== guestPath) {
      throw error('EINVAL', 'guestPath must be a normalized absolute path, such as /mounted');
    }
    const internal = (config as HostDirectoryMount & { [INTERNAL_MOUNT]?: boolean })[INTERNAL_MOUNT] === true;
    if (overlap(INTERNAL_PATH, guestPath) && !(internal && guestPath === INTERNAL_PATH && config.readOnly === true)) {
      throw error('EINVAL', 'The private runtime mount is reserved');
    }
    if (reserved.some(path => overlap(path, guestPath) && !(path === '/workspace' && guestPath === '/workspace')) ||
        destinations.some(path => overlap(path, guestPath))) {
      throw error('EINVAL', 'Mounts must not overlap each other or SDK runtime/storage paths');
    }
    if (config.readOnly !== undefined && typeof config.readOnly !== 'boolean') {
      throw error('EINVAL', 'readOnly must be a boolean');
    }
    if (config.denyWritePaths !== undefined && !Array.isArray(config.denyWritePaths)) {
      throw error('EINVAL', 'denyWritePaths must be an array');
    }
    const denyWritePaths = (config.denyWritePaths ?? []).map((path: string) => {
      const parts = hostRelativePathParts(path, process.platform === 'win32');
      if (!parts.length || parts.join('/') !== path) throw error('EINVAL', 'denyWritePaths must contain normalized nonempty relative paths');
      return path;
    });
    destinations.push(guestPath);
    return { hostPath, guestPath, readOnly: config.readOnly ?? false, denyWritePaths };
  });
}

/** Register a whole sandbox's mounts transactionally; IDs are never reused. */
export function registerHostMounts(owner: object, configs: readonly HostDirectoryMount[]): HostMountLease {
  const validated = validateMounts(configs);
  const registered: RegisteredHostMount[] = [];
  const lease: HostMountLease = {
    mounts: registered,
    close() {
      const failures: unknown[] = [];
      for (const { id } of registered) {
        const provider = mounts.get(id);
        mounts.delete(id); // Reject late RPCs even if a file close fails.
        try { provider?.closeAll(); } catch (failure) { failures.push(failure); }
      }
      owners.get(owner)?.delete(lease);
      if (failures.length) throw new AggregateError(failures, 'Closing host mounts failed');
    },
  };
  try {
    for (const config of validated) {
      if (nextMount > MAX_U32) throw error('EMFILE', 'Host mount IDs exhausted');
      const provider = new DirectoryFileSystem(config.hostPath, config.readOnly, config.denyWritePaths);
      const id = nextMount++;
      mounts.set(id, provider);
      registered.push({ id, guestPath: config.guestPath, readOnly: config.readOnly });
    }
    let leases = owners.get(owner);
    if (!leases) owners.set(owner, leases = new Set());
    leases.add(lease);
    return lease;
  } catch (failure) {
    lease.close();
    throw failure;
  }
}

export function closeHostMounts(owner: object): void {
  const failures: unknown[] = [];
  for (const lease of [...(owners.get(owner) ?? [])]) {
    try { lease.close(); } catch (failure) { failures.push(failure); }
  }
  owners.delete(owner);
  if (failures.length) throw new AggregateError(failures, 'Closing client host mounts failed');
}

export function dispatchHostFileSystem(mount: unknown, method: unknown, args: unknown): unknown {
  try {
    const provider = mounts.get(integer(mount, 'mount ID', MAX_U32));
    if (!provider) throw error('EPERM', 'Unknown or closed host mount');
    return provider.call(method, args);
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException)?.code;
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'EIO';
    // Identical safe errors for supervisor calls and nested-worker RPCs.
    throw error(safeCode, `Host filesystem operation failed (${safeCode})`);
  }
}

/** Diagnostic counts for lifecycle regression tests; no paths or descriptors. */
export function hostFileSystemStats() {
  return {
    mounts: mounts.size,
    handles: [...mounts.values()].reduce((sum, provider) => sum + provider.handleCount, 0),
  };
}

/** One sandbox owns this adapter instance; no host paths leave the worker. */
export function hostFileSystemEntriesOmitted(): number {
  return [...mounts.values()].reduce((sum, provider) => sum + provider.entriesOmitted, 0);
}

const arities = new Map(Object.entries({
  stat: 1, readDir: 1, open: 7, mkdir: 1, remove: 1, rename: 2, sync: 0,
  setTimes: 3, fileStat: 1, setFileTimes: 3, read: 3, write: 3,
  setLen: 2, flush: 1, close: 1,
}));

class DirectoryFileSystem {
  #root: string;
  #identity: fs.BigIntStats;
  #readOnly: boolean;
  #denyWritePaths: string[];
  entriesOmitted = 0;
  #handles = new Map<number, HostFileHandle>();
  #nextHandle = 1;
  #windows = process.platform === 'win32';

  constructor(root: string, readOnly: boolean, denyWritePaths: string[]) {
    if (!['darwin', 'linux', 'win32'].includes(process.platform) || (!this.#windows && !fs.constants.O_NOFOLLOW)) {
      throw error('ENOTSUP', 'This host mount adapter supports macOS, Linux and Windows');
    }
    this.#root = this.#windows ? fs.realpathSync.native(root) : fs.realpathSync(root);
    this.#identity = fs.lstatSync(this.#root, { bigint: true });
    if (!this.#identity.isDirectory()) throw error('ENOTDIR', 'hostPath must be a directory');
    this.#readOnly = readOnly;
    this.#denyWritePaths = denyWritePaths.map(path => this.#fold(path));
  }

  get handleCount() { return this.#handles.size; }

  #rootExists() {
    const current = fs.lstatSync(this.#root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, this.#identity)) {
      throw error('EPERM', 'Host mount root was replaced');
    }
  }

  #fold(path: string) {
    return process.platform === 'darwin' || this.#windows ? path.toLowerCase() : path;
  }

  #writable(relative: unknown, includeChildren = false) {
    if (this.#readOnly) throw error('EPERM', 'Host mount is read-only');
    const path = this.#fold(hostRelativePathParts(relative, this.#windows).join('/'));
    if (this.#denyWritePaths.some(denied => path === denied || path.startsWith(denied + '/') ||
        (includeChildren && (path === '' || denied.startsWith(path + '/'))))) {
      throw error('EPERM', 'Host path is protected from writes');
    }
  }

  #regular(stats: fs.BigIntStats): fs.BigIntStats {
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) ||
        (stats.isFile() && stats.nlink > 1n)) {
      throw error('EPERM', 'Symlinks, hard-linked files and special files are not supported');
    }
    return stats;
  }

  #path(relative: unknown, allowMissing = false): string {
    const parts = hostRelativePathParts(relative, this.#windows);
    let target = this.#root;
    for (let i = 0; i < parts.length; i++) {
      target = join(target, parts[i]);
      let stats: fs.BigIntStats;
      try { stats = this.#regular(fs.lstatSync(target, { bigint: true })); }
      catch (failure) {
        if (allowMissing && i === parts.length - 1 && (failure as NodeJS.ErrnoException).code === 'ENOENT') return target;
        throw failure;
      }
      if (this.#windows) {
        // Use the same native canonical spelling for root and descendants. Do
        // not case-fold: Windows also permits case-sensitive directories.
        const canonical = fs.realpathSync.native(target);
        const prefix = this.#root.endsWith(sep) ? this.#root : this.#root + sep;
        if (canonical !== this.#root && !canonical.startsWith(prefix)) {
          throw error('EPERM', 'Resolved path escapes the host mount root');
        }
      }
      if (i !== parts.length - 1 && !stats.isDirectory()) throw error('ENOTDIR', 'Parent is not a directory');
    }
    return target;
  }

  #notRoot(path: string): string {
    if (path === this.#root) throw error('EPERM', 'Cannot remove or rename the mount root');
    return path;
  }

  #metadata(stats: fs.BigIntStats): HostFileMetadata {
    this.#regular(stats);
    const size = integer(Number(stats.size), 'file size');
    return {
      kind: stats.isDirectory() ? 'directory' : 'file', size,
      // The Rust wire type is u64; pre-epoch times use its unavailable value.
      accessed: (stats.atimeNs < 0n ? 0n : stats.atimeNs).toString(),
      modified: (stats.mtimeNs < 0n ? 0n : stats.mtimeNs).toString(),
      created: (stats.birthtimeNs < 0n ? 0n : stats.birthtimeNs).toString(),
    };
  }

  #file(id: unknown, write = false): HostFileHandle {
    const file = this.#handles.get(integer(id, 'file ID', MAX_U32));
    if (!file) throw error('EBADF', 'Unknown or closed file handle');
    this.#regular(fs.fstatSync(file.fd, { bigint: true }));
    if (write) {
      this.#writable(file.path);
      if (!file.write) throw error('EPERM', 'File handle is not writable');
    }
    return file;
  }

  #seconds(nanoseconds: unknown, previous: bigint): number {
    if (nanoseconds === null || nanoseconds === undefined) return Number(previous) / 1e9;
    if (typeof nanoseconds !== 'string' || !/^\d+$/.test(nanoseconds)) throw error('EINVAL', 'Invalid timestamp');
    const seconds = Number(nanoseconds) / 1e9;
    if (!Number.isFinite(seconds)) throw error('EINVAL', 'Invalid timestamp');
    return seconds;
  }

  call(method: unknown, args: unknown): unknown {
    if (typeof method !== 'string' || !arities.has(method)) throw error('ENOTSUP', 'Unsupported filesystem operation');
    // Rust serializes its unit argument for sync as null.
    if (method === 'sync' && args == null) args = [];
    if (!Array.isArray(args) || args.length !== arities.get(method)) throw error('EINVAL', 'Invalid filesystem arguments');
    // Sync operations keep path checks and I/O in one host event-loop turn.
    // Guest operations cannot create native links through this adapter. Hostile
    // external directory mutation still needs an OS-level openat/capability
    // adapter; this is a PoC boundary.
    // Closing must still release the descriptor if the host moved the root.
    if (method !== 'close') this.#rootExists();
    switch (method) {
      case 'stat': return this.#metadata(fs.lstatSync(this.#path(args[0]), { bigint: true }));
      case 'readDir': {
        const directory = this.#path(args[0]);
        const entries = [];
        for (const name of fs.readdirSync(directory)) {
          const stats = fs.lstatSync(join(directory, name), { bigint: true });
          if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && stats.nlink > 1n)) {
            this.entriesOmitted++;
            continue;
          }
          entries.push({ name, ...this.#metadata(stats) });
        }
        return entries;
      }
      case 'open': {
        const [name, read, write, create, exclusive, truncate, append] = args as [unknown, boolean, boolean, boolean, boolean, boolean, boolean];
        const effectiveWrite = write || append;
        if (args.slice(1).some((value) => typeof value !== 'boolean') || (!read && !effectiveWrite) ||
            (!effectiveWrite && (create || exclusive || truncate))) throw error('EINVAL', 'Invalid open flags');
        if (effectiveWrite) this.#writable(name);
        const path = this.#path(name, create || exclusive);
        const before = this.#windows ? fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }) : undefined;
        if (before) {
          this.#regular(before);
          if (!before.isFile()) throw error('EISDIR', 'Expected a regular file');
        }
        let flags = read && effectiveWrite ? fs.constants.O_RDWR : effectiveWrite ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
        if (create || exclusive) flags |= fs.constants.O_CREAT;
        if (exclusive) flags |= fs.constants.O_EXCL;
        if (append) flags |= fs.constants.O_APPEND;
        // Never truncate until the opened inode has passed the regular-file check.
        if (this.#windows) {
          // Windows has no O_NOFOLLOW. Never follow a newly appeared last
          // component when creating; existing files need no O_CREAT (including
          // hidden files). A concurrent creator can cause EEXIST; callers retry.
          if (before && !exclusive) flags &= ~fs.constants.O_CREAT;
          if (!before && (create || exclusive)) flags |= fs.constants.O_EXCL;
        } else {
          flags |= fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
        }
        const fd = fs.openSync(path, flags, 0o600);
        try {
          const stats = this.#regular(fs.fstatSync(fd, { bigint: true }));
          if (!stats.isFile()) throw error('EISDIR', 'Expected a regular file');
          if (this.#windows) {
            this.#rootExists();
            const after = this.#regular(fs.lstatSync(this.#path(name), { bigint: true }));
            if (!sameFile(stats, after) || (before && !sameFile(before, stats))) {
              throw error('EPERM', 'Host file changed while it was being opened');
            }
          }
          if (this.#nextHandle > MAX_U32) throw error('EMFILE', 'File handle IDs exhausted');
          if (truncate) fs.ftruncateSync(fd, 0);
          const id = this.#nextHandle++;
          this.#handles.set(id, { fd, path: hostRelativePathParts(name, this.#windows).join('/'), read, write: effectiveWrite, append });
          return id;
        } catch (failure) { fs.closeSync(fd); throw failure; }
      }
      case 'read': {
        const file = this.#file(args[0]);
        if (!file.read) throw error('EPERM', 'File handle is not readable');
        const offset = integer(args[1], 'read offset');
        const length = integer(args[2], 'read size', CHUNK_BYTES);
        const bytes = Buffer.alloc(length);
        return bytes.subarray(0, fs.readSync(file.fd, bytes, 0, length, offset));
      }
      case 'write': {
        const file = this.#file(args[0], true);
        const offset = integer(args[1], 'write offset');
        const bytes = args[2];
        if (!(bytes instanceof Uint8Array) || bytes.length > CHUNK_BYTES) throw error('EINVAL', 'Invalid write bytes');
        return fs.writeSync(file.fd, bytes, 0, bytes.length, file.append ? null : offset);
      }
      case 'fileStat': return this.#metadata(fs.fstatSync(this.#file(args[0]).fd, { bigint: true }));
      case 'setLen': fs.ftruncateSync(this.#file(args[0], true).fd, integer(args[1], 'file size')); return null;
      case 'flush': fs.fsyncSync(this.#file(args[0]).fd); return null;
      case 'close': {
        const id = integer(args[0], 'file ID', MAX_U32);
        if (id === 0 || id >= this.#nextHandle) throw error('EBADF', 'Unknown file handle');
        const file = this.#handles.get(id);
        this.#handles.delete(id);
        if (file) fs.closeSync(file.fd); // Rust may close explicitly and again on Drop.
        return null;
      }
      case 'mkdir': this.#writable(args[0]); fs.mkdirSync(this.#path(args[0], true)); return null;
      case 'remove': {
        this.#writable(args[0], true);
        const path = this.#notRoot(this.#path(args[0]));
        if (fs.lstatSync(path).isDirectory()) fs.rmdirSync(path);
        else fs.unlinkSync(path);
        return null;
      }
      case 'rename': {
        this.#writable(args[0], true);
        this.#writable(args[1], true);
        const from = this.#notRoot(this.#path(args[0]));
        const to = this.#notRoot(this.#path(args[1], true));
        fs.renameSync(from, to);
        const source = hostRelativePathParts(args[0], this.#windows).join('/');
        const destination = hostRelativePathParts(args[1], this.#windows).join('/');
        for (const file of this.#handles.values()) {
          if (file.path === source || file.path.startsWith(source + '/')) file.path = destination + file.path.slice(source.length);
        }
        return null;
      }
      case 'setTimes': {
        this.#writable(args[0]);
        const path = this.#path(args[0]);
        const stats = fs.lstatSync(path, { bigint: true });
        fs.utimesSync(path, this.#seconds(args[1], stats.atimeNs), this.#seconds(args[2], stats.mtimeNs));
        return null;
      }
      case 'setFileTimes': {
        const fd = this.#file(args[0], true).fd;
        const stats = fs.fstatSync(fd, { bigint: true });
        fs.futimesSync(fd, this.#seconds(args[1], stats.atimeNs), this.#seconds(args[2], stats.mtimeNs));
        return null;
      }
      case 'sync':
        for (const file of this.#handles.values()) if (file.write) fs.fsyncSync(file.fd);
        return null;
    }
  }

  closeAll() {
    const failures: unknown[] = [];
    for (const { fd } of this.#handles.values()) {
      try { fs.closeSync(fd); } catch (failure) { failures.push(failure); }
    }
    this.#handles.clear();
    if (failures.length) throw new AggregateError(failures, 'Closing host files failed');
  }
}
