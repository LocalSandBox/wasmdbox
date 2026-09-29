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

Mount points cannot overlap or cover `/workspace`, `/tmp`, `/dev`, runtime directories, or the root directory. The guest uses Node `fs` to access `/mounted`, with operations applied directly to the corresponding host directory. Closing the sandbox releases handles without deleting files written to the mount.

This release does not expose `sandbox.fs`. `files` imports virtual snapshots, while `mounts` exposes real host directories. Small results can be returned through guest stdout, or files can be persisted through a writable mount.

| Example | Behavior |
| --- | --- |
| [22-directory-snapshot](../examples/22-directory-snapshot/main.js) | Copies files into a virtual directory; guest changes do not affect the original host files |
| [23-host-mount-read](../examples/23-host-mount-read/main.js) | The guest sees host updates made after sandbox creation but cannot write |
| [24-host-mount-write](../examples/24-host-mount-write/main.js) | Guest modifications, creation, writes at an offset, truncation, renaming, deletion, and binary reads and writes operate directly on host files |

Examples 23 / 24 each copy their fixtures into a temporary directory, which the example harness deletes afterward. The SDK itself does not delete mounted data.

## Implementation boundaries

The SDK package's private Wasmer adapter forwards guest WASIX file access to the host Node filesystem. It runs in the supervisor Worker; each bridge transfer has a size limit, so large files are processed in chunks. Consumers do not need to install a CLI or modify shared `node_modules`.

- Host mounts currently support macOS / Linux, covering regular files, directories, and basic metadata operations.
- The adapter rejects host symbolic links, regular files with multiple hard links, and special files; checks that paths cannot escape the mount root; and enforces read-only access.
- EdgeJS does not implement every Node filesystem API. For example, `fs.utimesSync()` may return `ENOSYS`.
- File watching, locking, and full POSIX semantics are not guaranteed. Metadata caching for open files may affect the visibility of concurrent host changes.
- Synchronous host I/O blocks that sandbox's supervisor. Path-check races remain when external host processes replace directories concurrently. The adapter does not provide the guarantees of native `openat` or operating-system isolation.
