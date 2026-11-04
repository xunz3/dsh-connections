# Publishing

The npm package is `@xunz03/dsh-connections`; the source repository is
`xunz3/dsh-connections`. npm contains the built plugin, remote content archive,
declarations, licenses and documentation. See [release notes](changelog.md) for
version history and [development](development.md) for local validation.

## Normal releases

1. Increase `version` in `package.json` using an exact semantic version.
2. Commit the change and push to `main`.
3. Watch the **Publish to npm** workflow. Node 22/24 checks, Windows/macOS SSH checks, web browser tests and actual installation/browser acceptance
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
The workflow derives provenance from repository visibility: enabled for public
repositories, disabled for private repositories. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

## Release verification

Use `pnpm check:package --output-dir .release` to build and check both archives.
`node scripts/release.ts artifact` verifies the saved release artifact. Review
the workflow's registry version, dist-tag and integrity verification before
considering publication complete; an accepted upload or dry run is insufficient.

Keep package credentials and local acceptance artifacts out of the repository.
The package checker validates the exported files, native input digests, contracts,
licenses and relative documentation links.
