# CI and npm publishing

The workflows follow the separation used by [local-sandbox](https://github.com/LocalSandBox/local-sandbox/tree/main/.github/workflows): validate the release commit, run CI, and then publish the verified artifact. Public npm and the internal registry at `https://npm.sea.com/` receive the same tarball in independent jobs after CI passes. This package has no native binding matrix to assemble.

## Continuous integration

[CI](https://github.com/LocalSandBox/wasmdbox/blob/main/.github/workflows/ci.yml) runs for pull requests to `main`, pushes to `main`, manual runs, and release validation. Both Ubuntu 24.04 and macOS 14 use the Node version in `.nvmrc` and run:

- A frozen dependency install, TypeScript build, and the complete test suite.
- Type checking and all default standalone examples.
- A tarball install outside the checkout with lifecycle scripts disabled and the installed package made read-only. The consumer checks JavaScript, TypeScript, commands, mounts, HTTPS secrets, bundled Python, and local extra packages.

Linux also runs the SDK patch and parent deadline ablations. The tests use local HTTPS fixtures and need no API credentials, and Wasmer package loading is verified with host fetch blocked. Guest npm installation and the optional public HTTPS example still need network access.

CI runs test files sequentially so separate integration suites do not compete with each other's Wasmer worker pools on hosted runners. Tests that exercise multiple live sandboxes still do so, and command and cleanup deadlines are unchanged.

A separate `Windows runtime` job builds and type-checks on `windows-latest`, runs the complete test suite including local host mounts and native Windows path cases, and executes all 24 default examples. Mount examples must pass. The job also installs and runs the tarball outside the checkout, verifies a guest write persisted through a host mount, and records `hostMountWrite: true` only after successful verification. Windows failures block releases just like the Linux and macOS jobs.

All three platforms also run bundled Python, public HTTPS, and package installation into a persistent host mount. Guest installation and public HTTPS require access to npm and `https://example.com/`; SDK runtime loading requires no registry access.

Each successful Linux run uploads an `npm-package` artifact containing `npm/wasmdbox-VERSION.tgz` and `package-verification.json`. The archive is the same one installed by the consumer test. All three platforms upload their validation reports. Artifacts are retained for 14 days.

## One-time setup

The unscoped npm package name is `wasmdbox`. It was not present in the public registry when this workflow was configured. An npm account with permission to publish the name must create the package before its Trusted Publisher can be configured. npm can still reject an unavailable or reserved name during publication.

1. Ensure GitHub Actions is enabled for this repository. In **Settings → Environments**, create an environment named **`npm`**. Allow deployment from tags matching `v*`; add required reviewers if you want approval before each publication.
2. Complete the first publication with your npm account. From a clean checkout of the desired commit, run:

   ```sh
   nvm use
   npm ci --ignore-scripts
   npm test
   npm run demo
   npm run test:package
   npm login --registry=https://registry.npmjs.org
   npm publish .artifacts/npm/wasmdbox-0.1.0.tgz --ignore-scripts --access public --tag latest
   ```

   Complete npm's browser login and 2FA prompts yourself. The final command publishes an immutable npm version. Adjust the filename and distribution tag if the release version changes; prereleases use `next`. This local bootstrap does not generate GitHub provenance.
3. Open the package's **Settings → Trusted publishing** on npmjs.com and add a GitHub Actions publisher with these exact values:

   | Field | Value |
   | --- | --- |
   | Organization or user | `LocalSandBox` |
   | Repository | `wasmdbox` |
   | Workflow filename | `publish.yml` |
   | Environment name | `npm` |
   | Allowed actions | Enable direct **`npm publish`** |

   Enter the workflow filename without `.github/workflows/`. Current npm configurations allow staged publishing by default, so direct publishing must also be enabled for this workflow.
4. No `NPM_TOKEN` GitHub secret is needed. Once trusted publishing works, npm's package settings can disallow token-based publishing while retaining interactive publication and trusted publishers.

The publish job uses GitHub-hosted runners and `id-token: write` for OIDC. The pinned Node 24 release includes npm 11.12.1, above npm's required 11.5.1. It publishes with provenance and does not restore dependency caches or run package lifecycle scripts. The public GitHub repository URL is recorded in `package.json` as required by npm provenance.

## Internal registry setup

Create a GitHub environment named **`npm-internal`**, allow deployments from `v*` tags, and add these **Secrets** to that environment (repository Actions secrets also work):

| Secret | Value |
| --- | --- |
| `NPM_SEA_USERNAME` | Internal registry username with permission to publish `wasmdbox` |
| `NPM_SEA_PASSWORD` | That account's registry password |

Use the Secrets tab, not Variables. Do not put the values in workflow YAML, commit them, or send them in a pull request. Missing credentials fail the internal publication job.

The internal job currently uses `ubuntu-24.04` GitHub-hosted runners. They must be able to resolve and reach `https://npm.sea.com/` and trust its TLS certificate. If that endpoint requires your private network, configure a runner with that access and update this job's `runs-on`. This workflow uses registry-scoped HTTP Basic authentication over HTTPS; the account must support username/password authentication for npm publishing.

The script registers masks for the username, password, Base64 password and Base64 `username:password` before making authenticated requests. GitHub already masks stored Secrets; explicitly masking derived values follows [GitHub's guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets). It scopes authentication to `npm.sea.com` as required by [npm's auth configuration](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc/#auth-related-configuration).

Credentials are injected only into the publication step. The temporary npm config contains an environment-variable placeholder, and the encoded credential is passed to the npm subprocess through its environment. Credential values never appear in command arguments. npm stdout/stderr are discarded, debug log files are disabled, and failures print only controlled diagnostics without registry response bodies or raw exception details. Configuration and cache files are created outside the checkout, removed in `finally`, and covered by an additional `always()` cleanup step. The internal job uploads no artifacts.

The internal job checks the tarball's SHA512 against the CI report before contacting the registry. Existing versions are skipped only when their integrity matches; a mismatch or an unexpected registry response fails. Publishing explicitly passes `--registry=https://npm.sea.com/` to override the tarball's public `publishConfig.registry`, with package scripts and provenance disabled. The tarball itself is unchanged. Public npm keeps its existing OIDC and provenance flow. Either publication job can be retried independently using GitHub Actions' job rerun controls.

For a local release smoke test, use the exact Node version in `.nvmrc`. Node 24.14.1 can fail to compile the guest WASM with an `exnref` validation error; Node 24.15.0 passes the installed-package check. Build and verify a temporary copy with a unique version such as `0.3.1-internal-smoke.TIMESTAMP`, then publish it with `NPM_TAG=internal-smoke` to keep `latest` and `next` unchanged. `NPM_TAG` accepts lowercase names containing letters, numbers and hyphens, beginning with a letter. Validate registry metadata, download integrity, an independent registry installation and an identical rerun. Test versions remain in the registry.

## Publishing subsequent versions

Update the version on a branch, commit the manifest and lockfile, and merge after CI passes:

```sh
npm version patch --no-git-tag-version
# Or: npm version 0.2.0-rc.1 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release 0.1.1"
```

After that commit is on `main`, create and push its matching tag:

```sh
git switch main
git pull --ff-only
git tag v0.1.1
git push origin v0.1.1
```

[Publish npm](https://github.com/LocalSandBox/wasmdbox/blob/main/.github/workflows/publish.yml) then:

1. Requires the tag to match both manifest versions and the lockfile root version, and requires the tagged commit to be part of `origin/main`.
2. Runs the complete CI workflow against the tagged commit, including the Windows runtime job.
3. Downloads the verified Linux tarball and checks its SHA512 against the consumer test report.
4. Publishes to public npm with OIDC and provenance, and independently to `npm.sea.com` with the configured secrets. Both jobs use `latest` for stable versions and `next` for versions such as `0.2.0-rc.1`.

Pushing `main` alone never publishes to either registry. A failed workflow can be rerun from GitHub Actions after fixing account or environment configuration. An already-published version is skipped only when its registry integrity matches the verified tarball; a different existing artifact fails the release. Registry errors other than a missing version also fail. Changing package contents requires a new version.

wasmdbox's own code is [MIT licensed](../LICENSE). The bundled Wasmer SDK uses its own Modified MIT License. The build preserves the SDK's original `LICENSE` at `dist/vendor/wasmer-sdk/LICENSE`; package verification requires both license files to be present.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the account configuration requirements.
