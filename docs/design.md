# Connections design

Source review: 2026-10-29. Local sidebar and command-routing baseline: exactly `0.2.1-rc.3`. The separate remote bundle supports the explicitly tested `0.2.1-rc.2` and `0.2.1-rc.3` Hosts; updates reject versions outside that list.

The client presents local and remote projects in one Workspaces list. See [Unified Workspaces](unified-workspaces.md) for the supported plugin composition, navigation protocol and boundaries, and the [Codex source review](codex-reference.md) for the reference architecture.

## Dependency decision

| Dependency | Responsibility |
| --- | --- |
| System OpenSSH | SSH config, key/agent authentication, host trust, jump hosts and encrypted forwarding |
| ssh-config 5.3.0 | Parse existing SSH config for a read-only list of host aliases; no transitive runtime dependencies |
| glob 13.0.6 | Expand Include file patterns with brace, extglob and recursive globstar expansion disabled |
| Node >=22.12 locally | Child processes, sockets, native HTTP checks and validation |
| Remote Linux, Node 22.19+ or >=24, npm, systemd, flock, tar | Native Harness installation, persistent user service, maintenance locking and rollback snapshot |
| Cordis 4.0.5; Harness credentials and Typert 0.2.1-rc.3 | Plugin lifecycle, existing private records and authenticated owner RPC |
| Harness api-remotes, settings, slots, renderer, locale, workspace, layout | Existing client services and extension points; build-time dependencies |
| Harness sidebar-browser bridge types | Desktop guest lease and isolation; no Electron runtime dependency |
| React 18, TypeScript 5.9, esbuild, tsx, Playwright | Compilation and transport, lifecycle and UI verification |

The added production packages handle config parsing and Include file matching. Harness supplies peer dependencies and the client ModuleLoader. No new SSH/SFTP implementation, session database, file API, process supervisor, automation engine or cloud relay is introduced.

## Why not just enable official SSH plugins?

The official [SSH subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ssh.md) already provides `@deepseek-ai/dsh-ssh`, `fs-ssh`, `process-ssh`, `env-ssh` and remote-agent support. Use these when a local Harness session should execute tools against a remote machine. Their SSH helper is scoped to the transport/lease lifetime; it is not a persistent full remote Harness Host.

This plugin serves a different requirement: the complete Harness, with sessions, approvals, providers, plugins and files, lives on the remote computer and remains available after the controller exits. Its interface aggregates native workspaces in one local navigation surface and embeds only remote conversation/file content. The official [fs-ssh provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ssh/fs-ssh/README.md) alone does not make the current native workspace picker remote: that flow also uses Host-local filesystem operations, and the provider does not implement filesystem watching. Adding it here would duplicate the full remote Host's filesystem access without solving Host lifetime.

Reuse the official providers if a future feature needs local sessions with remote execution. Do not make them a dependency simply because both products use SSH. Reassess this design if Harness introduces a public persistent Host/service or live client Host-switch API.

## One entity: the connection

A saved connection contains a name, SSH target, mode, auto-connect preference and the last successfully bound local port. It uses the existing Harness credentials provider, not another database. An existing-service connection also holds its launch credential. A managed connection retrieves a fresh credential from its private remote service log on each connection and never persists that token locally.

Public views expose status, address and runtime version, never launch credentials. The owner-only Open operation returns the authenticated local URL. The UI remembers only the selected connection ID and native session identity. Projects and session identities remain native Harness data.

Adding a connection opens a native dialog in the existing settings section. It lists unsaved SSH aliases for multi-selection, with refresh, search for long lists and a manual form for custom targets or existing services. Discovery does not connect. Submitting saves each selection and immediately initiates its connection; SSH preparation continues in the list, where the user can cancel it. Partial save failures retain only unsaved selections. The owner-only discovery RPC returns aliases from the Harness Host's configuration, not configuration contents. It bounds file size, Include traversal and result count; it never runs `ssh -G`, `Match exec` or configuration commands. OpenSSH resolves the chosen alias when connecting.

The list switch expresses persistent connection intent using the existing `autoConnect` field. Explicit connect/reconnect atomically enables it, and explicit disconnect disables it before stopping the local transport. A failed connection remains enabled and offers Retry. Internal cleanup, updates and startup restore preserve the saved intent. The storage operation changes only this field, so another view's metadata edit or deletion is not overwritten. Workspace buttons delegate to the existing native picker and navigation controller after closing Settings.

Connection dialogs use the browser's modal focus containment and Harness's shared `useModalLayer` stack. Escape and application Close belong to the foreground dialog; the parent Settings remains open. Browser modal cleanup runs before the shared layer restores focus to the invoking control. Row menus and action icons use the native primitives.

Settings and remote content use the same surface capability check: a supported native Desktop guest bridge or a local HTTP localhost/127.0.0.1 browser. Desktop is identified by its versioned guest capabilities, not a protocol-name exception. Browser origin limits preserve same-site loopback cookies and do not apply to native isolated guests.

The original Connections SVG is shared by the panel and the packaged `assets/logo.svg`. Harness rc.3 exposes no settings-section icon option, so a lifecycle-scoped adapter follows the sorted native slot registry and adds a CSS mask only to the matching navigation row. Guards on row count and shape retain the host's icon if the shell changes. It does not observe the whole document, match localized labels or rewrite host elements; disposal removes its style and subscription.

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

Connections contributes a source-aware `sidebar.workspaces` occupant and a remote main panel. A dedicated remote profile disables native `ui-layout` through its bundle patch; the plugin provides a small content layout using public services and native conversation/rightbar slots. See [Unified Workspaces](unified-workspaces.md) for the complete contract.

The local native shortcut provider and Host configuration remain in place. A version-checked adapter wraps resolvers on the existing rc.3 command registry, follows registration changes and restores its own wrappers on disposal. Native dispatch and keybinding policy remain intact. This uses a narrow private registry contract until Harness exposes resolver middleware. Incompatibility closes or blocks remote surfaces while native local commands remain available; it never replaces the provider that the local layout depends on.

Native owner controllers supply catalogs and mutations. A revisioned view channel carries navigation and actual selected-session acknowledgements. Credentials and destination resolution remain Host-side. The child document uses native transport for all conversation, files, media and approvals. Local selection closes only the remote view. The existing SSH port preference preserves browser origin when available; native workspace/session state remains independent of that origin.

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
- [Codex Connections](https://learn.chatgpt.com/docs/remote-connections) and [public daemon source](https://github.com/openai/codex/blob/2839ed763bd3f404398e1f0c95bf4e2d172213c0/codex-rs/app-server-daemon/README.md): separate transport, session and process lifetimes. ChatGPT relay authorization is not reusable for Harness.

No reference-project source is vendored into this plugin.
