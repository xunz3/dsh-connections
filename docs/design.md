# Connections design

Source review: 2026-10-24. Target Harness API baseline: `0.2.1-rc.2`. The remote installer pins this version; updates require an explicit exact `0.2.x` version.

## Dependency decision

| Dependency | Responsibility |
| --- | --- |
| System OpenSSH | SSH config, key/agent authentication, host trust, jump hosts and encrypted forwarding |
| Node >=22.12 locally | Child processes, sockets, native HTTP checks and validation |
| Remote Linux, Node 22.19+ or >=24, npm, systemd, flock, tar | Native Harness installation, persistent user service, maintenance locking and rollback snapshot |
| Cordis 4.0.5; Harness credentials and Typert 0.2.1-rc.2 | Plugin lifecycle, existing private records and authenticated owner RPC |
| Harness api-remotes, settings, slots, renderer, locale, workspace, layout | Existing client services and extension points; build-time dependencies |
| Harness sidebar-browser bridge types | Desktop guest lease and isolation; no Electron runtime dependency |
| React 18, TypeScript 5.9, esbuild, tsx, Playwright | Compilation and transport, lifecycle and UI verification |

There are no added production dependency packages. Harness supplies peer dependencies and the client ModuleLoader. No new SSH/SFTP implementation, session database, file API, process supervisor, automation engine or cloud relay is introduced.

## Why not just enable official SSH plugins?

The official [SSH subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ssh.md) already provides `@deepseek-ai/dsh-ssh`, `fs-ssh`, `process-ssh`, `env-ssh` and remote-agent support. Use these when a local Harness session should execute tools against a remote machine. Their SSH helper is scoped to the transport/lease lifetime; it is not a persistent full remote Harness Host.

This plugin serves a different requirement: the complete Harness, with sessions, approvals, providers, plugins and files, lives on the remote computer and remains available after the controller exits. Its interface is the native remote Harness interface. The official [fs-ssh provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ssh/fs-ssh/README.md) alone does not make the current native workspace picker remote: that flow also uses Host-local filesystem operations, and the provider does not implement filesystem watching. Adding it here would duplicate the full remote Host's filesystem access without solving Host lifetime.

Reuse the official providers if a future feature needs local sessions with remote execution. Do not make them a dependency simply because both products use SSH. Reassess this design if Harness introduces a public persistent Host/service or live client Host-switch API.

## One entity: the connection

A saved connection contains a name, SSH target, mode, auto-connect preference and the last successfully bound local port. It uses the existing Harness credentials provider, not another database. An existing-service connection also holds its launch credential. A managed connection retrieves a fresh credential from its private remote service log on each connection and never persists that token locally.

Public views expose status, address and runtime version, never launch credentials. The owner-only Open operation returns the authenticated local URL. The UI remembers only the selected connection ID. Projects and session identities remain native Harness data.

```text
Local native project picker → Connections host chooser
  ├─ This computer → original native directory flow
  └─ Remote host   → native remote Harness interface

Local owner RPC → system SSH → systemd user service → native dsh web
Local UI        → owned loopback SSH tunnel        → remote loopback Web Host
```

## Persistent remote lifecycle

The first managed connection installs a pinned native Harness in `~/.local/share/dsh-connections`, with a dedicated `DSH_HOME` and `DSH_AGENTS_HOME`. It never adopts or modifies the user's default `.dsh` installation. A marked `dsh-connections.service` user unit is enabled with restart-on-failure. Persistent availability requires `loginctl enable-linger`; the plugin checks it and reports the prerequisite instead of changing host login policy.

Systemd owns the process. Disconnect, removal and local plugin unload close local tunnels only. Reconnecting starts an inactive owned service or reuses the running one, retrieves its current credential, then opens SSH forwarding. It does not implicitly update, replay a prompt or create a second Host. Multiple controllers serialize remote maintenance with `flock`.

Updates are explicit exact-version operations. Install and validate the requested release while the old Host is running, then stop its sole writer, snapshot managed state, atomically select the new release and verify native readiness. Failed startup restores the previous release and state. A private transaction journal supports recovery after interrupted maintenance. A transient systemd unit owns maintenance so closing the controller does not kill an in-progress update. Project directories outside the managed state are not rolled back.

Only the remote SSH user's proxy, CA and npm network configuration is passed through a private environment file. Local environment values and model credentials are not copied. Installation logs, launch logs, state and maintenance results stay private to the remote user.

## Native project and file UI

Harness has no public live `switchHost` client contract in this baseline. The plugin adds a host chooser at the native `directoryFlow` slots, delegates local selection to the original slot and uses the shell overlay slot for a full remote native interface. A remote path never reaches the local `onPicked` callback. The remote Host supplies its original directory picker, sidebar file tree, preview, terminal, sessions and approvals.

Web uses a same-site loopback iframe to preserve native Strict authentication cookies. Desktop uses the existing sidebar-browser lease bridge and its isolated guest. The remote interface has no bridge into local plugin services. Returning local closes only the view.

The last tunnel port is a preference, not a reservation: OpenSSH must successfully acknowledge ownership before any authentication request. An occupied port falls back to a fresh port. Stable browser origin normally preserves native selected project and sidebar state across local Host restart. The native desktop bridge currently uses nonpersistent guest partitions, so a full desktop app exit restores the remote connection but may require selecting the project again. Do not bypass that bridge to persist cookies.

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
