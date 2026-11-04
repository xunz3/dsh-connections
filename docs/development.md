# Development

## Source layout

- `src/host`: credential-backed records, owner RPC, SSH tunnels and remote service maintenance.
- `src/client`: connection settings, workspace navigation and remote content views.
- `src/shared`: browser-safe contracts and validation.
- `test`: transport, ownership, lifecycle and browser integration tests.

## Setup and checks

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:browser
pnpm check:package
```

Use a runtime that permits temporary loopback TCP and Unix listeners. Browser tests need Playwright Chromium (`pnpm exec playwright install chromium`). No model account or inference is required.

`pnpm test:browser` runs the web fixtures only. Both Playwright configurations append loopback addresses to `NO_PROXY` and `no_proxy` in the runner process, preserving existing exclusions and proxy settings. This also covers the runner's web-server readiness check; setting only `webServer.env` would not.

Desktop guest lease contracts can also run in Chromium (real Electron validation is separate):

```sh
DSH_DESKTOP_CONTRACT=1 pnpm test:browser workspaces.desktop.spec.ts
```

These tests simulate the guest bridge in Chromium; they do not validate Electron. Real installed-Host tests use `playwright.native.config.ts` and the setup below. Passing the default Node and browser suites does not establish native Host acceptance.

## Build and package

The build uses GNU tar and produces separate local and remote artifacts. Harness
peer dependencies remain external; native ModuleLoader supplies client services.
React and Electron are not bundled replacements. The remote archive excludes SSH
management. `pnpm check:package` rebuilds and checks exports, profile patches,
ModuleLoader identity, native input digests, contracts, licenses and documentation
links in both archives.

The local patch registers Connections without disabling the native sidebar.
Owned controls are tested alongside native controls, and both production Client
bundles reject Harness Client runtime imports. Remaining native adapter boundaries
are documented in [compatibility](harness-compatibility.md); navigation and UI
ownership are described in [unified workspaces](unified-workspaces.md).

## Transport and service tests

The opt-in real OpenSSH test uses a temporary localhost sshd, keys and config. It never edits user SSH configuration:

```sh
DSH_CONNECTIONS_TEST_SSHD=1 pnpm test
```

It requires `/usr/sbin/sshd`, `ssh-keygen` and permission to start the temporary server as the current user.

Set `DSH_CONNECTIONS_TEST_SYSTEMD=1` as well when `systemd-analyze` is available to validate generated unit syntax with native systemd. The completed Linux check used both opt-in flags; neither test was skipped.

Lifecycle tests run the actual remote maintenance source against isolated command fixtures and a real native-auth-shaped HTTP endpoint. They cover reuse, explicit upgrades, service ownership, failed staging, rollback, interrupted snapshots and controller cancellation. These tests exercise transaction behavior; actual systemd syntax and npm installation must also be checked on an authorized Linux machine.

For a live lifecycle check, call the host-only `prepareHost` / `updateHost` with an isolated `RemoteHostOptions.remoteRoot`, distinct unit name and explicit SSH target. Do not expose these test hooks through RPC. Keep returned tokens only in private temporary files. Clean up only the test-owned unit, package root and fixture files, leaving the user's default Harness untouched.

## Native browser integration

Use disposable Harness homes, private startup logs and the two-Host helper:

```sh
DSH_QA_UNIFIED=1 DSH_QA_CLI=/absolute/path/to/dsh/lib/bin.js \
  node test/integration/native-fixture.mjs start /tmp/dsh-native-fixture

DSH_UNIFIED_FIXTURE=/tmp/dsh-native-fixture \
  pnpm exec playwright test unified-native.spec.ts --config playwright.native.config.ts

node test/integration/native-fixture.mjs stop /tmp/dsh-native-fixture
```

The helper installs the normal plugin in a local profile and `dist/remote-plugin.tgz` in a separate content profile. A real isolated sshd forwards between them using temporary keys/config. No user SSH configuration or default Harness home is modified. Only public process/address metadata and private log paths are printed. Full commands and restart behavior are in `test/integration/README.md` in the source checkout.

For the standalone settings test, supply `DSH_WEB_LOG` pointing to an isolated Host's private startup log and run `pnpm exec playwright test native.spec.ts --config playwright.native.config.ts`. `DSH_EXPECT_SSH_HOSTS=1` also requires a nonempty configuration discovery list. The test adds a marked existing-service connection to a reserved `.invalid` target, immediately switches off its automatic connection attempt, checks persistence and removes it. It never installs a remote service.

## Latest recorded validation — 2026-11-04

These are the recorded 0.1.9 release checks, not a claim that each documentation
edit reruns platform acceptance. Local artifacts are excluded from Git.

| Check | Recorded result |
| --- | --- |
| TypeScript, production build and package | Passed export, input-integrity, contract and documentation-link checks. |
| Node suite | 541 passed, one Windows-only test skipped on Linux; real OpenSSH and systemd syntax opt-ins enabled. |
| Chromium fixtures | 100 passed with `DSH_DESKTOP_CONTRACT=1`, including six native-theme cases. Guest bridge fixtures simulate Desktop; they do not run Electron. |
| Packaged Windows Desktop rc.5 | Electron 44.7.0 / Chromium 152.0.7977.130 in an isolated profile. Six light/dark × normal/narrow/forced-color control cases passed, plus native titlebar collapse/restore. Forced colors were emulated. |
| Windows → isolated WSL Host | Real OpenSSH connection, native directory selection, remote project row, file tree/text preview and remote Models/plugin settings navigation passed in an actual guest. No account sign-in or model request was submitted. |
| Real minimize/restore | Both parent and guest became hidden; zero Connections API requests in a 10.004-second settled window. Restore retained the preview. This does not measure CPU/RSS or all native traffic. |

For Desktop visibility checks, use
`chromium.connectOverCDP(endpoint, { noDefaults: true })`: Playwright's default
focus emulation can keep a minimized document reporting `visible`. Confirm
actual window minimization and document visibility rather than synthesizing
visibility events. The test-owned processes were stopped after acceptance.

## Acceptance boundaries

The isolated rc.5 two-Host suite on 2026-11-03 initially passed 4/5; its workspace
case saw an unauthorized direct `viewState` read and route-cleanup error, then
passed unchanged on a focused rerun. Resource sampling completed 20/20 warm
navigations, but an earlier sample timed out presenting remote content.

On 2026-11-04, one isolated WSL startup timed out while the process was in I/O
wait; the next unchanged start succeeded. A Desktop local-to-remote reopen also
hit the 30-second presentation timeout. Later directory/file/Settings checks
passed, but the intermittent authorization/presentation failures have no
confirmed root cause. These runs are not a clean full-suite native acceptance.

Still unverified or incomplete:

- Full macOS/Linux Electron UI coverage, OS text scaling, system high contrast and screen-reader interaction.
- Original Windows `spawn UNKNOWN` cause, complete install/crash recovery, and real cross-version systemd update/rollback and reboot recovery.
- Live account authorization/model requests and third-party profile combinations.
- Large catalogs, multi-connection overhead, hidden CPU/RSS, peak heap, full wire bytes and before/after performance comparisons.

Node/browser suites cover behavior, stale replies, authority replacement,
cancellation, focus and lifecycle. CI additionally installs the checked archive
in native local/remote runtimes. Neither mocked guest tests nor platform SSH
tests alone establish complete Desktop support. See [performance](performance.md)
for measurement methods and [roadmap](roadmap.md) for remaining product work.
