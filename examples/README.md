# wasmdbox standalone examples

Each execution example contains complete public SDK usage in `main.js` and a separate guest source file. Static data lives in that case's `fixtures/` directory. HTTPS fixture setup appears at the end of `main.js`; cases do not share code or fixtures. The optional preparation example downloads packages without running a guest.

```sh
nvm use
npm ci
npm run build
npm run demo                          # Discover and run the default local examples
node examples/api-authorization/main.js
node examples/host-mount-write/main.js
```

The host requires Node 24+ and does not need the Wasmer CLI. Examples use the project's `.wasmer/` cache by default; the first run downloads the runtime from the Wasmer registry. Local networking cases listen on loopback and generate their HTTPS certificates in their own processes. `run-all.js` runs cases sequentially, reports failures, and exits with a nonzero status if any case fails.

The batch executes all 24 local examples on Linux, macOS and Windows, including read-only and writable host mounts. A mount failure fails the batch on every platform. CI also runs preparation, extra-package, persistent package-installation and public HTTPS examples on all three platforms. Windows mount coverage targets local disk directories; see the [mount guide](../docs/sdk-host-mounts.md) for restrictions.

## Index

| Case | Behavior |
| --- | --- |
| [file-read](file-read/main.js) | Read a file imported at creation |
| [file-write](file-write/main.js) | Write and read a virtual file inside the guest |
| [host-path-denied](host-path-denied/main.js) | Deny direct access to unmounted absolute host paths |
| [work-parent-path-denied](work-parent-path-denied/main.js) | The parent of the virtual work directory contains no unimported files |
| [app-parent-path-denied](app-parent-path-denied/main.js) | The parent of the virtual app directory contains no unimported files |
| [symlink-denied](symlink-denied/main.js) | Guest symlinks cannot expose unmounted host files |
| [host-env-hidden](host-env-hidden/main.js) | Host environment variables are not inherited by the guest |
| [tcp-loopback-denied](tcp-loopback-denied/main.js) | Networking is disabled by default, including IPv4 loopback |
| [tcp-public-denied](tcp-public-denied/main.js) | Networking is disabled by default, including public TCP endpoints |
| [tcp-ipv6-denied](tcp-ipv6-denied/main.js) | Networking is disabled by default, including IPv6 loopback |
| [api-authorization](api-authorization/main.js) | The guest uses an API_KEY placeholder; the upstream receives the real Authorization value |
| [api-route-header](api-route-header/main.js) | Replace a secret in a custom API header |
| [docs-no-authorization](docs-no-authorization/main.js) | Other domains receive the placeholder, without the API credential |
| [docs-route-header](docs-route-header/main.js) | Docs uses a header secret within its own scope |
| [domain-denied](domain-denied/main.js) | Deny domains outside the allow list and confirm no upstream connection occurs |
| [domain-suffix-denied](domain-suffix-denied/main.js) | Appending an attacker domain suffix cannot bypass the allow list |
| [redirect-denied](redirect-denied/main.js) | Reject a redirect to a denied target |
| [host-header-denied](host-header-denied/main.js) | MITM rejects a Host header that differs from the target |
| [directory-snapshot](directory-snapshot/main.js) | Copy directory contents at creation; guest edits leave host originals unchanged |
| [host-mount-read](host-mount-read/main.js) | A read-only host mount exposes later host updates and rejects guest writes |
| [host-mount-write](host-mount-write/main.js) | A writable host mount persists edits, new files, renames, and binary content |
| [secret-substitution](secret-substitution/main.js) | Replace the same secret in a URL, header, and JSON body |
| [command-errors](command-errors/main.js) | Nonzero results by default, check:true, and two error classes |
| [streaming](streaming/main.js) | stdin, streaming stdout, and wait |

The default batch contains these 24 examples, discovered by directory name and run in alphabetical order. `prepare`, `extra-packages`, and `package-install` are optional examples with separate commands below.

`work-parent-path-denied` and `app-parent-path-denied` verify that unimported files do not exist; they do not prohibit all virtual paths containing `..`. `tcp-loopback-denied` and `tcp-ipv6-denied` start real loopback listeners and confirm that no connection arrives, in addition to checking the guest error. `domain-denied` and `domain-suffix-denied` also confirm that the fixture receives no connection, so a TLS or connection failure cannot be mistaken for a policy rejection.

## Where files are stored

This release does not expose `sandbox.fs`. `files` copies initial contents into the virtual `/workspace`, where the guest uses its own Node `fs` API. Closing the sandbox does not automatically save those files to the host.

`file-write` and `directory-snapshot` verify reads and writes inside the guest. `directory-snapshot` also checks that the original host fixtures remain unchanged. To retain results, use `mounts` as in `host-mount-read` and `host-mount-write`:

```js
mounts: [{ hostPath: hostDirectory, guestPath: '/mounted', readOnly: false }]
```

In `host-mount-write`, a guest write to `/mounted/result.txt` writes directly to `result.txt` in the mounted host directory; no export is needed. Both mount examples first copy their fixtures into separate temporary directories, then remove those directories when finished. That cleanup belongs to the examples; `sandbox.close()` does not delete the data.

## Networking and credentials

The authorization, header, redirect, and secret-substitution examples use native networking APIs without stdin/stdout RPC. The library handles network initialization, CA trust, and keepalive compatibility. Fixtures return results such as whether authorization succeeded, without echoing real credentials.

Secrets are replaced only within their configured domains and ports. Replacement supports ordinary headers, URL paths and queries, and uncompressed request bodies. Responses are not rewritten, so callers remain responsible for sending credentials only to trusted upstream services.

## Optional external resource checks

Runtime preparation and additional package examples are independent of the default batch:

```sh
node examples/prepare/main.js         # Cache the default runtime without creating a guest
node examples/extra-packages/main.js  # Run a Python guest while retaining the default Node runtime
```

`prepare()` is optional. Both examples use the project's `.wasmer/` directory, but `create()` decides which packages to load from its own `extraPkgs` list. The Python example pins `python/python@=3.13.20` and may download additional packages on first use. Packages can export overlapping commands: this Python package also exposes Bash, making an unqualified `bash` command ambiguous. These examples use separate entry points and do not share fixtures.

```sh
npm run test:proxy:online # example.com HTTPS with a non-sensitive demo header
npm run demo:install      # Guest installs online into a persistent host mount
```

The [public HTTPS entry point](api-authorization/online.js) accepts a custom HTTPS address through `PROXY_SMOKE_URL`.
The [installation example](package-install/main.js) gives guest pnpm access to the npm registry and installs `is-number@7.0.0` into `.artifacts/package-install/` through `/mounted`. After closing the installer, a new sandbox mounts the saved files read-only and requires `/mounted/node_modules/is-number` with guest networking disabled. The installation remains on the host, and repeated runs reuse the same directory. See the [installation guide](../docs/install-validation.md). This example is excluded from the default batch so regular demos do not depend on the public npm registry.
