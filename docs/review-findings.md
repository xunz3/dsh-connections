# Review findings and maintenance decisions

This document records the verified findings and maintenance decisions from the
supplied reviews. The **2026-10-28** review identified further issues beyond the
earlier fixes; its findings and the earlier review are recorded separately below.

## Current source follow-up after the 0.1.8 baseline

The [implementation follow-up](<review-followup.md>) is authoritative for the current working tree. It records native-shell fail-open (without copying or disabling the sidebar), the deliberate local-brand/source-aware-keyboard tradeoff, fixed SSH classification, guarded diagnostics, surface visibility/backoff, required-contract negotiation and remaining upstream/product work. Historical records below describe what their referenced releases did; in particular their Proxy/sidebar replacement and unpaused-bridge descriptions no longer describe this source.

## Historical 0.1.8 baseline: performance and rc.5

The 0.1.7 changes resolve C6's duplicated scheduling and concurrent list reads.
They do not remove the separate native remote document, persistent surface
bridges or full-catalog scan/hash. Actual refresh eligibility and outstanding
costs are recorded in [performance](performance.md); no measured speedup is claimed.

Connections 0.1.8 moves the exact local target to rc.5 and adds explicitly tested
remote rc.5 alongside rc.2/rc.3. The original private-contract/version-lock
finding remains: this is reviewed admission, not a public multi-Host API or
capability-negotiated version range. See [compatibility](harness-compatibility.md).

## 2026-10-30 review and Windows Host crash

The supplied review was checked against the implementation and the installed
Harness rc.3 contracts. The plugin's scope remains SSH access to a persistent
remote Harness, with source-qualified workspace navigation. Device pairing,
mobile entry points, delegated controller identities, API Peer event forwarding
and a multi-device control plane require separate design and authorization
work. They are not existing features repaired by this change.

The original Windows Desktop crash report identifies rc.3, Electron 44.7.0 and
Node 24.21.0. It records a fatal uncaught `spawn UNKNOWN` (`errno: -4094`) in
Connections' loopback server callback. That callback called `spawn()` without a
synchronous exception boundary. This confirms the process-crash path, separate
from the historical shortcut-provider renderer failure. The report does not
establish why Windows refused the process launch.

| Review item | Verification and resulting behavior |
| --- | --- |
| HR-01 | A POSIX master now runs under a small local supervisor holding a private process group and a parent-liveness pipe. Parent exit, including SIGKILL, triggers cleanup of that master, its descendants and its private directory. Killing the supervisor itself or OS failure remains outside this guarantee. |
| HR-02 | Drop-in-only units are refused before claiming the managed home, writing a unit, installing packages or reloading systemd. Existing installations are also checked before modification. |
| HR-03 | Authentication distinguishes cancellation, protocol incompatibility, authorization rejection and transport failure. A stale Open result cannot invalidate a replacement connection; an incompatible response preserves its transport and reports the protocol remedy. |
| HR-04 | Cleanup does not signal a numeric PID/PGID after Node has observed the leader exit. The persistent master supervisor keeps its owned group leader alive through termination. Unsupervised, already-orphaned descendants cannot safely be reclaimed by guessing an old PGID. |
| HR-05 | The reported rollback-before-journal behavior was not present: preflight/staging are outside the rollback branch. Tests now explicitly verify that staging failure creates no transaction/backup and does not stop the old Host. |
| HR-06/07 | A failed or malformed loginctl query has its own remedy; only a confirmed `Linger=no` suggests enabling it. SSH checks queue beyond four active requests, with a bounded total and an explicit busy error. Unload cancels queued checks. |
| HR-08/09 | Reading a valid current credential removes its obsolete legacy copy, including a damaged copy at the same ID. Explicit removal clears both copies. Unrecognized legacy records without an authoritative current record are preserved. Atomic file/symlink replacement cleans temporary paths on failure. |
| HR-10 / Windows crash | Synchronous SSH launch errors are caught inside the TCP callback. Asynchronous launch errors are handled as before. A failed stream after establishment closes that stream without closing the listener or unrelated HTTP/WebSocket streams; first-authentication failure still reports a connection error. Windows/macOS focused CI jobs were added. |
| C3 | The build checks the actual native Models, permission and session-log slot registrations, in addition to versions and factory seams. A renamed/missing row fails the build. Existing rc.2 provider sources were also checked with these assertions. |
| C4 | Invalid optional theme tokens are filtered within a bounded input; valid tokens and the rest of the presentation survive. A rejected first bootstrap request can be retried. Structural protocol validation remains strict. |
| C5 | Native archive already refused running work with `SESSION_ACTIVE`; the previous UI lacked its confirmation flow. The UI now confirms before sending explicit `stopActivity: true`, including when activity began after the catalog snapshot. Cancel sends no stopping mutation. |
| C6 | Workspace/settings controllers share visible-page polling timers and concurrent connection-list reads. Each owner independently releases its subscriptions; hidden pages pause polling. |
| C8-C11/C15 | Web and Desktop use the authenticated view endpoint; action failures use translated summary copy; search, rename and archive dialogs restore keyboard focus; completed-navigation retention is bounded; the isolated uiWorkspace proxy forwards symbols, writes and native method receivers. |
| Plugin metadata/config | Both artifacts export a runtime Schemastery Config and packaged English/Chinese metadata and icon. Local `embedded: true` is rejected: the separate remote artifact owns embedded mode. Direct native ModuleLoader dependencies are declared explicitly. |
| RPC lifetime | No extra wrapper was added: Cordis Service construction and Typert registration already own and withdraw their effects. Real registration/unload tests verify removal of both service and descriptors. |

