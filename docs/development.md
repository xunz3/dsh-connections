# Development

Current source behavior and partial/unimplemented review items are recorded in the [review follow-up](<review-followup.md>). The latest verification is below; older dated entries describe their historical archives, not the current working tree.

## 0.1.9 release validation — 2026-11-04

TypeScript and the production build passed. The 54-file npm package and its
remote archive passed export, input-integrity, contract and documentation-link
checks. All **100 Chromium fixture tests** passed with
`DSH_DESKTOP_CONTRACT=1`, including the six native-theme cases. These fixture
checks complement the packaged Windows/WSL evidence below.

The first full Node pass exposed a stale hand-written theme-token allowlist:
the corrected primary-button tokens existed in rc.5 but were absent from the
list. The contract test now checks definitions in the installed native theme,
and its seven focused UI/theme regressions pass. No production styling was
changed during release preparation. The subsequent full run passed **541 tests**,
with **one Windows-only test skipped** on Linux and no failures. Both real
OpenSSH and systemd validation opt-ins were enabled.

The previously observed remote-reopen presentation timeout remains unresolved;
publication does not turn the earlier partial native acceptance into a clean
full-suite result. GitHub Actions runs the installed local/remote runtime matrix
against its checked release archive before npm publication.

## Windows Desktop and WSL acceptance — 2026-11-04

The checked candidate was loaded into a separate instance of the **packaged
Windows Harness rc.5**, Electron **44.7.0**, Chromium **152.0.7977.130**. It used a
temporary `DSH_HOME`, a separate `--user-data-dir` and a loopback-only debugging
port. Production dependencies were installed offline with the bundled Windows
Node/pnpm and install scripts disabled. Native PluginManager reported the
Connections entry `active`; installed Client/Host hashes matched the workspace
build after installation. The executable and application code were not patched.

| Check | Observed result |
| --- | --- |
| Actual Desktop Connections controls | **6/6** light/dark × normal/narrow/forced-color cases passed. Native theme settings and Windows window resizing were used; narrow content width was 584 px. Host-menu/dialog bounds, enabled management-button normal/hover contrast, modal Tab wrapping, Escape and focus return were checked. Forced colors remain Chromium emulation. |
| Windows titlebar | Native Collapse sidebar hides the workspace region; native **Open sidebar** restores it with the candidate still active. The initial test expected the wrong label, “Expand sidebar”; the actual control passed the corrected focused check. |
| Windows → WSL SSH | The existing Windows `WSL_Ubuntu` alias connected to a new, isolated WSL Host running the current remote candidate. No SSH config or saved remote service was changed. |
| Actual Electron guest | Native remote directory selection, presentation acknowledgment, unified remote project row, file tree and nested text preview passed in a real `webview`. |
| Actual minimize/restore | Windows `IsIconic` confirmed minimization, and both parent and guest reported `hidden`. After a two-second settling period, **zero Connections API requests** were observed across those pages for **10.004 seconds**. Restore returned both to `visible` and retained the file preview. This is a bounded request observation, not a CPU/RSS or all-network budget. |
| Remote native Settings | The real guest displayed Models and switched between Built-in plugins and Models using guest mouse input. The first attempt was intercepted by the native Preview Notice; its Continue button was used before verifying the underlying controls. No provider credentials or model request were submitted. |

Use `chromium.connectOverCDP(endpoint, { noDefaults: true })` for Desktop
visibility checks. Playwright's default focus emulation kept the document
reporting `visible` during real minimization. Disabling emulation through a
second CDP session did not remove the original session's override; reconnecting
with `noDefaults` did. Do not interpret that harness artifact as a product
background-polling failure, or synthesize visibility events to make a test pass.

Failures remain recorded: the first isolated WSL startup timed out while the
process was observed in I/O wait; a subsequent unchanged startup succeeded.
One Desktop local-to-remote reopen also reached the 30-second presentation
timeout. A diagnostic reopen then showed the native picker with no observed
HTTP/script errors, and subsequent project/file/Settings checks passed. The
presentation timeout's root cause is **not confirmed**; these passing checks do
not close the earlier authorization/navigation stability item. No clean full
five-case WSL-suite rerun or complete Desktop feature matrix is claimed.

