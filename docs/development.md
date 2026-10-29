# Development

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

## Layout and build

- `src/host`: credential-backed records, owner RPC, owned SSH tunnels and remote native-service maintenance.
- `src/client`: native settings, source-aware workspace navigation, native directory delegation, embedded content layout and views.
- `src/shared`: browser-safe contracts and validation.
- `test`: transport, cancellation, ownership, update recovery and browser integration.

The host build externalizes Harness peer dependencies. The browser bundle uses native ModuleLoader services; React and Electron are not bundled replacements. The local `cordis.patch.yml` disables the separate `ui-sidebar` deployment and registers Connections. The package checker builds and inspects both the main tarball and its nested remote content bundle: runtime exports, ModuleLoader identity, profile patches, allowed files and documentation links. The local and remote host/client entries are built separately. The remote entry excludes the local sidebar and SSH manager. The deterministic build currently uses GNU tar. Local compatibility is exactly rc.3 and checked against its sidebar package; remote compatibility explicitly enumerates tested rc.2 and rc.3 in src/shared/harness-versions.json. The package checker verifies both manifests and entry boundaries.

The build includes the installed native sidebar ModuleLoader factory through a generated adapter. Its dependencies stay external and are supplied through the main manifest. The adapter assigns the compiled CSS ownership and deduplication IDs to Connections, preserving the original CSS and class names. This avoids collisions with Desktop's separately compiled sidebar and lets Harness unload/reload the composed styles correctly. `dist/native-sidebar.LICENSE` preserves its upstream MIT license. Workspace menus and icons resolve the native `dsh-client-ui-primitives` baseline at runtime. Browser fixtures bundle the published primitives and CSS using development-only dependencies; they do not replace the native components with mocks.

The native shortcut provider is retained. Connections checks the exact rc.3 registry implementation at build time and adapts only command resolvers in the live service's private `registry.commands` map. Runtime checks verify registry identity, writable resolver fields and wrapper ownership; disposal restores only wrappers still owned by Connections. Native code owns keyboard/menu dispatch, keybindings, conflicts, revisions, repeat behavior, configuration and service disposal. A failed compatibility check withdraws remote surfaces before restoring local command resolution. No native shortcut factory or replacement Host schema is bundled.

The adapter reuses the original module's `apply`, components and child declarations; it does not vendor a source fork or recreate the sidebar. At runtime a Cordis-isolated `uiWorkspace` facade changes only `startSession` routing, with other methods and accessors bound to their native receiver. Disabling the whole Connections bundle removes its patch and restores the native sidebar deployment.

The remote bundle's profile patch disables `directory-picker` auto selection and registers the existing `dsh-host-directory-picker-browse` and `dsh-client-ui-directory-picker-browse` pair. Both packages are supplied by Harness's Web bundle; the ordinary client row makes its surface available to ModuleLoader. This avoids waiting for a system dialog on a remote graphical desktop without adding a picker implementation or runtime dependency. Package checks require both browse faces and leave local picker composition unchanged.

The remote patch also replaces the `ui-settings` and `ui-settings-account` deployments with their version-checked native factories inside Connections. Bootstrap waits for the view's local presentation snapshot before installing ConfigForms; original locale/theme providers then activate normally. Only the native form accessor for local UI preferences and the account browser capabilities are adapted. Factory CSS is inventoried under Connections, and the remote archive includes `native-settings.LICENSE` and `native-account.LICENSE`. Focused tests execute both supported releases' actual ConfigForms, locale and theme services to verify live local presentation, refused UI writes, retained remote model/permission/privacy writes, and service disposal. These tests do not establish live account authentication or Electron acceptance.

CI also installs the checked release tarball into two disposable native Hosts
on the declared local Harness version and runs the native browser suite. No
compatibility exemptions are granted. See [Harness compatibility](harness-compatibility.md)
for the rc.3 review and integration boundaries.

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

## Acceptance boundaries

Default browser fixtures cover settings, managed-mode creation and explicit update submission, local/remote project choice, iframe isolation, delayed-reply cancellation, native menus and keyboard focus, and overflow in light/dark layouts. Cancellation and delayed SSH discovery use a controlled clock so assertions run after the old reply settles. Layout assertions are functional checks, not screenshot-baseline comparisons. The workspace ViewModel tests cover source-qualified commands, duplicate submissions, stale asynchronous results, lifecycle cleanup and collapse/selection transitions without a DOM. The existing catalog browser fixtures run under React StrictMode to verify the View binding. Native icons, time bucketing and menu keyboard algorithms are reused, not reimplemented or retested. Visual alignment is checked against the real Desktop sidebar; CSS-value assertions and pixel snapshots are not an acceptance substitute. Native integration additionally verifies the installed ModuleLoader bundle, real credential RPC, real SSH forwarding, native directory selection, file tree/preview and local Host restart; its screenshots are acceptance artifacts.