### Integration boundaries retained

The exact local rc.3 engine gate remains necessary for the native factory and
shortcut adapters. Replacing it with a broad semver range would promise untested
private contracts. Both artifacts now carry `NOTICE`, original licenses and
`dist/native-inputs.json` with package versions, client SHA-512 inputs and adapter
digests. These make the derivation reviewable; they do not turn those contracts
into public APIs.

The local bundle still replaces the sidebar deployment, and the dedicated
remote profile still replaces layout/settings providers. Disabling only an
individual entry cannot undo a bundle-level patch. RPC/data failures retain the
native local shell, but failure of the entire client factory cannot guarantee
automatic sidebar restoration. Disable the whole bundle to remove its patch.
The source-aware workspace browser still lacks some native features such as
fork, drag ordering and server-wide search; the preserved native shell is not a
claim of complete workspace-browser parity.

The embedded layout's sidebar toggle still has no parent-shell bridge, and its
declared leading slot is not rendered. Third-party row contributions tied to
the single-Host native workspace browser are not automatically projected into
the source-aware list. These remain integration limitations.

Competing negative-priority workspace providers are detected: Connections gives
up its occupant and returns to local content instead of hiding another plugin.
Rich remote content remains a separate native document, so focus, browser
shortcut and notification boundaries still apply. The active resolved palette
is projected through the native light/dark-pair API; the plugin does not invent
an unobserved palette for the other theme.

Current validation and platform limits are recorded in [development](development.md).