Local evidence is under `.release/acceptance-20261104/`, including the six theme
screenshots, titlebar screenshots, remote file/Settings screenshots and JSON
results. Both test-owned Desktop and WSL process trees were stopped afterwards;
the original Windows Desktop and WSL WebUI remained running. macOS, OS text
scaling/system high contrast, screen-reader interaction, large catalogs and
before/after resource comparisons remain outside this pass.

### Existing user instances checked before acceptance

Windows Desktop is accessible from WSL and must not be classified as unavailable
merely because the test runner is on Linux. The running packaged Harness is
rc.5; a read-only Windows UI Automation probe found its visible window and native
titlebar/sidebar controls. Its current launch has no browser remote-debugging
port. This confirms an automation entrypoint, not complete Desktop acceptance.

The existing WSL Web Host returned HTTP 200 in a separate browser context. Its
installed Connections content layout intentionally shows “Open this remote
workspace from Connections on your computer” on a direct visit. Testing that
profile's remote content requires the owning Connections entrypoint; a complete
standalone Web test uses a normal Web profile. This was not an authorization
failure. No current user Host or Desktop process was restarted or reconfigured.

Both live installations have Client/Host artifact hashes different from the
workspace build; Windows lists the published Connections 0.1.8 dependency.
The candidate was therefore installed in the separate test profile described
above. The earlier isolated WSL two-Host suite already exercised actual native
Harness Web UI and SSH; “native” does not mean Windows-only or Desktop-only.

## Theme follow-up and native resource baseline — 2026-11-03

The two theme regressions from the workspace review are fixed: primary buttons
use the native primary fill/hover/foreground tokens, and connecting/updating
indicators use `--dsw-alias-state-warn-primary`. Management button hover now uses
`--dsw-alias-interactive-bg-hover`. The old statement that owned controls were
neither implemented nor tested here has also been corrected below.

- The existing owned/native UI coexistence suite passed **12/12** after the CSS fixes.
- The expanded theme suite passed **6/6**, loading the installed rc.5 theme CSS,
  not hand-written substitute token values. Light/dark cases cover controls,
  host menus, the add-connection dialog and workspace rows at narrow widths,
  ordinary colors, forced colors, and 200% CSS zoom. Checks include primary
  contrast, focus visibility/return, modal Tab wrapping, row keyboard navigation,
  horizontal bounds and nontransparent status indicators outside forced colors.
  Three representative screenshots were inspected. CSS zoom and Chromium forced
  colors are emulations, not OS text scaling, screen-reader or Windows/macOS
  Desktop acceptance. In forced colors, status also retains its accessible label.
- Actual rc.5 primary-button hover contrast measured **9.59:1 light / 16.24:1 dark**.
- TypeScript, theme source checks, script syntax and diff whitespace passed.
  The candidate build and both package boundaries passed (**54 packaged files**).
- A fresh installed rc.5 two-Host/OpenSSH run passed **4/5** initially. The workspace
  case encountered an unauthorized response in the test's direct `viewState`
  read, followed by a route-cleanup error. That case passed unchanged on a focused
  rerun (**1/1**). This is not recorded as a clean five-case run or a resolved
  authorization flake. Fixtures use isolated homes, keys, projects and processes.
- Real current-candidate resource samples and their limitations are recorded in
  [performance](<performance.md>). The final sample completed 20/20 navigations;
  an earlier presentation timeout remains unresolved. All test-owned Host and
  SSH processes were stopped after sampling. No model inference, account authorization,
  existing user profile or saved remote service was used.

```sh
./node_modules/.bin/playwright test --config test/browser/client-ui.config.ts
./node_modules/.bin/playwright test --config test/browser/theme-acceptance.config.ts
./node_modules/.bin/tsc --noEmit
node --import tsx --test test/theme-chrome.test.ts
node --check scripts/profile-native.mjs
git diff --check
```

