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
- `src/client`: native settings, host chooser, original directory-flow delegation and remote native view.
- `src/shared`: browser-safe contracts and validation.
- `test`: transport, cancellation, ownership, update recovery and browser integration.

The host build externalizes Harness peer dependencies. The browser bundle uses native ModuleLoader services; React and Electron are not bundled replacements. `cordis.patch.yml` registers the host plugin. The package checker builds and inspects a real tarball, exports, ModuleLoader identity, allowed files and documentation links.

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

Use disposable Harness homes and private startup logs. The helper creates a local controller with this checkout installed, plus a real isolated sshd; the target native Web Host is prepared separately:

```sh
DSH_QA_CLI=/absolute/path/to/dsh/lib/bin.js \
  node test/integration/native-fixture.mjs start /tmp/dsh-native-fixture
```

The command prints only public process/address metadata and a log path, not launch credentials. It places SSH overrides on the fixture Host's own PATH. Its fixed port and ownership-checked restart allow browser-state restoration tests:

```sh
DSH_WEB_LOG=/tmp/dsh-native-fixture/host.log \
DSH_REMOTE_NAME='Native SSH fixture' \
DSH_REMOTE_LOG=/private/path/to/remote-host.log \
DSH_REMOTE_TARGET=native-workspace-fixture \
DSH_REMOTE_PROJECT=/absolute/remote/project \
DSH_QA_RESTART_FIXTURE=/tmp/dsh-native-fixture \
  pnpm exec playwright test --config playwright.native.config.ts

node test/integration/native-fixture.mjs stop /tmp/dsh-native-fixture
```

The isolated sshd forwards to its own machine's loopback, so this example requires the target fixture Host on that machine. For another authorized server, supply a private SSH config entry to the fixture instead. The remote fixture project needs `README.md` and `nested/source.txt` containing `native sidebar nested file`. Native settings testing creates and deletes a marked fake connection; project testing opens the supplied project without model requests.

`DSH_REMOTE_REOPEN=1` selects an already-created remote project. Optional `DSH_QA_REMOTE_PID` verifies the same local fixture process start time across controller restart. The restart segment uses one browser context and asserts unchanged tunnel origin, selected native session and file preview. Native tests skip unless their explicit environment is supplied; a default fixture run alone is not native integration evidence.

## Acceptance boundaries

Browser fixtures cover settings, managed-mode creation and explicit update submission, local/remote project choice, iframe isolation, guest lease cleanup and failures, delayed-reply cancellation, OAuth popup delegation and responsive light/dark layout. Native integration additionally verifies the installed ModuleLoader bundle, real credential RPC, real SSH forwarding, native directory selection, file tree/preview and local Host restart.

Actual Electron desktop rendering, macOS, Windows and machine reboot are not covered by these fixtures. Desktop's public bridge contract is tested with a fixture; upstream partitions are transient. No model task, account credential migration or computer-input automation is exercised.

## Verified on 2026-10-24

- TypeScript, production build and 56 Node tests passed with both real OpenSSH and native systemd syntax checks enabled, with no skips.
- Fourteen browser fixture cases passed. Light/dark, mobile forms and the host chooser were also inspected as rendered images.
- Two native integration cases passed against installed Harness `0.2.1-rc.2`: credential settings and actual SSH project/file-tree access. Restarting only the local Host preserved the tunnel origin, selected native session and open file preview; the target process remained alive.
- On an authorized remote Linux server, the real managed service survived local controller exit. An explicit `0.2.1-rc.2` to `0.2.1-rc.3` update finished after its controlling SSH process was cancelled, and a new controller authenticated to the new process. A controlled return to `rc.2` also succeeded.
- That server's full browser UI was **not** accepted: its direct loopback HTML returned 200 with 37,448 bytes in 5 ms, while the SSH path stalled. Independent plain SSH large-output checks also stalled with default, IPQoS and compression settings. The native UI acceptance above uses the isolated real OpenSSH fixture; do not conflate authentication on this server with full UI verification.
- A real npm tarball passed export, ModuleLoader, file-boundary and documentation-link checks. No package was published and no Git remote was pushed.

Tests and reports must not print launch URLs, proxy settings or private logs. Test-only services and fixtures are removed after verification; remote user configuration and the default Harness home are not modified.
