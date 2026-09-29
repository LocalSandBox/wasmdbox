# SDK patch ablation record

Removal experiments reduced the initial wrapper's 25 SDK runtime replacements to 19.
The retained replacements handle host mount integration and cleanup (9), enforced TCP proxying (8), and nested worker failure notifications (2).
Third-party declaration files are no longer modified, consumer installation does not patch shared dependencies in `node_modules`, and there is no second public RPC networking interface.

Validation used Node.js 24.15.0, `@wasmer/sdk@0.19.0`, and `wasmer/edgejs-quickjs@=0.1.4`.
The conclusions below apply to the current Node-only API, where each public sandbox owns its worker/client and only the guest accesses mounts.
They do not promise compatibility with all browser and multi-sandbox APIs in the upstream SDK.

| Removal experiment | Observed result | Final decision |
| --- | --- | --- |
| Third-party `.d.ts` extensions for `mounts` / `tcpProxy` | The package's public types compile with the original SDK types; all runtime controls pass | Remove the declaration patch |
| The browser entry point's `tcpProxy` rejection branch and standalone browser worker / service worker / WISP files | Mount, TCP, fetch, and worker failure controls pass through the current Node entry point | Remove the browser guard; exclude standalone browser/WISP files and upstream source maps without source code from the package artifact |
| The SDK main thread's global `installNodeHostFileSystem()` installation | Node and Bash mount access passes, including metadata, directories, 768 KiB binary reads and writes, read-only access, and link rejection | Remove this installation patch and adapter function; retain the guest worker RPC bridge |
| The SDK Sandbox lease field, constructor parameter, close hook, and immediate rollback on creation failure | Closing the client reduces mounts/handles to zero after both normal operation and an injected core startup failure | Remove; the public wrapper closes the entire client, while the adapter still handles transactional rollback on registration failure |
| The above main-thread global installation and Sandbox lease handling removed together | The enhanced Node/Bash mount and failure cleanup tests pass together | Apply the combined removal |
| All runtime patches, using the clean SDK directly | Guest reads of `/mounted/hello.txt` return `ENOENT` | The unmodified SDK cannot be substituted directly |
| The guest worker's host filesystem bridge | Guest mount reads return `ENOENT` | Retain |
| The host worker adapter's host filesystem RPC route | Guest RPC cannot complete; the isolated subprocess is terminated after 20 seconds | Retain |
| Client-level mount cleanup | Both normal close and core startup failure leave 2 mount registrations | Retain; close must revoke mount IDs rather than relying solely on the public worker eventually exiting |
| The enforced TCP patch | A reachable local direct-connect target receives a prohibited guest connection, bypassing the denying proxy | Retain |
| The DNS alias branch | Host DNS resolution of the test domain returns `ENOTFOUND`; the original domain cannot be preserved for the proxy | Retain |
| The prohibition on guest TCP listeners in proxy mode | The listener call no longer throws | Retain |
| The EdgeJS keepalive preload | The same real HTTPS fetch changes from success to `ENOSYS` | Keep the shim for the currently pinned 0.1.4; rerun the comparison without the shim after an upgrade before removing it |
| Nested worker failure forwarding | The SDK logs a real worker failure, but the wrapper's subscriber receives no notification | Retain the minimal module-local hook |

Testing of the final retained code includes 7 positive controls and 10 targeted negative controls, with all 17 outcomes matching expectations.
Failures and timeouts in negative controls are expected evidence, not functional failures of the final package.
The script must pass all positive controls before running removal experiments, and it checks specific errors or expected timeouts. Ordinary registry, installation, or permission failures do not count as evidence from a successful removal experiment.
The two TypeScript adapters also pass the original 15 host filesystem regression tests.

After rebuilding with these 19 replacements, the final full test suite passed 72/72 tests (approximately 21.94 seconds), and the public API examples passed 24/24.
JavaScript execution and strict TypeScript consumption also passed after installing the npm tarball outside the repository.
That installation used `--ignore-scripts` and covered Node/Bash, host mounts, and native HTTPS secret substitution, demonstrating that the package artifact does not depend on consumers applying patches.
Separate failure regression tests cover the public wrapper's parent-process deadline and fatal behavior; they are not included in the 17 SDK patch ablation outcomes above.

The parent-process command deadline was tested in 2 additional public API controls, using isolated copies of the latest build: one complete copy and one with the timer removed.
Each creates a fresh sandbox, then runs `exec(['bash', '-c', 'sleep 1'], { timeoutMs: 20 })` as its first command:

| Public wrapper control | Observed outcome | Conclusion |
| --- | --- | --- |
| Complete parent-process timer | `TIMEOUT`; cancellation completes and the command rejects after approximately 61 ms | Retain the parent-process deadline; reaching the deadline and completing cancellation occur at different times |
| Only the parent-process command timer branch removed | Successfully returns `exitCode: 0` after approximately 1,161 ms | Removing the deadline allows late success; this cold-start path cannot be relied on to terminate on its own |

The removal control deletes only the branch that sets `running.timer` in compiled `sandbox.js`; it does not change the startup deadline, post-cancellation cleanup deadline, or SDK.
The positive control accepts only `TIMEOUT`, or `SANDBOX_UNRESPONSIVE` if cancellation cannot complete. Ordinary creation or environment errors do not count as a pass.
The negative control must actually observe `exitCode: 0`; arbitrary errors cannot substitute for this evidence.
Each copy runs in a fresh Node subprocess, leaving the shared `dist` unchanged.
This comparison demonstrates the need for the parent-process timer without drawing additional conclusions about timeout implementations across all SDK runtimes.

To rerun in a development checkout:

```sh
npm ci --ignore-scripts
npm run test:ablation
```

`test:ablation` independently compiles the current adapters into `.artifacts/ablation/compiled-adapters` without rebuilding or deleting the main `dist`.
Each SDK variant is regenerated from hash-verified, clean upstream files and runs in a fresh Node subprocess.
Variants do not share Wasmer JS initialization state or global worker configuration, and they do not modify the installed SDK.
The latest machine-readable evidence is in `.artifacts/ablation/results.json`; the combined experiment before this round of removals is preserved in `.artifacts/ablation/pre-removal-results.json`.
One or more variant names can be passed as script arguments. Positive controls always run first, even when only negative controls are selected.

The parent-process deadline comparison requires an up-to-date public API build and runs separately:

```sh
npm run build
node scripts/ablation-parent-deadline.mjs
```

The copies and detailed outcomes are written to `.artifacts/ablation/public-parent-deadline/`. Its `results.json` also records the SHA256 of `sandbox.js` before and after modification, along with the exact removed text.
The complete ablation evidence for this round therefore consists of 17 SDK outcomes and 2 public parent-process deadline outcomes, with all 19 matching expectations.

The first run in a restricted environment encountered local `listen EPERM` and registry fetch failures; that run was excluded from the results.
The comparisons require permission for local TCP/HTTPS fixtures and for the SDK to refresh runtime registry metadata. HTTPS uses local test certificates and requires no business credentials.
The 20-second subprocess deadline stops indefinite waits caused by a missing RPC route; it is not the product's default command timeout.

The clean SDK comes from the official npm tarball, whose integrity value matches the lockfile:

```text
sha512-4gdWiIlne8ti3dQl1yD6jrLLNKrQXmZXA6iy6ta/6sgYpixPLwymeGqhMzjAIHqhmwrD+SjPFpZ5ugd9SytDrQ==
```

This round recovered the tarball (1,966,999 bytes) from npm's content-addressed cache, verified it, and extracted it. The SDK already modified in the old project was not treated as the original.
The build script checks the SHA256 of each of 64 upstream files, then applies replacements at exact, unique anchors in the private output.
A normal clean installation uses the upstream files from the development dependency directly. A development directory containing older patches can use a separate source directory verified against the same hashes.
The upstream `LICENSE`, WASM, required workers, and JS snippets retain their original relative layout. Consumers only need to install and import `wasmdbox`, without patches or postinstall scripts.

## Runtime preparation and additional packages

The `prepare()` / `extraPkgs` addition uses the SDK's existing `packages.loadMany()` API. It adds no SDK patches; the build still applies 19 runtime replacements. Preparation and creation share one initialization and package-loading path, with preparation stopping before guest creation. It introduces no runtime handle, persisted manifest, or second cache format.

Two public API controls in `tests/prepare.test.mjs` verify that the operations remain independent:

| Control | Required observation |
| --- | --- |
| Replace SDK sandbox creation and listener startup with throwing functions during preparation | Cold preparation still downloads the default runtime, extra packages, and dependencies without creating a sandbox or proxy |
| Replace the public `Sandbox.prepare()` method with a throwing function during creation | `Sandbox.create()` still downloads missing packages and executes the default Node and extra Python commands |

Additional checks run creation in a separate process with package-body downloads forbidden after preparation, and verify that a cached Python package is unavailable when `create()` does not request it. Duplicate package references are collapsed before loading and after resolution; overlapping commands from distinct packages retain `COMMAND_AMBIGUOUS` instead of an implicit override.

Run these controls and the preparation cancellation/cleanup regressions with `npm run test:prepare` after building. These controls are separate from the 19 earlier SDK and deadline ablation outcomes.