## Previous rc.5 dependency convergence — 2026-11-01

Agent Team implementations and read-only cross-checks were integrated without resetting the pre-existing dirty tree. Both browser artifacts now reject Harness Client runtime module imports. UI controls and stores are owned source; native Account stays independently installed and delegates its two real login seats through public slot injections. The native navigation icon DOM mask is removed. One reviewed Settings constructor/store composition and one narrowly scoped private shortcut registry boundary remain; this is not a claim that all factory/private-API debt is gone. See [compatibility](<harness-compatibility.md>) and [artifact costs](<performance.md>).

Final source gates on WSL/Linux, Node v26.5.0:

| Gate | Result |
| --- | --- |
| Complete TypeScript, script syntax and diff whitespace | Passed. |
| Complete Node suite, real SSH/systemd opt-ins | **542 cases: 541 passed, one Windows-only case skipped, zero failures** (105.5 seconds). Real ControlMaster/stdio forwarding and native unit syntax checks ran. |
| Complete Chromium fixture suite, Desktop contracts enabled | **94 passed** (2.7 minutes). Includes 12 native-primitives coexistence cases; Desktop contracts are not Electron. |
| Production local/embedded build and declaration emit | Passed; both emitted Client graphs reject native Client runtime imports. |
| Main/nested package validation | **54 packaged files**; exports, ModuleLoader evaluation, contract/input integrity, licenses, independent Account activation and packaged documentation links checked. |
| Installed real rc.5 two-Host/OpenSSH suite | **5/5 passed** (2.2 minutes on the startup-fix candidate): direct embedded boot, native sidebar/style independence, hot disable/re-enable with an unsent draft, actual local/SSH projects/files/upload/media/New Session, and native remote Models/Plugins with local General/presentation. Refresh and local Host restart restore the same remote session while the remote process identity stays unchanged. All test-owned Host/sshd listeners were closed. |
| Actual published native startup composition | **13/13 passed**, including native-first and remote-catalog-first completion, blank reuse, abort/queued-arm cleanup, empty baseline recheck, lazy invalid-preference handling and mock-clock bounded fallback. |

The first rc.5 baseline failed a test's unbound Linux Web `Control+n` assumption. Native acceptance now records a real binding through the native shortcut editor, verifies its persisted profile and restores the native default afterwards; request origin/session/draft assertions remain. A later installed candidate exposed a real product race: native automatic blank restoration also calls `beginNavigation`, which the observer mistook for user navigation and removed the saved remote selection. A captured storage stack proved that chain. The fix waits for the published first-main binding before arming the observer and before an automatic remote panel commit, while catalogs load in parallel. It does not inspect private native fields or forge a mirror revision. A ready empty workspace baseline and a **30-second fallback** bound the wait; fallback does not mean native startup succeeded. Trusted local input can conservatively cancel only an unexpanded cold automatic restore, without preventing or rerouting that input. A real native refresh/restart rerun, rather than an earlier welcome dismissal or a longer test timeout, closed the regression.

```sh
./node_modules/.bin/tsc --noEmit
DSH_CONNECTIONS_TEST_SSHD=1 DSH_CONNECTIONS_TEST_SYSTEMD=1 \
  node --import tsx --test test/*.test.ts
DSH_DESKTOP_CONTRACT=1 ./node_modules/.bin/playwright test --workers=2 --reporter=line
node scripts/build.mjs
./node_modules/.bin/tsc -p tsconfig.build.json
npm_config_verify_deps_before_run=false npm_config_manage_package_manager_versions=false \
  node scripts/check-package.mjs --output-dir .release/rc5-convergence-2026-11-01-final
git diff --check
```

