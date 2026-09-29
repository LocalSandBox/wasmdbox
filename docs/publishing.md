# CI and npm publishing

The workflows follow the separation used by [local-sandbox](https://github.com/LocalSandBox/local-sandbox/tree/main/.github/workflows): validate the release commit, run CI, and then publish the verified artifact. This package has no native binding matrix to assemble.

## Continuous integration

[CI](https://github.com/LocalSandBox/wasmdbox/blob/main/.github/workflows/ci.yml) runs for pull requests to `main`, pushes to `main`, manual runs, and release validation. Both Ubuntu 24.04 and macOS 14 use the Node version in `.nvmrc` and run:

- A frozen dependency install, TypeScript build, and the complete test suite.
- Type checking and all default standalone examples.
- A tarball install outside the checkout with lifecycle scripts disabled and the installed package made read-only. The consumer checks JavaScript, TypeScript, commands, mounts, HTTPS secrets, runtime preparation, and extra packages.

Linux also runs the SDK patch and parent deadline ablations. The tests use local HTTPS fixtures and need no API credentials, but Wasmer package resolution and downloads require internet access.

CI runs test files sequentially so separate integration suites do not compete with each other's Wasmer worker pools on hosted runners. Tests that exercise multiple live sandboxes still do so, and command and cleanup deadlines are unchanged.

A separate `Windows runtime` job builds and type-checks on `windows-latest`, runs the complete test suite including local host mounts and native Windows path cases, and executes all 24 default examples. Mount examples must pass. The job also installs and runs the tarball outside the checkout, verifies a guest write persisted through a host mount, and records `hostMountWrite: true` only after successful verification. Windows failures block releases just like the Linux and macOS jobs.

All three platforms also run preparation, extra-package, public HTTPS, and package installation into a persistent host mount. These checks require access to the npm and Wasmer registries and `https://example.com/`.

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
4. Publishes with npm OIDC and provenance. Stable versions use `latest`; versions such as `0.2.0-rc.1` use `next`.

Pushing `main` alone never publishes to npm. A failed workflow can be rerun from GitHub Actions after fixing account or environment configuration. An already-published version is skipped only when its registry integrity matches the verified tarball; a different existing artifact fails the release. Registry errors other than a missing version also fail. Changing package contents requires a new version.

wasmdbox's own code is [MIT licensed](../LICENSE). The bundled Wasmer SDK uses its own Modified MIT License. The build preserves the SDK's original `LICENSE` at `dist/vendor/wasmer-sdk/LICENSE`; package verification requires both license files to be present.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the account configuration requirements.