The runtime schema and display resources follow the rc.3
[plugin configuration contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/user/develop/basic/config.md)
and [plugin metadata contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/cookbook/adding-a-package.md#plugin-display-metadata).

## 2026-10-28 review

| Item | Finding and correction |
| --- | --- |
| **P1-4 — exact engine versus remote update** | **Confirmed.** The remote archive previously inherited the local sidebar's exact engine. Local compatibility is exactly rc.3 in Connections 0.1.1 (rc.2 in 0.1.0); the separate remote host/client entry now contains the workspace/settings protocol and embedded layout, without the local sidebar or SSH manager. A single checked compatibility list admits only rc.2 and rc.3. Native compatibility evaluation, CLI installation, activation, catalogs and embedded browser navigation were exercised on both versions. This is not a new real systemd cross-version transaction test. |
| **P1-5 — control characters in paths** | **Confirmed.** Filesystem paths have their own codec. Newlines, tabs, DEL, empty cwd and deep paths are preserved, rather than incorrectly treated as display titles or silently renamed. NUL remains invalid. Page size still bounds response payloads; oversize entries report TOO_LARGE. |
| **P2-9 — background reads destroy healthy SSH** | **Confirmed.** Catalog/view reads preserve the tunnel after transient network/read errors. Explicit Open authentication and actual SSH closure retain their lifecycle checks. Authentication rejection gets one refreshed cookie and safe retry; transport failure never replays a mutation. |
| **P2-10 — migration resurrects a removed record** | **Confirmed.** Read/migrate/save/remove/rememberPort serialize per credentials provider and connection ID, including separate store facades over one provider. Migration cannot resume after a completed removal to recreate the record. Different IDs remain independent. |
| **P2-11 — catalog and connection errors share phase** | **Confirmed.** Catalog errors are independent from connection phase; a live tunnel stays Connected. Source retry refreshes a catalog, and only disconnected transports need Reconnect. A newly connected transport clears stale catalog polling state. |
| **P2-12 — refresh leaks view channels** | **Confirmed.** v2 openView includes a tab/surface/connection lease identity. Reopening replaces that owner's old channel atomically; old close/poll calls cannot affect its replacement. Page lifecycle marks IDs for reload transfer, while copied active tab storage forks its identity. Server expiry/capacity still bound abandoned leases; no unload network request is required for normal reload recovery. |
| **P2-13 — active cursor expiry** | **Confirmed.** Each valid continuation renews snapshot expiry and recency. Historical snapshots have bounded LRU retention (eight revisions and 64 MiB, keeping the current revision); pressure may still evict history and the client restarts once. Slow multi-page reads and concurrent revisions are covered. |
| **P2-14 — New chat opens existing workspace** | **Confirmed.** The row menu emits a source-qualified newSession intent. The browser regression verifies that it does not emit workspace navigation. |
| **P2-15 — unversioned presentation requirement** | **Confirmed.** Protocol v2 requires presentation acknowledgement and the new lease/settings contract. A missing presentedRevision or old protocol fails immediately as INCOMPATIBLE_PROTOCOL; it does not wait 30 seconds. |
| **P2-16 — openView uses stale authentication** | **Confirmed.** The Host authenticates before allocating openView and retains the refreshed cookie; concurrent refreshes share a single exchange. A rejected cached cookie is refreshed and retried once. This ordering is enforced on the Host, independent of client call order. |
| **P2-17 — XDG unit path** | **Confirmed.** New installations honor an absolute XDG_CONFIG_HOME. An existing installation keeps its recorded owned location when the SSH environment changes. |
| **P2-18 — Node/npm/PATH portability** | **Confirmed.** Installation executes npm with the recorded runtime Node, puts that runtime first on PATH, and diagnoses missing runtime or ABI drift without silently switching an existing native dependency tree. A filtered absolute PATH from the remote SSH environment is saved for tools; local environment/model keys are never imported. Automatic Node migration is deliberately not claimed. |
| **P2-19 — reconnect for configuration errors** | **Confirmed.** Missing bundle, incompatible protocol, unsupported surface and sidebar conflict show their specific remedy without a Reconnect action. Retry for a still-connected view reopens its presentation instead of rebuilding its transport. |
| **P3-1 / P3-2 — startup readiness** | **Confirmed robustness gaps.** Native sidebar readiness follows delayed registration. The stable Connections settings entry reports unavailable after 10 seconds without its service and can recover when the service appears; a late Remote service cannot reset this to permanent Loading. |
| **P3-3 — forced refresh loss** | **Not reproduced.** The existing rerun loop is retained and regression-tested; no redundant refresh state machine was added. |
| **P3-4 / P3-5 — stale view reuse / transient checks** | **Confirmed.** Public connection status includes an opaque transport identity, so same-port credential/tunnel replacement cannot reuse the old iframe. A transient local/view RPC error has a bounded three-check grace budget; successful checks reset it. Definite disconnection, missing view and protocol errors remain immediate. |
| **P3-6 — large sidebar rendering** | **Confirmed.** The list progressively renders bounded rows, retains the selected row and its parent, and searches the complete catalog. Collapsed workspaces do not mount hidden session rows. Polling remains bounded snapshot polling, not a newly invented event system. |
| **P3-7 — chooser overflow / missing fallback** | **Confirmed.** Long host lists scroll within the viewport and offer search. Both local picker entry points have an explicit unavailable/cancel fallback. |
| **P3-8 — reused blank session** | **Confirmed.** New Session awaits native completion through the layout adapter, allowing the native controller to reuse a blank session key without waiting for a nonexistent new ID. Local navigation and startup also sample the native current session, keeping a reused draft selected even when no key-change event fires. |
| **P3-9 / P3-10 — protocol constants / IPv4** | Protocol callers use the shared version constant. Existing-service documentation explicitly requires the service to listen on IPv4 loopback; accepting the spelling localhost never proved that it did. |
| **P3-11 — activation receipt / readiness** | Receipts verify installed entry contents instead of trusting digest alone. A damaged installation is reinstalled through the native CLI using identical verified archive bytes at a new immutable path; real pnpm tests showed that repeating the old path, even with force, did not repair missing files. Readiness verifies the selected release, manifest and actual running process identity before returning its version. Restart-on-failure is allowed to recover within the readiness deadline. |
| **P3-12 — CSS scope** | **Confirmed.** Connection-settings selectors are scoped under .dsh-connections, including grouped/media selectors. |

The updated settings ownership design is documented in
[Settings, models and plugins](host-settings.md). Remote models, credentials and
plugins are independent, and the native Settings header selects the Host. No
implicit secret/package synchronization or local model proxy is added. The
embedded settings adapter also handles native slot removal/replacement: it shows
an unavailable state while missing and reopens the replacement without losing
the view or misreporting a user close.

### Validation

- The final cleanup run passed 223 Node tests with real SSH and native systemd checks enabled, with no skips; 26 web browser fixtures and 5 explicitly enabled desktop guest contracts also passed. The guest contracts simulate the bridge in Chromium and do not enable or validate Electron desktop opening.
- All three separately run native two-Host cases passed during the preceding UI acceptance. Native settings checks verified Models/plugin inventory, remote-only preference writes and restoration, unchanged workspace/session identities, slow-load cancellation and menu behavior in light and dark/narrow layouts.
- Both rc.2 and rc.3 passed native remote-bundle installation, activation, damaged-file repair, catalog/workspace navigation and Settings browser checks. No provider/model request or new real systemd cross-version update transaction was exercised.
- TypeScript, production build, both package boundaries and documentation links passed. The main tarball contains 32 files. Final native screenshots were inspected.

## Earlier 2026-10-26 review record

The following records the previous pass and its evidence at that time. Where it
conflicts with the newer findings above, the newer correction is authoritative.

| Review item | Finding and resulting behavior |
| --- | --- |
| **P1-1 — recovery after remote restart** | **Confirmed and addressed.** Reconnect now reaches an explicit owner RPC that releases the old tunnel and repeats preparation, authentication, and forwarding. A managed Host can therefore return its new port and launch token. Opening a connected Host checks its HTTP authentication. Network or authorization failure marks the connection as failed; native application errors and plugin version errors do not destroy a healthy tunnel. Recovery never stops the remote Host or its work. |
| **P1-2 — unverified first activation** | **Confirmed and addressed.** First startup and later preparation inspect the native plugin manager. Installation receipts become `applied` only after the plugin is observed enabled. Disabled entries, changed contents, and old unverified receipts are reconciled through the native plugin manager. An unchanged installation does not repeatedly toggle enabled plugins or restart the Host. |
| **P1-3 — native sidebar version coupling** | **Confirmed; compatibility is explicit.** The supported Harness engine is pinned to the exact version whose sidebar is bundled and tested. Native shell mounting is independent of connection RPC availability, and an existing sidebar owner is preserved instead of causing a composition exception. Remote navigation remains unavailable when another composition owns actions that cannot safely follow the selected source. The native sidebar has no public multi-Host data-provider contract; this adapter still requires validation when upgrading Harness. |
| **P2-1 — metadata edits disconnect** | **Confirmed and addressed.** Renaming a connection or changing automatic connection preference preserves an active tunnel and an in-flight preparation. Target, mode, or credential changes invalidate the connection. A failed credential write leaves the current connection intact. |
| **P2-2 — installation prerequisites on reconnect** | **Partly confirmed and addressed.** npm, archive tooling, and linger checks apply when installation, upgrade, or recovery needs them. An existing installation can reconnect without npm and with linger disabled. `flock` and `systemd-run` remain required for serialized maintenance that survives controller disconnection; removing them would weaken the lifecycle contract. Missing installation tools have a distinct error. |
| **P2-3 — spaces in systemd paths** | **Not reproduced; the proposed blanket quoting is incorrect.** The pinned systemd parser accepts the complete values of `WorkingDirectory`, `EnvironmentFile`, and `StandardOutput=truncate:` as paths, including spaces. Adding JSON-style quotes to these path directives changes their meaning. Existing directive-specific encoding is retained and a path-with-spaces regression covers the generated unit. `ExecStart` and `Environment` retain their own required quoting. |
| **P2-4 — older OpenSSH** | **Confirmed and addressed.** `IgnoreUnknown=ForkAfterAuthentication` precedes `ForkAfterAuthentication=no` in both tunnel and management invocation. Older clients can ignore the newer option; newer clients still override a user configuration that would detach the owned process. Removing the option outright would lose the latter guarantee. |
| **P2-5 — installation supply chain** | **A real boundary; exposure reduced.** Installer processes receive a restricted environment, npm retains a lockfile, and release metadata records the primary package integrity and lockfile SHA-256. Required native-package installation scripts remain enabled: the supported Harness dependency tree uses them. This is an audit record and npm integrity verification, not independent registry signature verification. No offline release channel or public raw-log export is introduced. |
| **P2-6 — polling, startup, and catalog scale** | **Confirmed for polling and response size; startup was already bounded.** Catalog refreshes use content revisions and omit unchanged payloads. Changed catalogs arrive in pages below 256 KiB, including split workspace membership lists; the reader publishes only a complete revision. This initial implementation retained two immutable snapshots for two minutes; the 2026-10-28 correction above adds sliding expiry and bounded LRU retention. The 4 MiB transport guard remains a per-response safeguard. Hidden documents pause background refresh; selected and other sources use different refresh intervals, failures back off, and catalog requests have bounded concurrency. Automatic connection keeps the user's saved preferences and the existing four-worker limit. |
| **P2-7 — credential namespace and malformed records** | **Confirmed and addressed.** Records use `xunz-dsh-connections`, a package-specific scope accepted by the native credential provider; npm's `@scope/name` spelling is not a valid credential scope. Valid legacy records migrate by copying before deleting. Malformed keys or payloads do not hide healthy connections, while provider I/O failures remain visible. |
| **P2-8 — protocol negotiation and private diagnostics** | **Confirmed and addressed.** The initial `catalog` and `openView` protocol was version 1; the 2026-10-28 correction above moves both to version 2. Older clients cannot silently mistake the first page for a complete catalog. Missing or unsupported versions produce `INCOMPATIBLE_PROTOCOL`, preserved through the local RPC response, with an instruction to update Connections on both Hosts. This is explicit compatibility validation, without guessing future schemas. Maintenance subprocess output is retained in private `maintenance.log`; lock conflict or timeout is distinguished from failure to launch maintenance. Raw diagnostics are not sent to the browser. |
| **P3-1 — IPv6 surface mismatch** | **Confirmed and addressed.** The settings panel and workspace opener use the same local HTTP surface predicate. IPv6-only loopback is rejected consistently because the SSH forward is bound to IPv4 loopback; the UI no longer offers a connection surface that the iframe cannot use. |
| **P3-2 — token in initial iframe URL** | **Native authentication boundary, retained deliberately.** Harness exchanges its launch token at the remote root and redirects to the clean URL. The initial iframe request uses that existing contract. Issuing another kind of exchange credential or proxying the remote browser session would add a new authentication system and change origin ownership; it is not an isolated plugin fix. Launch credentials remain excluded from saved public views and diagnostics. |
| **P3-3 — accepting v2 cookies** | **The recommendation is incorrect for the supported Host.** Harness uses v1 for browser authentication. Its v2 cookie identifies a live API operator and is verified through a separate API authentication path. It is not a replacement browser-cookie version. The Connections launch exchange retains strict v1 audience, signature-shape, and attribute checks. |

## Native sidebar reuse

The native shell, its header actions, footer, and mounting behavior are reused. The cross-Host browser is the part that needs an adapter: the shipped native workspace list obtains its data and actions from one `uiWorkspace` service and one Host. Replacing that service globally with remote data would make local actions and plugins operate on the wrong owner.

The unified browser therefore keeps source-qualified identities and native-owned mutations. Its presentation reuses native icons and the native Menu component, including portal, focus, and keyboard behavior, while following the native sidebar's row layout. The conversation and files panels continue to run in their remote native document. A future public source-aware sidebar API would allow removing this adapter; a speculative second transport or session abstraction would not provide that API today.

## Historical evidence from 2026-10-26

- Protocol and HTTP regressions cover version mismatch in either direction, safe error projection, transport error classification, unchanged refresh, a catalog larger than 4 MiB, a workspace with 23,000 session memberships, bounded rename acknowledgements, immutable pagination, snapshot expiry, and cancellation. The focused endpoint/HTTP suite passes 19 tests.
- Connection regressions cover a managed Host changing port and token, explicit reconnection, metadata changes during preparation, failed persistence, bounded startup, and legacy credential migration.
- The lifecycle/SSH suite passes 34 tests with both opt-in modes enabled, including a temporary real sshd and `systemd-analyze` validation. It covers activation reconciliation, reconnect without installation prerequisites, private maintenance diagnostics, installer environment filtering and integrity metadata, path spaces, and compatibility option ordering. Older OpenSSH behavior is an option-parsing fixture, not a run of an OpenSSH 8.4 binary.
- The complete Node suite passes 177 tests with no skips; all 31 browser fixtures pass. Both isolated native two-Host browser cases pass against verified current builds, covering native composition, source routing, files and attachments, presentation acknowledgement and local Host restart. TypeScript, production build and both package checks pass.
- Real platform boundaries remain explicit: Linux managed Hosts and local HTTP loopback are the supported deployment. This work does not establish macOS, Windows, Electron, future Harness versions, or power-loss recovery support. Live remote installation and registry trust are separate from fixture coverage.

Upstream references used to check disputed suggestions:

- [systemd v255 directive parsers](https://github.com/systemd/systemd/blob/v255/src/core/load-fragment.c): path directives and command/environment directives have different parsers.
- [OpenSSH `IgnoreUnknown`](https://man.openbsd.org/ssh_config#IgnoreUnknown): an ignore rule must precede the unknown option it protects.
- [Harness rc.2 subprocess package](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subprocess/subprocess-local/package.json): upstream installation has native dependency behavior that rules out an unverified blanket `--ignore-scripts` policy.
- [npm lockfile contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/): integrity-bearing lock metadata is retained for inspection.
- The installed `@deepseek-ai/dsh-client-connection@0.2.1-rc.2` implementation defines browser `COOKIE_PAYLOAD_VERSION = 1`; `authenticateApi()` accepts version 2 only with its operator identity. The authentication regression continues to reject v2 at the browser launch exchange.