The exact rc.5 Account Remote SDK was added as a development-only type input; its generated namespace was otherwise missing behind `skipLibCheck`. Installation scripts were disabled. No new production dependency was added, and the shortcut runtime peer was removed. The remaining native input versions, SHA-512 integrity and boundary inventory are shipped in the [input manifest](<../dist/native-inputs.json>) and [contract inventory](<../dist/contracts.json>); adapted controls retain their MIT notice/license.

These tests used isolated homes, keys/sshd, fixture-owned connections and installed archives, not a replacement for the current GUI. This working tree was **not installed into or switched into the user's current profile**; saved user hosts, SSH configuration and real remote services were not edited. No real account authorization, model request/billing, Windows/macOS/Electron rerun, or live cross-version systemd upgrade/rollback is claimed. Earlier failed candidates are not final passing artifacts. The plugin version remains 0.1.8; a checked candidate is not a newly published npm release. Settings/Account content revisions are now 2, so old remote content must be updated before reopening it.

## Previous SSH completion verification — 2026-10-31

This pass used Agent Team Host/Client implementations plus two independent read-only subagent audits and a final independent cross-check. It preserved the pre-existing dirty tree, loaded the current plugin/agent-experience guidance and inspected exact Host contracts before adding a shared operations service and optional tools. At that earlier verification point the running GUI was rc.3 with an embedded artifact; it has since been upgraded to rc.5. This checkout still requires exact local rc.5. Neither pass switches the user's profile/preset or uses a compatibility exemption.

The main newly closed paths are authentication-cache generation changes; actual reconnect wiring after managed Host restart; catalog/transport identity from rendered row to Host write lease; native plugin `enabled` versus `fiberPhase=active`; byte-bounded management output; Settings hidden/late-reply lifecycle; hero picker fail-open; and approved tool operations bound to a private destination revision. Tests include an actual Manager → shared Operations → Tool metadata edit, rather than only independent mock-shaped tests. That composition test was added after final review caught a hex64/base64url43 mismatch between two otherwise passing focused implementations. A later independent Controller + ViewModel reproduction also caught old edit/forget/archive state surviving a new transport with identical native IDs and acquiring the new callback's authority. The final fix retires those interactions, rejects old menu callbacks and late active-work confirmations, and has four real Chromium authority-replacement cases in addition to headless regressions.

Commands for this frozen source:

```sh
./node_modules/.bin/tsc --noEmit
DSH_CONNECTIONS_TEST_SSHD=1 DSH_CONNECTIONS_TEST_SYSTEMD=1 \
  node --import tsx --test test/*.test.ts
DSH_DESKTOP_CONTRACT=1 ./node_modules/.bin/playwright test --workers=2
node scripts/build.mjs
./node_modules/.bin/tsc -p tsconfig.build.json
npm_config_verify_deps_before_run=false npm_config_manage_package_manager_versions=false \
  node scripts/check-package.mjs
git diff --check
```

Final frozen-source results on Linux, Node v26.5.0:

| Gate | Result |
| --- | --- |
| TypeScript, script syntax and diff whitespace | Passed. |
| Complete Node suite with both real SSH/systemd opt-ins | **514 cases: 513 passed, one Windows-only case skipped, zero failures** (104.7 seconds). Both real ControlMaster/stdio fixtures and native systemd unit syntax ran. |
| Complete Chromium fixture suite with Desktop contracts | **83 passed** (2.9 minutes), including all four authority-replacement interactions; no Electron claim. |
| Production local/embedded build and declaration emit | Passed. |
| Main and nested remote archive validation | Passed: **53 packaged files**, exports/ModuleLoader/contracts/native-input integrity/docs links checked; optional Tools SDK remains absent from runtime imports and embedded management code. |
| Final tool/RPC/diagnostic focused composition | **27 passed**, including the actual Manager → Operations → Tool path. |

