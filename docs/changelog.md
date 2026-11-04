# Release notes

Selected changes from 0.1.6 onward. Runtime requirements and migration instructions are maintained in [Harness compatibility](harness-compatibility.md).

## 0.1.10

- Remove the remote embedded `shell.leading` seat that duplicated the outer
  Desktop sidebar and New Session controls. Remote workspaces and Settings keep
  their native content and dialogs; window navigation stays with the outer shell.
- Remove the unused embedded sidebar callback and workspace translation argument.
  Require the native startup source and panel transaction in the navigation guard
  instead of retaining its obsolete ungated path.
- Replace the historical failure-only test with the existing startup regressions;
  consolidate duplicate chrome assertions, extend native theme-token validation
  to embedded views, and remove stale test mocks and source-import checks.

## 0.1.9

- Preserve the native sidebar and independently deployed Account provider. Remove
  Harness Client runtime imports and the copied sidebar/Account factories;
  retain checked Settings-constructor and shortcut-resolver adapters.
- Use owned, theme-aware controls with keyboard/focus handling, native modal/menu
  coexistence and corrected rc.5 hover/status tokens. Add keyboard workspace
  navigation and safe redacted connection diagnostics.
- Bind remote actions, authentication and presentation to transport generations;
  recover managed-Host reconnects and native startup navigation, bound SSH
  lifecycle output and cleanup, and share validated operations with the optional
  owner-authorized `connections` tool.
- Bound catalog revision work and suspend hidden catalog reads. Record resource
  baselines and Windows Desktop/WSL acceptance without claiming a measured
  before/after speedup or closing the observed remote-reopen timeout.

Local Harness remains exactly `0.2.1-rc.5`; admitted remote versions remain rc.2,
rc.3 and rc.5. Settings/Account content contracts advance to revision 2: older
remote content must be updated and reopened. Installing this package does not
upgrade a running remote Harness service. See [compatibility](harness-compatibility.md) and
[validation evidence](development.md).

## 0.1.8

- Target exact local Harness rc.5 and admit remote rc.5 alongside rc.2/rc.3.
  Keep matching peer inputs, source-integrity records and explicit rejection of
  untested versions; 0.1.7 remains the local rc.3 release.
- Check every admitted remote Settings/Account source before sharing factories,
  and run native preference tests against all three matching runtimes.
- Document which review performance findings are resolved and which costs remain,
  without treating functional regressions as a measured speedup.

Saved connection formats are unchanged. Existing remote Hosts are not upgraded
by installing this plugin; an explicit Update selects latest compatible rc.5.
See [compatibility](harness-compatibility.md) and [performance](performance.md).

## 0.1.7

- Contain synchronous Windows OpenSSH launch failures, including `spawn UNKNOWN`, so they report a connection error instead of terminating the Host. Isolate later stdio channel failures from other HTTP/WebSocket streams.
- Reclaim POSIX tunnel process groups after abrupt local Host exit, avoid signalling observed exited PIDs, and distinguish stale navigation, protocol and authentication failures.
- Reject foreign systemd drop-ins before installation; improve linger diagnostics, bounded SSH checks, credential migration and temporary-file cleanup.
- Confirm before stopping and archiving running work. Preserve valid theme tokens, native focus and third-party workspace providers; share polling without allowing slow tasks or old cleanup callbacks to block other owners.
- Declare runtime configuration and plugin metadata, record native adapter inputs and licenses, and add Windows/macOS SSH CI alongside the existing Node, browser and installed two-Host checks.

Local compatibility remains exactly Harness `0.2.1-rc.3`; remote content supports
the verified rc.2/rc.3 releases. Saved records retain their storage format. This
release fixes the uncaught Windows exception path; the underlying Win32 refusal
reason and full Desktop UI acceptance remain separate from the verified
Windows Node/OpenSSH regressions. See [validation boundaries](development.md#acceptance-boundaries).

## 0.1.6

- Preserve the running native shortcut provider and its configuration when enabling Connections. Route source-aware commands through a checked, reversible rc.3 registry adapter instead of replacing the service that the native layout depends on.
- Recognize the native Desktop guest bridge in Connections settings so Add and connection controls are available. Keep ordinary browser origin restrictions intact.
- Close or refuse remote views when the native routing contract is unavailable, preserving native local controls.

Migration from an active 0.1.5 installation may still need one renderer reload while its old replacement provider retires. Do not automate that reload or discard unsent drafts. See [Desktop migration and shortcut configuration](harness-compatibility.md#updating-an-open-rc3-desktop).

The 0.1.5 improvements remain available:

- Multi-select SSH discovery, immediate connection after adding, persistent enable switches, failure retry and native workspace actions.
- Original Connections logo in Settings; nested dialogs share native keyboard ownership and restore focus correctly.
- Updates default to the latest verified compatible remote Harness, `0.2.1-rc.3` in this release, without an implicit downgrade.
- Read-only SSH diagnostics, bounded HTTP connection reuse, continuously replenished startup workers and visibility-aware settings polling.

Local Harness compatibility remains exactly `0.2.1-rc.3`; remote content supports the verified rc.2 and rc.3 releases. Saved connections and credentials retain their existing storage format.
