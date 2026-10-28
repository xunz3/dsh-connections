# Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:browser
pnpm check:package
```

Use a runtime that permits temporary loopback TCP and Unix listeners. Browser tests need Playwright Chromium (`pnpm exec playwright install chromium`). No model account or inference is required.

`pnpm test:browser` runs the web fixtures only. Both Playwright configurations append loopback addresses to `NO_PROXY` and `no_proxy` in the runner process, preserving existing exclusions and proxy settings. This also covers the runner's web-server readiness check; setting only `webServer.env` would not.

The retained desktop guest adapter contracts are opt-in because production desktop opening is disabled:

```sh
DSH_DESKTOP_CONTRACT=1 pnpm test:browser workspaces.desktop.spec.ts
```

These tests simulate the guest bridge in Chromium; they do not validate Electron. Real installed-Host tests use `playwright.native.config.ts` and the setup below. Passing the default Node and browser suites does not establish native Host acceptance.

## Layout and build

- `src/host`: credential-backed records, owner RPC, owned SSH tunnels and remote native-service maintenance.
- `src/client`: native settings, source-aware workspace navigation, native directory delegation, embedded content layout and views.
- `src/shared`: browser-safe contracts and validation.
- `test`: transport, cancellation, ownership, update recovery and browser integration.

The host build externalizes Harness peer dependencies. The browser bundle uses native ModuleLoader services; React and Electron are not bundled replacements. The local `cordis.patch.yml` disables the separate `ui-sidebar` deployment and registers Connections. The package checker builds and inspects both the main tarball and its nested remote content bundle: runtime exports, ModuleLoader identity, profile patches, allowed files and documentation links. The local and remote host/client entries are built separately. The remote entry excludes the local sidebar and SSH manager. The deterministic build currently uses GNU tar. Local compatibility is exactly rc.2 and checked against its sidebar package; remote compatibility explicitly enumerates tested rc.2 and rc.3 in src/shared/harness-versions.json. The package checker verifies both manifests and entry boundaries.

The build includes only the installed native sidebar package's ModuleLoader factory through a generated adapter. Its dependencies stay external and are supplied through the main manifest. `dist/native-sidebar.LICENSE` preserves its upstream MIT license. Workspace menus and icons resolve the native `dsh-client-ui-primitives` baseline at runtime. Browser fixtures bundle the published primitives and CSS using development-only dependencies; they do not replace the native components with mocks.

The adapter reuses the original module's `apply`, components and child declarations; it does not vendor a source fork or recreate the sidebar. At runtime a Cordis-isolated `uiWorkspace` facade changes only `startSession` routing, with other methods and accessors bound to their native receiver. Disabling the whole Connections bundle removes its patch and restores the native sidebar deployment.

The remote bundle's profile patch disables `directory-picker` auto selection and registers the existing `dsh-host-directory-picker-browse` and `dsh-client-ui-directory-picker-browse` pair. Both packages are supplied by Harness's Web bundle; the ordinary client row makes its surface available to ModuleLoader. This avoids waiting for a system dialog on a remote graphical desktop without adding a picker implementation or runtime dependency. Package checks require both browse faces and leave local picker composition unchanged.

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

For the existing user trial's settings test, supply `DSH_WEB_LOG` pointing to its private startup log and run `pnpm exec playwright test native.spec.ts --config playwright.native.config.ts`. `DSH_EXPECT_SSH_HOSTS=1` also requires a nonempty configuration discovery list. That test saves and removes only a marked fake connection without connecting it.

## Acceptance boundaries

Default browser fixtures cover settings, managed-mode creation and explicit update submission, local/remote project choice, iframe isolation, delayed-reply cancellation, native menus and keyboard focus, and overflow in light/dark layouts. Cancellation and delayed SSH discovery use a controlled clock so assertions run after the old reply settles. Layout assertions are functional checks, not screenshot-baseline comparisons. Native integration additionally verifies the installed ModuleLoader bundle, real credential RPC, real SSH forwarding, native directory selection, file tree/preview and local Host restart; its screenshots are acceptance artifacts.

Shell-routing tests execute the installed native sidebar factory with real Cordis and SlotCore. They verify original component and child-slot reuse, source-aware New Session callbacks, isolation from other consumers, correct native method receivers and cleanup. Presentation regressions cover waiting for the native picker or selected session, stale acknowledgements, timeout recovery and cancellation; a successful HTTP response or iframe load alone is not readiness evidence.

SSH discovery tests cover Include resolution, literal patterns, permissions, traversal limits and command-free enumeration. Picker fixtures cover selection and naming, manual fallback, refresh failure/recovery, stale replies and targets removed from configuration. Set `DSH_EXPECT_SSH_HOSTS=1` with `DSH_WEB_LOG` for the native settings test to require a nonempty real configuration list; it saves and removes only a marked test entry without connecting.

Actual Electron desktop rendering, macOS, Windows and machine reboot are not covered by these fixtures. Desktop opening is disabled pending source-aware native menu routing. A default Node test checks that the production installer rejects remote desktop views and releases their lease; the opt-in guest bridge fixtures cover allocation, cleanup, failures and popup delegation. Upstream partitions are transient. No model task, account credential migration or computer-input automation is exercised.

## Recent native verification

The 2026-10-28 two-Host run passed all three native cases against installed,
hash-verified builds. It covered native composition, files/media, reload and
local-only Host restart. Settings checks included Models and plugin inventory,
remote-only preference writes and restoration, unchanged local settings and
workspace/session identities, slow-load cancellation, repeated Host selection,
and menu keyboard behavior. Light and dark/narrow screenshots were inspected.

Separate rc.2 and rc.3 installations accepted the remote content bundle and
passed authenticated catalog, workspace/session navigation and native Settings
checks. A damaged installed client was repaired using a new immutable archive
path. These checks do not establish a real systemd cross-version update
transaction, third-party plugin compatibility or provider/model execution.

For the reviewed bugs and maintenance decisions, see [Review findings](review-findings.md).
Re-run the commands above for the current checkout; historical test counts are
not a substitute for checking a changed build.

Tests and reports must not print launch URLs, proxy settings or private logs. Test-only services and fixtures are removed after verification; remote user configuration and the default Harness home are not modified.