Earlier failed intermediate assertions/type checks are not counted as passing gates. The new exact rc.5 Tools SDK development entry and lockfile importer reference reuse the existing dependency graph; install scripts were disabled and no package tarballs were downloaded. Native approval seam tests exercise the exact rc.5 Tools registry with controlled answerers; they do not assert an approval was delivered in the user's current GUI. The current profile, saved hosts, SSH configuration, real managed services and remote model/account data were not changed. Real SSH checks use test-owned keys/sshd; systemd checks validate a generated unit, not a live service update. Chromium guest contracts are not Electron, and no new Windows/macOS/Electron, live cross-version systemd rollback or native two-Host acceptance is claimed.

## Previous source verification — 2026-10-30

Final verification used Node v26.5.0 on Linux:

| Gate | Result |
| --- | --- |
| TypeScript and diff whitespace | Passed. |
| Complete Node suite with real SSH/systemd opt-ins | 455 cases: 454 passed, one Windows-only case skipped, no failures on the final rerun. |
| Complete Chromium fixture suite with Desktop contracts | 79 passed. Desktop cases simulate guest capabilities; they do not run Electron. |
| Workspace/Desktop fixtures repeated after final navigation ownership integration | 10 passed. |
| Production build and nested release archive check | Passed; 51 packaged files, exports/ModuleLoader/contracts/input integrity/docs links checked. |

```sh
./node_modules/.bin/tsc --noEmit
DSH_CONNECTIONS_TEST_SSHD=1 DSH_CONNECTIONS_TEST_SYSTEMD=1 \
  node --import tsx --test test/*.test.ts
DSH_DESKTOP_CONTRACT=1 ./node_modules/.bin/playwright test --workers=2
node scripts/build.mjs
./node_modules/.bin/tsc -p tsconfig.build.json
npm_config_verify_deps_before_run=false npm_config_manage_package_manager_versions=false \
  node scripts/check-package.mjs
git diff --check
```

The explicit pnpm environment settings avoid this installed wrapper attempting an unrelated dependency/store repair before pack; no dependency or lockfile was changed. The default browser suite now also honors the diagnostics spec's fulfilled-only origin, instead of accidentally navigating to the shared localhost fixture. Native systemd syntax verification uses a fresh private runtime directory and no inherited session bus, so it cannot collide with the logged-in user's private manager socket. The same strict empty-stderr assertion remains.

Real SSH checks use temporary keys/config/sshd; systemd verification parses a generated unit without starting the user's service. Hidden ten-minute bridge/watchdog checks use mock clocks. The original Windows spawn UNKNOWN cause, packaged Electron/macOS/Windows UI, actual systemd upgrade/rollback, real model/account use and third-party profile combinations were not revalidated. No user profile, existing GUI or saved remote Host was upgraded/restarted. The package version is unchanged; this verification is not a publication.

## Usual development commands

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

The host build externalizes Harness peer dependencies. The browser bundle uses native ModuleLoader services; React and Electron are not bundled replacements. The [local profile patch](<../cordis.patch.yml>) only registers Connections and does not disable the native sidebar. The package checker inspects main/remote manifests, ModuleLoader identity, profile patches, contracts, input digests, allowed files and documentation links. Local/remote entries are built separately; remote excludes SSH management. The deterministic build currently uses GNU tar. Local admission remains exact rc.5; remote explicitly admits rc.2/rc.3/rc.5. This is reviewed admission, not automatic future-version compatibility.

The local build no longer derives a sidebar factory or stylesheet. Native sidebar CSS/provider identity survives Connections enable/reload/disable unchanged. Workspace menus, modals, tooltips, state dots, icons and relative time are now plugin-owned source; runtime Harness Client imports are rejected in both artifacts. Comparison fixtures bundle published native primitives only as development inputs and exercise coexistence with owned controls. The [contract inventory](<../dist/contracts.json>) records consumed adapter revisions and an integrity link to the retained Settings constructor input, Account slot contract and shortcut checks.

The native shortcut provider is retained. Connections checks the exact rc.5 registry implementation at build time and adapts only command resolvers in the live service's private `registry.commands` map. Runtime checks verify registry identity, writable resolver fields and wrapper ownership; disposal restores only wrappers still owned by Connections. Native code owns keyboard/menu dispatch, keybindings, conflicts, revisions, repeat behavior, configuration and service disposal. A failed compatibility check withdraws remote surfaces before restoring local command resolution. No native shortcut factory or replacement Host schema is bundled.

