# wasmdbox standalone examples

Each execution example contains complete public SDK usage in `main.js` and a separate guest source file. Static data lives in that case's `fixtures/` directory. HTTPS fixture setup appears at the end of `main.js`; cases do not share code or fixtures. The optional preparation example downloads packages without running a guest.

```sh
nvm use
npm ci
npm run build
npm run demo                          # Discover and run all numbered cases
node examples/11-api-authorization/main.js
node examples/24-host-mount-write/main.js
```

The host requires Node 24+ and does not need the Wasmer CLI. Examples use the project's `.wasmer/` cache by default; the first run downloads the runtime from the Wasmer registry. Local networking cases listen on loopback and generate their HTTPS certificates in their own processes. `run-all.js` runs cases sequentially, reports failures, and exits with a nonzero status if any case fails.

## Index

| Case | Behavior |
| --- | --- |
| [01-file-read](01-file-read/main.js) | Read a file imported at creation |
| [02-file-write](02-file-write/main.js) | Write and read a virtual file inside the guest |
| [03-host-path-denied](03-host-path-denied/main.js) | Deny direct access to unmounted absolute host paths |
| [04-work-parent-path-denied](04-work-parent-path-denied/main.js) | The parent of the virtual work directory contains no unimported files |
| [05-app-parent-path-denied](05-app-parent-path-denied/main.js) | The parent of the virtual app directory contains no unimported files |
| [06-symlink-denied](06-symlink-denied/main.js) | Guest symlinks cannot expose unmounted host files |
| [07-host-env-hidden](07-host-env-hidden/main.js) | Host environment variables are not inherited by the guest |
| [08-tcp-loopback-denied](08-tcp-loopback-denied/main.js) | Networking is disabled by default, including IPv4 loopback |
| [09-tcp-public-denied](09-tcp-public-denied/main.js) | Networking is disabled by default, including public TCP endpoints |
| [10-tcp-ipv6-denied](10-tcp-ipv6-denied/main.js) | Networking is disabled by default, including IPv6 loopback |
| [11-api-authorization](11-api-authorization/main.js) | The guest uses an API_KEY placeholder; the upstream receives the real Authorization value |
| [12-api-route-header](12-api-route-header/main.js) | Replace a secret in a custom API header |
| [15-docs-no-authorization](15-docs-no-authorization/main.js) | Other domains receive the placeholder, without the API credential |
| [16-docs-route-header](16-docs-route-header/main.js) | Docs uses a header secret within its own scope |
| [18-domain-denied](18-domain-denied/main.js) | Deny domains outside the allow list and confirm no upstream connection occurs |
| [19-domain-suffix-denied](19-domain-suffix-denied/main.js) | Appending an attacker domain suffix cannot bypass the allow list |
| [20-redirect-denied](20-redirect-denied/main.js) | Reject a redirect to a denied target |
| [21-host-header-denied](21-host-header-denied/main.js) | MITM rejects a Host header that differs from the target |
| [22-directory-snapshot](22-directory-snapshot/main.js) | Copy directory contents at creation; guest edits leave host originals unchanged |
| [23-host-mount-read](23-host-mount-read/main.js) | A read-only host mount exposes later host updates and rejects guest writes |
| [24-host-mount-write](24-host-mount-write/main.js) | A writable host mount persists edits, new files, renames, and binary content |
| [26-secret-substitution](26-secret-substitution/main.js) | Replace the same secret in a URL, header, and JSON body |
| [27-command-errors](27-command-errors/main.js) | Nonzero results by default, check:true, and two error classes |
| [28-streaming](28-streaming/main.js) | stdin, streaming stdout, and wait |

Case numbers retain their original meanings. Cases 13, 14, and 17, which performed arbitrary request/response body rewriting, and case 25, which used CLI volumes, have been removed. There are currently 24 numbered cases.

Cases 04 / 05 verify that unimported files do not exist; they do not prohibit all virtual paths containing `..`. Cases 08 / 10 start real loopback listeners and confirm that no connection arrives, in addition to checking the guest error. Cases 18 / 19 also confirm that the fixture receives no connection, so a TLS or connection failure cannot be mistaken for a policy rejection.

## Where files are stored

This release does not expose `sandbox.fs`. `files` copies initial contents into the virtual `/workspace`, where the guest uses its own Node `fs` API. Closing the sandbox does not automatically save those files to the host.

Cases 02 and 22 verify reads and writes inside the guest. Case 22 also checks that the original host fixtures remain unchanged. To retain results, use `mounts` as in cases 23 / 24:

```js
mounts: [{ hostPath: hostDirectory, guestPath: '/mounted', readOnly: false }]
```

In case 24, a guest write to `/mounted/result.txt` writes directly to `result.txt` in the mounted host directory; no export is needed. Both mount examples first copy their fixtures into separate temporary directories, then remove those directories when finished. That cleanup belongs to the examples; `sandbox.close()` does not delete the data.

## Networking and credentials

Guests in cases 11, 12, 15, 16, 20, 21, and 26 use native networking APIs without stdin/stdout RPC. The library handles network initialization, CA trust, and keepalive compatibility. Fixtures return results such as whether authorization succeeded, without echoing real credentials.

Secrets are replaced only within their configured domains and ports. Replacement supports ordinary headers, URL paths and queries, and uncompressed request bodies. Responses are not rewritten, so callers remain responsible for sending credentials only to trusted upstream services.

## Optional external resource checks

Runtime preparation and additional package examples are independent of the numbered cases:

```sh
node examples/prepare/main.js         # Cache the default runtime without creating a guest
node examples/extra-packages/main.js  # Run a Python guest while retaining the default Node runtime
```

`prepare()` is optional. Both examples use the project's `.wasmer/` directory, but `create()` decides which packages to load from its own `extraPkgs` list. The Python example pins `python/python@=3.13.20` and may download additional packages on first use. Packages can export overlapping commands: this Python package also exposes Bash, making an unqualified `bash` command ambiguous. These examples use separate entry points and do not share fixtures.

```sh
npm run test:proxy:online # example.com HTTPS with a non-sensitive demo header
npm run demo:install      # Host downloads a pinned npm archive, then the guest installs it offline
```

The [public HTTPS entry point](11-api-authorization/online.js) accepts a custom HTTPS address through `PROXY_SMOKE_URL`.
The [installation example](package-install/main.js) verifies `is-number@7.0.0` against a pinned SHA512 digest, installs it with guest pnpm, then verifies it with require in another guest process. It is excluded from the default numbered cases so regular demos do not depend on the public npm registry.