Shell-routing tests execute the installed native sidebar factory with real Cordis and SlotCore. They verify original component and child-slot reuse, source-aware New Session callbacks, isolation from other consumers, correct native method receivers and cleanup. Presentation regressions cover waiting for the native picker or selected session, stale acknowledgements, timeout recovery and cancellation; a successful HTTP response or iframe load alone is not readiness evidence.

Stylesheet lifecycle tests execute the actual Harness ModuleLoader and Cordis
Loader through native-to-Connections replacement, reload and native restoration.
The native browser suite also preloads conflicting original stylesheet IDs and
checks computed button styles, vertical panel layout and menu interaction before
and after the original styles are removed. Same-version Desktop/npm class-name
differences were confirmed against the installed rc.3 Desktop application archive.

SSH discovery tests cover Include resolution, literal patterns, permissions, traversal limits and command-free enumeration. Picker fixtures cover selection and naming, manual fallback, refresh failure/recovery, stale replies and targets removed from configuration. Set `DSH_EXPECT_SSH_HOSTS=1` with an isolated `DSH_WEB_LOG` for the native settings test to require a nonempty real configuration list.

CI browser fixtures do not run Electron. On 2026-10-28, the 0.1.2 build was also
installed into a disposable Windows Desktop rc.3 profile, with a separate
Electron user-data directory and Harness home. CDP checks on the actual installed
application verified native button styles, vertical panel layout, More menu
actions, blank-session draft preservation after the native response, Connections
Settings and renderer reload. The test process was stopped after verification;
the normal Desktop profile was not modified. macOS, Linux Electron and machine
reboot remain untested.

The subsequent workspace MVVM refactor passed 240 Node cases (including SSH and systemd checks), all 26 web fixture cases, and all four installed two-Host cases. An isolated Windows Desktop rc.3 run additionally checked owner-backed rename, temporary search expansion with collapse restoration, row New Session with blank-session/draft reuse, and menu keyboard focus. Its screenshot was manually compared with the native sidebar for icons, spacing and indentation; no pixel-baseline assertions were added. The Controller now publishes immutable source records, with a regression proving earlier loading, partial and error snapshots remain unchanged.

Desktop workspace opening uses the native guest bridge and the reversible native command-resolver adapter. Default Node tests verify native input routing, stale guest/revision rejection, local fallback, adapter disposal, and controller-scoped command ownership without a mounted sidebar. The guest bridge fixtures cover allocation, cleanup, failures and popup delegation. Desktop Settings relay tests cover metadata projection, navigation revisions, readiness and selection replay. Upstream partitions are transient. No model task or account credential migration is exercised.

## Recent native verification

The 2026-10-28/29 rc.3 two-Host run passed all four native cases against installed,
hash-verified release archives. Coverage includes native composition, files/media,
blank-session draft preservation, reload and local-only Host restart. Settings
checks verify remote Models, General returning to the local application, local
language/theme/display preferences projected without remote configuration writes,
slow-load cancellation, repeated Host selection and menu keyboard behavior. A
final run against the current build also opened the remote native Plugin Manager,
verified its package requests target the remote Host, and returned to the original
local session without changing plugin inventory or workspace/session identities.

Native rc.2/rc.3 account-factory tests cover login-link opening, clipboard request
acknowledgement, cancellation and the ordinary browser fallback. Desktop bridge
fixtures exercise the capability boundary; these checks do not establish a
completed account login in the user's running Windows Desktop.

Separate rc.2 and rc.3 installations accepted the remote content bundle and
passed authenticated catalog, workspace/session navigation and native Settings
checks. A damaged installed client was repaired using a new immutable archive
path. These checks do not establish a real systemd cross-version update
transaction, third-party plugin compatibility or provider/model execution.

For the reviewed bugs and maintenance decisions, see [Review findings](review-findings.md).
Re-run the commands above for the current checkout; historical test counts are
not a substitute for checking a changed build.

## 2026-10-29 reference-inspired connection improvements

The [reference comparison](reference-comparison.md) records the three cloned source versions, architecture differences, selected changes and remaining gaps.

Validation of this change passed:

