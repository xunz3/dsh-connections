# Connections design

Connections manages SSH access to independent Harness Hosts. Each Host owns its
sessions, workspaces, files, models and plugins; the local client supplies one
source-aware navigation surface. See [unified workspaces](unified-workspaces.md)
for UI/protocol details and [compatibility](harness-compatibility.md) for native
adapter boundaries.

## Dependency decision

| Dependency | Responsibility |
| --- | --- |
| System OpenSSH | SSH config, key/agent authentication, host trust, jump hosts and encrypted forwarding |
| ssh-config 5.3.0 | Parse existing SSH config for a read-only list of host aliases; no transitive runtime dependencies |
| Schemastery 3.18.5 | Runtime configuration and Standard Schema validation |
| glob 13.0.6 | Expand Include file patterns with brace, extglob and recursive globstar expansion disabled |
| Node >=22.12 locally | Child processes, sockets, native HTTP checks and validation |
| Remote Linux, Node 22.19+ or >=24, npm, systemd, flock, tar | Native Harness installation, persistent user service, maintenance locking and rollback snapshot |
| Cordis 4.0.5; Harness credentials and Typert 0.2.1-rc.5 | Plugin lifecycle, existing private records and authenticated owner RPC |
| Harness api-remotes, settings, slots, renderer, locale, workspace, layout | Existing client services and extension points; build-time dependencies |
| Harness sidebar-browser bridge types | Desktop guest lease and isolation; no Electron runtime dependency |
| React 18, TypeScript 5.9, esbuild, tsx, Playwright | Compilation and transport, lifecycle and UI verification |

The added production packages handle config parsing, Include file matching and runtime configuration validation. Harness supplies peer dependencies and the client ModuleLoader. No new SSH/SFTP implementation, session database, file API, remote process supervisor, automation engine or cloud relay is introduced. A small local Node supervisor owns each POSIX OpenSSH master and cleans up after loss of its Host parent; systemd still exclusively owns the remote Harness lifecycle.

## Why not just enable official SSH plugins?

The official [SSH subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ssh.md) already provides `@deepseek-ai/dsh-ssh`, `fs-ssh`, `process-ssh`, `env-ssh` and remote-agent support. Use these when a local Harness session should execute tools against a remote machine. Their SSH helper is scoped to the transport/lease lifetime; it is not a persistent full remote Harness Host.

This plugin serves a different requirement: the complete Harness, with sessions, approvals, providers, plugins and files, lives on the remote computer and remains available after the controller exits. Its interface aggregates native workspaces in one local navigation surface and embeds only remote conversation/file content. The official [fs-ssh provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ssh/fs-ssh/README.md) alone does not make the current native workspace picker remote: that flow also uses Host-local filesystem operations, and the provider does not implement filesystem watching. Adding it here would duplicate the full remote Host's filesystem access without solving Host lifetime.

Reuse the official providers if a future feature needs local sessions with remote execution. Do not make them a dependency simply because both products use SSH. Reassess this design if Harness introduces a public persistent Host/service or live client Host-switch API.

## One entity: the connection

A saved connection contains a name, SSH target, mode, auto-connect preference and the last successfully bound local port. It uses the existing Harness credentials provider, not another database. An existing-service connection also holds its launch credential. A managed connection retrieves a fresh credential from its private remote service log on each connection and never persists that token locally.

Public views expose status, address and runtime version, never launch credentials. The owner-only Open operation returns the authenticated local URL. The UI remembers only the selected connection ID and native session identity. Projects and session identities remain native Harness data.

One Host `connectionOperations` service wraps the single manager/store with input/output validation and fixed safe failures. The owner RPC and optional `connections` Agent tool share it. Tool changes request native approval inside execution, capture the saved destination before waiting, and pass a Host-only revision to the manager's serial mutation boundary. Credential provisioning, new trust and damaged-record confirmations remain user-only; no tokenized Open result is returned to a model. Optional tool registration is an owned child effect, and the exact rc.5 SDK is type-only, not a new mandatory runtime import.

SSH discovery returns a bounded list of aliases from the Host's configuration.
It never runs configuration commands or connects to candidates. OpenSSH resolves
the selected alias when connecting. The saved `autoConnect` field expresses
persistent intent: connect enables it, disconnect disables it, and internal
cleanup preserves it. Name or auto-connect edits do not replace a healthy transport.

Settings and remote content use the same surface capability check: a supported native Desktop guest bridge or a local HTTP localhost/127.0.0.1 browser. Desktop is identified by its versioned guest capabilities, not a protocol-name exception. Browser origin limits preserve same-site loopback cookies and do not apply to native isolated guests.

```text
Local native project picker → Connections host chooser
  ├─ This computer → original native directory flow
  └─ Remote host   → native remote conversation and files

Local owner RPC → system SSH → systemd user service → native dsh web
Local UI        → owned loopback SSH tunnel        → remote loopback Web Host
```

## Persistent remote lifecycle

