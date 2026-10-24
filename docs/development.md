# Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:browser
pnpm check:package
```

Use a runtime that permits temporary loopback TCP and Unix listeners. Browser tests need Playwright Chromium (`pnpm exec playwright install chromium`). No model account or inference is required.

## Layout and build

- `src/host`: credential-backed records, owner RPC, owned SSH tunnels and remote native-service maintenance.
- `src/client`: native settings, source-aware workspace navigation, native directory delegation, embedded content layout and views.
- `src/shared`: browser-safe contracts and validation.
- `test`: transport, cancellation, ownership, update recovery and browser integration.

The host build externalizes Harness peer dependencies. The browser bundle uses native ModuleLoader services; React and Electron are not bundled replacements. `cordis.patch.yml` registers the host plugin. The package checker builds and inspects both the main tarball and its nested remote content bundle: runtime exports, ModuleLoader identity, embedded profile patch, allowed files and documentation links. Both bundles contain identical client code. The deterministic build currently uses GNU tar.

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

For the existing user trial's settings test, supply `DSH_WEB_LOG` pointing to its private startup log and run `native.spec.ts`. `DSH_EXPECT_SSH_HOSTS=1` also requires a nonempty configuration discovery list. That test saves and removes only a marked fake connection without connecting it.

## Acceptance boundaries

Browser fixtures cover settings, managed-mode creation and explicit update submission, local/remote project choice, iframe isolation, guest lease cleanup and failures, delayed-reply cancellation, OAuth popup delegation and responsive light/dark layout. Native integration additionally verifies the installed ModuleLoader bundle, real credential RPC, real SSH forwarding, native directory selection, file tree/preview and local Host restart.

SSH discovery tests cover Include resolution, literal patterns, permissions, traversal limits and command-free enumeration. Picker fixtures cover selection and naming, manual fallback, refresh failure/recovery, stale replies and targets removed from configuration. Set `DSH_EXPECT_SSH_HOSTS=1` with `DSH_WEB_LOG` for the native settings test to require a nonempty real configuration list; it saves and removes only a marked test entry without connecting.

Actual Electron desktop rendering, macOS, Windows and machine reboot are not covered by these fixtures. Desktop opening is disabled pending source-aware native menu routing; its public guest bridge contract is tested with a fixture and upstream partitions are transient. No model task, account credential migration or computer-input automation is exercised.

## Verified on 2026-10-24

Unified Workspaces update:

- TypeScript, production build and package validation passed. The main tarball contains 28 files and includes a separately verified remote content bundle.
- The 126-case Node suite passed with real local OpenSSH and native systemd syntax checks enabled, with no skips. A subsequent startup-restoration regression was added; all 19 controller cases passed after that fix (127 Node cases in total).
- Twenty-eight browser fixture cases cover settings, source-qualified rows, local/remote navigation and guest bridge contracts.
- Both real two-Host integration cases passed against Harness `0.2.1-rc.2`. They verified one Workspaces sidebar, native directory selection, text preview, real attachment upload and relative Markdown images on the remote origin. A page reload and a local-only Host restart recovered the same remote session while the remote process stayed alive.
- Native user-customized archive/fork shortcuts in the parent sidebar were consumed safely: no corresponding local Host request or local archive mutation occurred.
- The original isolated user trial was refreshed and its installed native settings/SSH-discovery test passed. Final remote-content and restart screenshots were inspected.

Earlier SSH picker acceptance: 67 Node tests, 21 browser fixtures and the native settings test passed. Discovery's permission-error fix was also tested on Node 22.12.0 and 26.5.0 (10 cases each). Light/dark and Chinese mobile captures were inspected. These earlier checks do not add a new remote lifecycle or Electron acceptance claim.

Earlier persistent-workspace acceptance:

- TypeScript, production build and 56 Node tests passed with both real OpenSSH and native systemd syntax checks enabled, with no skips.
- Fourteen browser fixture cases passed. Light/dark, mobile forms and the host chooser were also inspected as rendered images.
- Two native integration cases passed against installed Harness `0.2.1-rc.2`: credential settings and actual SSH project/file-tree access. Restarting only the local Host preserved the tunnel origin, selected native session and open file preview; the target process remained alive.
- On an authorized remote Linux server, the real managed service survived local controller exit. An explicit `0.2.1-rc.2` to `0.2.1-rc.3` update finished after its controlling SSH process was cancelled, and a new controller authenticated to the new process. A controlled return to `rc.2` also succeeded.
- That server's full browser UI was **not** accepted: its direct loopback HTML returned 200 with 37,448 bytes in 5 ms, while the SSH path stalled. Independent plain SSH large-output checks also stalled with default, IPQoS and compression settings. The native UI acceptance above uses the isolated real OpenSSH fixture; do not conflate authentication on this server with full UI verification.
- A real npm tarball passed export, ModuleLoader, file-boundary and documentation-link checks. No package was published and no Git remote was pushed.

Tests and reports must not print launch URLs, proxy settings or private logs. Test-only services and fixtures are removed after verification; remote user configuration and the default Harness home are not modified.