Connections never replaces the local navigation service or its Cordis tracker. Native-navigation observation uses the public layout signal; plugin-owned panel changes use an explicit navigation transaction. Tests execute real independent native sidebar/slot registrations, provider failure/unload, private-method receivers and tracker identity, rather than maintaining a dead Proxy adapter.

The remote bundle's profile patch disables `directory-picker` auto selection and registers the existing `dsh-host-directory-picker-browse` and `dsh-client-ui-directory-picker-browse` pair. Both packages are supplied by Harness's Web bundle; the ordinary client row makes its surface available to ModuleLoader. This avoids waiting for a system dialog on a remote graphical desktop without adding a picker implementation or runtime dependency. Package checks require both browse faces and leave local picker composition unchanged.

The remote patch replaces only `ui-settings` with a version-checked constructor adapter inside Connections; `ui-settings-account` remains independently deployed. Bootstrap waits for the local presentation snapshot before installing ConfigForms and injects an owned shallow-snapshot dependency, so original locale/theme consumers start with accepted local UI preferences. Execution forms keep native schema/mirror/write queues. Account uses checked public slot delegation and an owned sign-in presenter, not copied native code/CSS. Both archives include `native-ui.LICENSE`; only the remote archive also needs `native-settings.LICENSE`. Focused tests exercise the reviewed releases' real Settings/locale/theme and native Account registration contracts; they do not establish live account authentication or Electron acceptance.

CI also installs the checked release tarball into two disposable native Hosts
on the declared local Harness version and runs the native browser suite. No
compatibility exemptions are granted. See [Harness compatibility](harness-compatibility.md)
for the rc.5 review and integration boundaries.

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

Default browser fixtures cover settings, managed-mode creation and explicit update submission, local/remote project choice, iframe isolation, delayed-reply cancellation, owned menus coexisting with native dialogs, keyboard focus, and overflow in light/dark layouts. Cancellation and delayed SSH discovery use a controlled clock so assertions run after the old reply settles. Layout assertions are functional checks, not screenshot-baseline comparisons. The workspace ViewModel tests cover source-qualified commands, duplicate submissions, stale asynchronous results, lifecycle cleanup and collapse/selection transitions without a DOM. The existing catalog browser fixtures run under React StrictMode to verify the View binding. Connections owns its icons, time bucketing and menu keyboard implementation; focused tests check their behavior and coexistence with actual native primitives. The production Client bundles import no Harness Client runtime modules. Visual alignment is checked against the real Desktop sidebar; CSS-value assertions and pixel snapshots are not an acceptance substitute. Native integration additionally verifies the installed ModuleLoader bundle, real credential RPC, real SSH forwarding, native directory selection, file tree/preview and local Host restart; its screenshots are acceptance artifacts.

Shell-routing tests execute the installed independent native sidebar factory with real Cordis and SlotCore. They verify shell survival through client failure/entry disable, local native New Session, unchanged receivers/tracker, remote command guards and owned-effect cleanup. Presentation regressions cover picker/session readiness, stale acknowledgements, visible-time timeout, hidden pause/resume and cancellation; HTTP success or iframe load alone is not readiness evidence.

Stylesheet lifecycle tests execute the actual Harness ModuleLoader and Cordis Loader through Connections contribution enable/reload/disable while asserting native stylesheet identity is unchanged. The native browser fixture now expects no copied Connections sidebar CSS and checks the independently retained shell. Older copied-CSS/Desktop collision evidence below is historical, not the current implementation.

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

The complete local check passed 336 Node cases with both native OpenSSH and systemd checks enabled, without skips. The release gate then exposed an initial-readiness notification that cleared the saved remote selection during page startup. Routing now closes remote views only when an established capability is lost; initial and repeated unavailable notifications preserve restoration. The focused lifecycle regression and all five installed two-Host cases passed against the corrected archive, including hot enable/disable, unsent drafts, page reload, local Host restart and native Settings ownership. The final archive's first-enable, Add and disable/re-enable flow was also rechecked in a fresh Windows Desktop profile.