The first managed connection installs a pinned native Harness in `~/.local/share/dsh-connections`, with a dedicated `DSH_HOME` and `DSH_AGENTS_HOME`. It never adopts or modifies the user's default `.dsh` installation. A marked `dsh-connections.service` user unit is enabled with restart-on-failure. Persistent availability requires `loginctl enable-linger`; the plugin checks it and reports the prerequisite instead of changing host login policy.

Systemd owns the process. Disconnect, removal and local plugin unload close local tunnels only. Reconnecting starts an inactive owned service or reuses the running one, retrieves its current credential, then opens SSH forwarding. It does not implicitly update, replay a prompt or create a second Host. Multiple controllers serialize remote maintenance with `flock`.

Updates are explicit operations that default to the newest release in the verified compatibility list; the dialog displays that exact target. An explicit exact version remains available through the typed API for recovery. Default updates refuse an installed version outside that list instead of implicitly downgrading it. Install and validate the requested release while the old Host is running, then stop its sole writer, snapshot managed state, atomically select the new release and verify native readiness. Failed startup restores the previous release and state. A private transaction journal supports recovery after interrupted maintenance. A transient systemd unit owns maintenance so closing the controller does not kill an in-progress update. Project directories outside the managed state are not rolled back.

Only the remote SSH user's filtered absolute PATH, proxy, CA and npm network configuration is passed through a private environment file. Local environment values and model credentials are not copied. Installation logs, launch logs, state and maintenance results stay private to the remote user.

## Settings and plugin ownership

The native Settings header selects the local Host or a remote connection. Models, credentials and plugin installations belong to that Host and its profile. Remote forms run in a separate native document; local forms are never rebound to another backend. Settings uses a view lease independent from workspace navigation. See [Settings, models and plugins](host-settings.md) for the ownership matrix and installation boundaries.

## Native project and file UI

Connections contributes a source-aware `sidebar.workspaces` occupant and a remote main panel. A dedicated remote profile disables native `ui-layout` through its bundle patch; the plugin provides a small content layout using native conversation/rightbar slots and a version-bound layout adapter. Layout service replacement is a private integration boundary, not a public multi-Host composition API. See [Unified Workspaces](unified-workspaces.md) for the complete contract.

Local command dispatch remains owned by the native shortcut provider; the
[checked resolver adapter](harness-compatibility.md#desktop-remote-content-and-commands)
routes commands that require a selected Host.

Native owner controllers supply catalogs and mutations. Catalog pages retain the transport identity that supplied their rows; business mutations carry it in the local RPC envelope and the manager verifies it before authentication/forwarding, so an old row cannot mutate an edited/reconnected Host with overlapping native IDs. This is a transport/destination precondition, not an owner authorization replacement or a cross-process credential transaction. A revisioned view channel carries navigation and actual selected-session acknowledgements. Credentials and destination resolution remain Host-side. The child document uses native transport for all conversation, files, media and approvals. Local selection closes only the remote view. The existing SSH port preference preserves browser origin when available; native workspace/session state remains independent of that origin.

## Transport boundaries

- Delegate aliases, Include, Match, ProxyJump and authentication to OpenSSH; accept a target, never arbitrary SSH flags or a shell command.
- Use `BatchMode=yes`, `StrictHostKeyChecking=yes`, no agent forwarding, and private owned control masters. Never terminate unrelated SSH masters.
- Bind forwarding to local `127.0.0.1`, targeting remote `127.0.0.1`. Preserve HTTP Host/Origin and native application authentication.
- Bound startup, authentication and shutdown; cancel stale attempts and reject late Open results after destination changes or disconnection.
- Accept only validated native loopback launch URLs. Keep credentials out of SSH argv, public status, errors and diagnostics.
- Run management scripts through fixed SSH commands with configuration on stdin. Reject conflicting remote directories, unit files, loaded commands or unit drop-ins rather than taking ownership.
- The browser must run on the local Harness computer. A loopback-looking URL cannot prove this if the user forwarded the local Harness from a different computer.

## References

- [Harness source, 687f282e](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317): public client slots, credentials, native workspace/files and SSH providers.
- [flymysql/dsh-remote, 03ba582d](https://github.com/flymysql/dsh-remote/blob/03ba582d0001c9eecdc6114d119fbbc4027c7b64/lib/web-attach.js): native Web attach reference; its broader file tools/mirroring are outside this scope. Current native launch tokens are process-lifetime credentials, not one-time tokens.
- [UynajGI/dsh-ssh](https://github.com/UynajGI/dsh-ssh/tree/5b7b451477f61d9b5444d3a02b8773abaeb56ba9), [dsh-ssh/dsh-ssh](https://github.com/dsh-ssh/dsh-ssh/tree/17764146e474b44222d12a95c585b5de782f9daa): remote execution/tool alternatives; no replacement tools are needed here.
- [Codex public app-server/TUI source](https://github.com/openai/codex/tree/f970f4be6783428af0d39527102917a5305c71d7/codex-rs): reference for source-qualified identity and separate transport/session lifetimes; not evidence of the closed-source Desktop implementation.

No reference-project source is vendored into this plugin.