- TypeScript checks, build and release archive verification.
- All 323 Node tests with `DSH_CONNECTIONS_TEST_SSHD=1` and `DSH_CONNECTIONS_TEST_SYSTEMD=1`; no skipped cases. The real OpenSSH control/stdio fixtures additionally verify the new SSH check rejects an unknown key, accepts the explicitly trusted fixture key and leaves `known_hosts` unchanged.
- All 40 browser fixture cases with `DSH_DESKTOP_CONTRACT=1`, including SSH checks before saving, target/form/API replacement, hidden-page polling, stale replies and actual connection-stage display. The fixture server was started independently and a temporary config reused that owned server; the repository's default configuration is unchanged.
- Desktop and Chinese 390px screenshots were inspected. The narrow form had no horizontal overflow.

HTTP regressions measure socket reuse directly: three sequential workspace RPCs use one TCP connection; concurrent requests admit at most eight sockets. Disconnect, removal, destination edit, unexpected tunnel closure and unload close idle sockets, and same-port reconnect uses a new pool. A slow first Host no longer delays every Host beyond the first four. These tests do not measure real Windows latency or establish acceptance on a live Desktop installation. Browser Desktop cases are bridge-contract fixtures, not Electron runs. No user Harness service was restarted or updated, and no model request was submitted.

## 2026-10-29 connection settings flow

The subsequent UI change adds multi-select discovery, manual entry, persistent connection switches, immediate connection after saving, native workspace actions and a latest-compatible update default. Its original SVG also replaces the Connections navigation gear through the guarded slot adapter described in [Design](design.md).

Validation passed all 329 Node cases with real OpenSSH and systemd checks enabled, TypeScript and build checks. Browser coverage now totals 48 passing cases: the full initial 46-case suite followed by all 27 affected settings/SSH cases after the final fixes; the 21 unchanged workspace, Desktop-contract and icon cases were not repeated. Regressions cover partial saves and retries, disabling pending connections, stale replies, shared native modal Escape ownership and focus return, shrinking search results, and aliases matching Object property names. Final English, Chinese 390px and light/dark screenshots were manually inspected; they are not pixel baselines.

An isolated installed rc.3 Harness additionally verified the sidebar logo without changes to other native icons, discovered-host and manual dialogs, Escape closing only the child and returning focus to Add, and a second Escape closing Settings. No page errors occurred. That check saved or connected no SSH target. Its test-owned Host and sshd were stopped afterward. It establishes native Web Settings acceptance, not a new Electron or live remote-update run; the user's Harness service was not restarted or changed.

## 2026-10-29 Desktop enable and settings regression

An isolated Windows rc.3 Desktop reproduced the 0.1.5 first-enable failure: replacing the native shortcut provider temporarily removed the layout's `root` slot, and `RootOutlet` raised `SlotAssemblyError`. The renderer stayed blank while the Desktop and Host processes remained alive. This is distinct from a process crash. Version 0.1.6 retains the native provider and adapts its registered command resolvers; see [compatibility and migration](harness-compatibility.md#updating-an-open-rc3-desktop) for the remaining one-time reload risk when retiring an active 0.1.5 provider.

The settings regression came from applying the ordinary browser origin check to Desktop. Settings now uses the same valid guest-bridge capability as workspace content. The focused check passed TypeScript, the workspace/surface Node test files, and 32 browser cases covering settings and guest leases. New cases exercise the production default gate with a valid bridge, no bridge, an incomplete bridge and an unsupported protocol version. The origin matrix retains the HTTP-loopback restriction for ordinary browsers. These Chromium cases simulate the Desktop capability; they do not establish acceptance of the fixed build in Electron.

The 0.1.6 candidate archive was then installed into a clean, isolated profile of the official Windows Desktop `0.2.1-rc.3`. Live installation, first enable, opening Add, Escape back to Settings, disabling to restore the native sidebar, and re-enabling all passed without a renderer reload. The application retained one vertical navigation rail and consistent native button dimensions through those transitions. No page errors, console errors, renderer crash or window closure were observed. This verifies the clean-install lifecycle; it does not remove the migration caveat for an already active 0.1.5 replacement provider.

That Desktop profile also saved a temporary manual connection to a reserved `.invalid` target through native RPC, displayed the SSH failure, and successfully disabled and removed the record. The native New Session button and Ctrl+N preserved the current reusable blank session and its unsent draft. No page errors occurred. These actions did not connect to a real remote machine or submit a model request; the temporary connection was removed afterward.

Tests and reports must not print launch URLs, proxy settings or private logs. Test-only services and fixtures are removed after verification; remote user configuration and the default Harness home are not modified.
