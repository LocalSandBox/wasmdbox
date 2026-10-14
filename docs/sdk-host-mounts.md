# wasmdbox host directory mounts

```js
import { Sandbox } from 'wasmdbox';

const sandbox = await Sandbox.create({
  files: { '/workspace/guest.cjs': guestBytes },
  mounts: [{ hostPath: './data', guestPath: '/mounted', readOnly: false }],
});
try {
  await sandbox.exec(['node', '/workspace/guest.cjs'], { check: true });
} finally {
  await sandbox.close();
}
```

`hostPath` must point to an existing host directory. Relative paths are resolved against the caller's working directory. `guestPath` uses a normalized absolute path, such as `/mounted`; `readOnly` defaults to `false`.

One mount may use exact `/workspace`, replacing the default storage through `storageHost`. Descendants of `/workspace`, overlapping mounts, `/.wasmdbox`, `/tmp`, `/dev`, runtime directories and the root directory remain reserved. The guest uses Node `fs` to access `/mounted`, with operations applied directly to the corresponding host directory. Closing the sandbox releases handles without deleting files written to the mount.

This release does not expose `sandbox.fs`. `files` imports into the workspace: temporary memory without a `/workspace` host mount, or persistent host files when that mount exists. Files overwrite matching paths and obey `readOnly`/`denyWritePaths`. Imports are not transactional: creation errors, timeout and cancellation can leave partial writes and created directories. The SDK does not roll back or automatically retry failed creation. Small results can be returned through guest stdout, or files can be persisted through a writable mount.

| Example | Behavior |
| --- | --- |
| [directory-snapshot](../examples/directory-snapshot/main.js) | Copies files into a virtual directory; guest changes do not affect the original host files |
| [host-mount-read](../examples/host-mount-read/main.js) | The guest sees host updates made after sandbox creation but cannot write |
| [host-mount-write](../examples/host-mount-write/main.js) | Guest modifications, creation, writes at an offset, truncation, renaming, deletion, and binary reads and writes operate directly on host files |

`host-mount-read` and `host-mount-write` each copy their fixtures into a temporary directory, which the example harness deletes afterward. The SDK itself does not delete mounted data.

## Implementation boundaries

The SDK package's private Wasmer adapter forwards guest WASIX file access to the host Node filesystem. It runs in the supervisor Worker; each bridge transfer has a size limit, so large files are processed in chunks. Consumers do not need to install a CLI or modify shared `node_modules`.

- The host mount adapter supports macOS, Linux and Windows local disk directories, covering regular files, directories, and basic metadata operations. Windows support requires no native addon; UNC/SMB shares and mapped network drives are outside the tested contract.
- The adapter rejects host symbolic links, regular files with multiple hard links, and special files; checks that paths cannot escape the mount root; and enforces read-only access.
- EdgeJS does not implement every Node filesystem API. For example, `fs.utimesSync()` may return `ENOSYS`.
- File watching, locking, and full POSIX semantics are not guaranteed. Metadata caching for open files may affect the visibility of concurrent host changes.
- Synchronous host I/O blocks that sandbox's supervisor. Path-check races remain when external host processes replace directories concurrently. The adapter does not provide the guarantees of native `openat` or operating-system isolation.

## Windows paths and file semantics

Use an existing local directory as `hostPath`, for example `'C:/data'` or `'C:\\data'` in JavaScript. Relative paths resolve against the caller's working directory. The guest still accesses POSIX paths such as `/mounted/report.txt`; it does not use drive letters. Unicode names and spaces are supported.

The adapter canonicalizes the selected root and rejects symbolic links and junctions within it. Guest path components cannot contain Windows reserved characters, device names such as `NUL` or `COM1.txt`, NTFS alternate data stream syntax (`file:stream`), or trailing dots/spaces. These restrictions do not change valid POSIX filenames on macOS/Linux.

Windows does not provide Node's `O_NOFOLLOW` protection. The adapter checks components and canonical paths, then compares file identities before and after opening, before any truncation or guest data access. Creating a previously absent file uses exclusive creation; a concurrent creator can cause `EEXIST`, which the caller can retry. These checks are not atomic against another host process deliberately replacing directories between checks and I/O; this race limitation also exists for intermediate directories in the POSIX adapter.

Append writes use native append handles. On Windows, truncation through an append handle may fail because that handle lacks the necessary write access; open a normal writable handle to resize a file. Host ACLs, file sharing restrictions, and filesystem errors remain effective. The adapter does not modify ACLs or emulate full POSIX permissions.

## Read-write workfolders (0.2.0)

`denyWritePaths: [".seawork"]` protects mount-relative subtrees while leaving them readable. The policy checks path components, all write APIs and handles, and moves of ancestors. macOS and Windows comparisons are case-insensitive. Existing external host mutation remains outside this adapter's concurrency guarantees.

Directory enumeration now skips symlinks, hard-linked files and special files; direct access still fails. `CommandResult.hostEntriesOmitted` is an optional cumulative count of skipped entries across the sandbox lifetime (repeated enumerations count again). A successful listing or search is not proof of complete results or compatibility with host node_modules/venv layouts.

Only oversized readDir responses retry with a larger buffer, up to 32 MiB. Oversized mutating RPC responses never retry. Exact `/workspace` is supported as host storage in 0.3.0, and both workspace and ordinary host mounts support direct command `cwd` (including subdirectories). No bootstrap is required.

## Private runtime storage (0.3.0)

The supervisor installs a direct synchronous filesystem bridge using the same adapter as nested-worker RPCs. Both routes preserve error codes and omit native paths from errors. This supports SDK initialization and cwd checks as well as guest I/O.

Managed CA bundles use `/.wasmdbox/ca.pem`, a private read-only mount backed by a parent-owned temporary directory. Neither startup nor networking writes SDK files to the user's workspace, including when users have `.wasmdbox`, `.seawork-runtime` or `guest.cjs` files. Public mount parameters cannot mint internal mount capabilities. The old `/workspace/.wasmdbox` name is ordinary user data.

Only sandboxes requiring managed trust allocate this directory. It is deleted after the runtime worker terminates on normal close, failed creation, startup timeout/cancellation, or worker/proxy failure; repeated close is safe. A command cancellation leaves the sandbox alive until close. Forced termination of the whole owning host process does not guarantee immediate cleanup. Use `network.caCerts` for extra CA trust; an existing imported `NODE_EXTRA_CA_CERTS` file is merged when managed trust is enabled.
