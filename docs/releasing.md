# Publishing

The npm package is `@xunz03/dsh-connections`. The source repository is
`xunz3/dsh-connections`; it is currently private. npm contains the built plugin,
the remote content archive, declarations, license and usage documentation.

## 0.1.6

- Preserve the running native shortcut provider and its configuration when enabling Connections. Route source-aware commands through a checked, reversible rc.3 registry adapter instead of replacing the service that the native layout depends on.
- Recognize the native Desktop guest bridge in Connections settings so Add and connection controls are available. Keep ordinary browser origin restrictions intact.
- Close or refuse remote views when the native routing contract is unavailable, preserving native local controls.

Migration from an active 0.1.5 installation may still need one renderer reload while its old replacement provider retires. Do not automate that reload or discard unsent drafts. See [Desktop migration and shortcut configuration](harness-compatibility.md#updating-an-open-rc3-desktop).

The 0.1.5 improvements remain available:

- Multi-select SSH discovery, immediate connection after adding, persistent enable switches, failure retry and native workspace actions.
- Original Connections logo in Settings; nested dialogs share native keyboard ownership and restore focus correctly.
- Updates default to the latest verified compatible remote Harness, currently `0.2.1-rc.3`, without an implicit downgrade.
- Read-only SSH diagnostics, bounded HTTP connection reuse, continuously replenished startup workers and visibility-aware settings polling.

Local Harness compatibility remains exactly `0.2.1-rc.3`; remote content supports the verified rc.2 and rc.3 releases. Saved connections and credentials retain their existing storage format.

## Normal releases

1. Increase `version` in `package.json` using an exact semantic version.
2. Commit the change and push to `main`.
3. Watch the **Publish to npm** workflow. Node 22/24 checks, web browser tests and actual installation/browser acceptance
   on the declared local Harness version must pass before publication. The publish job downloads the exact archive
   checked on Node 24, verifies its hash and publishes it without running package
   lifecycle scripts again.

Stable versions use `latest`; prereleases use `next`. An already published
version is skipped, so documentation-only pushes do not create releases. The
workflow rejects a stable version older than the registry's `latest` and checks
the registry version, dist-tag and archive integrity after publishing. A manual
workflow run defaults to a dry run.

The workflow uses npm Trusted Publishing with GitHub OIDC. There is no
`NPM_TOKEN` secret to renew. Its trust configuration must name:

- Repository owner: `xunz3`
- Repository: `dsh-connections`
- Workflow: `publish.yml`
- Environment: leave empty
- Allowed action: direct `npm publish`

Manage this at [npm package settings](https://www.npmjs.com/package/@xunz03/dsh-connections/access).
The workflow automatically disables provenance while the repository is private
and enables it if the repository becomes public; OIDC authentication works in
either case. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

## First publication

A package must exist before configuring its trusted publisher. The bootstrap
release uses `0.1.0-rc.0` and tag `next`, published once through an interactive
maintainer login. After configuring trust, the first stable `0.1.0` is published
by GitHub Actions to verify the complete path.

```sh
pnpm check:package --output-dir .release
node scripts/release.ts artifact
npm publish ./.release/xunz03-dsh-connections-0.1.0-rc.0.tgz --ignore-scripts --access public --tag next
npm trust github @xunz03/dsh-connections --repo xunz3/dsh-connections --file publish.yml --allow-publish
```

Complete npm's browser authentication when prompted; never paste a token into
the repository. Confirm the relationship with `npm trust list
@xunz03/dsh-connections`, then push the stable version bump. A skipped version or
successful dry run does not demonstrate OIDC publication.

## Migrating an unpublished development installation

The old `@xunz/dsh-connections` bundle and the public package must not be installed
together: they compose the same native slots and RPC service. After active tasks
finish, stop the intended Harness process and use its same homes and profile:

```sh
dsh plugin --profile web remove @xunz/dsh-connections
dsh plugin --profile web add @xunz03/dsh-connections
```

Restart that Host. For a managed remote Host, remove the old package using that
service's homes/runtime, then reconnect to install the matching remote content
archive. Do not install the full local package into the remote content profile.
See [remote plugin management](host-settings.md) for the homes and profile.

Keep the managed service directory, credentials and browser storage. Their
internal ownership/state identifiers deliberately remain stable across the npm
scope change. The installer reports an explicit migration instruction while an
old bundle is present instead of installing a conflicting second bundle.