Tests and reports must not print launch URLs, proxy settings or private logs. Test-only services and fixtures are removed after verification; remote user configuration and the default Harness home are not modified.

## 2026-10-30 review corrections

The original Windows crash log confirms an uncaught synchronous `spawn UNKNOWN`
from the stdio listener, rather than a renderer-only failure. The new regression
injects that exact error into the real TCP callback and verifies a contained
connection error. A later channel failure leaves an established unrelated stream
and subsequent connections usable. POSIX coverage also kills an owned parent
process and verifies cleanup of its master, ProxyCommand descendants, port and
private directory.

The final Node run passed **360 tests**, with one Windows-only case skipped on
Linux. Both `DSH_CONNECTIONS_TEST_SSHD=1` and
`DSH_CONNECTIONS_TEST_SYSTEMD=1` were enabled, including real temporary OpenSSH
and native systemd unit validation. TypeScript, production build and the
47-file package/remote-archive check passed. The runtime Config's internal
embedded-mode guard is validated but hidden from editable settings.

Independent Windows execution passed three tests under Windows Node 26.5.0 and
the system OpenSSH executable; one POSIX-only case was skipped. These runs use
temporary standalone bundles, not the user's Desktop process or profile. They
cover synchronous UNKNOWN, native refused-connection/missing-executable behavior
and cleanup of an already exited process. They do not establish full Electron
UI acceptance or identify the underlying Win32 reason for UNKNOWN on the
reported Desktop's Node 24.21.0. The new Windows/macOS CI jobs have not been
executed as part of this local run.

All **50 Chromium fixture tests** passed, including explicit stop/archive
confirmation, cancellation without a mutation, activity starting after the
catalog snapshot, and focus restoration after search, rename and the archive
dialog. Shared-poll regressions additionally verify that a stalled workspace
read cannot delay Settings and that an old cleanup cannot delete a replacement
polling group.

All **five installed native two-Host cases** passed against the checked code in
an immutable copy of the local tarball and its remote content archive. They
cover embedded boot, independent stylesheet ownership, hot enable/disable with
an unsent draft, local/SSH workspace switching, reload/restart restoration and
Settings ownership. Installed Host/client hashes matched the built artifacts.
The review's temporary Hosts and SSH listeners were stopped afterward; the
user's running Desktop and managed remote Hosts were not restarted or upgraded.


## 2026-10-30 rc.5 compatibility acceptance

Connections 0.1.8 was built against exact rc.5 native inputs. All 363 Node tests
passed under Node 26.5.0, with one Windows-only test skipped on Linux. Real
OpenSSH and systemd syntax opt-ins were enabled. TypeScript, production build
and the 48-file package/remote-archive check passed; all 50 Chromium fixture
tests and all five installed native two-Host rc.5 cases passed.

The standalone remote matrix additionally passed on rc.2, rc.3 and rc.5:
compatibility evaluation, CLI installation, damaged-file repair, activation,
catalog/view protocol, native directory picker/session selection, Models and
Built-in plugins Settings, and live parent-owned Locale/Theme with no writes
to remote UI preferences. CI now exercises every admitted remote runtime from
the exact checked release archive, alongside the local two-Host suite.

These runs use isolated Linux Web profiles and Chromium. They do not establish
packaged Windows Desktop rc.5 acceptance, live account sign-in, model/provider
execution, third-party plugin parity or a real systemd cross-version update.
The installed Windows Desktop is rc.5, but was not launched or modified for
this validation. All test-owned Hosts and SSH listeners were stopped; no user
profile or existing Host was upgraded or restarted.

The resource-bound regressions are recorded in [performance](performance.md).
No CPU, memory or responsiveness speedup was measured by this acceptance.
