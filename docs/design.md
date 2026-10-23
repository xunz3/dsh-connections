# Connections: scope and implementation plan

Research baseline: 2026-10-23. Harness `0.2.1-rc.2` is the current npm `latest`; `next` is `0.2.1-rc.3`. The first release targets `0.2.1-rc.2`.

## Dependency decision

| Dependency | Purpose |
| --- | --- |
| System OpenSSH | SSH configuration, agent authentication, known_hosts, jump hosts, encrypted forwarding |
| Node >=22.12 | Child processes, loopback sockets, HTTP readiness checks, UUIDs |
| `@deepseek-ai/cordis` 4.0.5 | Harness plugin lifecycle |
| Harness credentials, Typert protocol/registry 0.2.1-rc.2 | Existing private credential storage and authenticated owner RPC |
| Harness api-remotes, ui-settings, ui-slots, ui-renderer, locale | Native settings entry and browser plugin integration; build-time dependencies |
| React 18, TypeScript 5.9, esbuild, tsx, Playwright | Client compilation and meaningful transport/UI verification |

No SSH protocol library, SFTP, HTTP proxy, database, job system, remote tool suite, or daemon is needed. Harness supplies peer dependencies at runtime. React and client services use its ModuleLoader.

## What is being built

One entity: a saved SSH connection. Its private authorization record holds the SSH target and remote Harness launch credential. Reuse Harness credentials to persist it; do not create a second settings/credential database. Public list/status responses project only non-secret fields.

The settings page saves a name, SSH target, and the launch URL printed by a running remote `dsh web`. Connect establishes a loopback-only tunnel. Open launches the remote native Harness UI in a separate browser tab. Disconnect closes only the owned SSH connection. Reconnect attaches to the same remote server; it never replays prompts or starts another Harness.

The agent runtime, sessions, history, approvals, files, terminal, providers, plugins, and model credentials remain on the remote Harness. There is no local mirror and no replacement session UI.

```text
Local Harness settings → owner-only Connections RPC → system OpenSSH
Local browser          → 127.0.0.1 tunnel             → remote 127.0.0.1 dsh web
```

The plugin runs on the local Harness Host. The browser opening the tunnel must be on that same computer. A loopback-looking URL alone cannot prove this (the local Harness may itself be reached through a tunnel).

## Why attach an existing Host first

Harness has no public live switchHost client API and no reusable daemon supervisor in this baseline. Starting extra Hosts under one home can encounter existing session writer leases; a configured persistent FTS index also has single-process ownership. The first version therefore attaches to a running native Web Host. Users manage its lifetime with their normal terminal or OS service manager.

This is a complete SSH connection path, not automatic remote installation or bootstrap. Disconnect leaves the existing remote Host running. Task survival still depends on that Host, its policies, and its operating system; the plugin does not promise reboot or crash recovery.

## Transport and authentication

- Delegate aliases, Include, Match, ProxyJump, ProxyCommand, agent and key handling to OpenSSH. Accept a target, never a command or arbitrary SSH flags.
- Require pre-established host trust with `StrictHostKeyChecking=yes` and noninteractive `BatchMode=yes`. Do not import private keys, store passwords, or enable agent forwarding.
- Own a private SSH control master so config forwards can be cleared before adding exactly one loopback forward. Never reuse or terminate a user's unrelated master.
- Bound startup and health checks; cancel pending connection attempts on disconnect/unload. A dropped connection becomes disconnected/error, not a failed remote task. Reconnect is explicit.
- Only accept `http://127.0.0.1:PORT/?token=...` (or localhost) as the remote launch URL. The destination of the SSH forward is always remote `127.0.0.1`.
- Preserve HTTP Host and Origin through raw TCP. Harness keeps application authentication inside SSH; do not disable it or rewrite authority.
- Current Harness launch tokens are reusable for that process, not one-time credentials. Its signed browser cookies are authority-specific, including port, so multiple local forwards can coexist. A restarted Host needs a fresh launch URL.
- Do not include tokens in status, logs, errors, config, or SSH argv. Return an authenticated local URL only from the explicit owner-only Open operation. Open with no opener/referrer.
- Owner authentication protects all management RPCs, including reads. Remote plugin code stays in the separate remote origin and has no bridge into local plugin services.

## Delivery sequence

1. Record dependency and architecture decisions before implementation.
2. Implement shared validation/RPC contract, owned OpenSSH transport, credential-backed connection manager, native settings UI.
3. Verify host-key failure, forwarding failure, cancellation, races, disconnect/reconnect, credential isolation, actual loopback SSH and browser behavior.
4. Validate the package and make a local initial Git commit. No publication or remote push is implied.

## Reference findings

- [Harness source, 687f282e](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317): `packages/client/connection` provides browser auth and transport; `packages/ssh/ssh` is a non-reconnecting remote execution helper, not a persistent remote Host. `packages/session/session-persistence-jsonl` owns session writer leases.
- [flymysql/dsh-remote, 03ba582d](https://github.com/flymysql/dsh-remote/blob/03ba582d0001c9eecdc6114d119fbbc4027c7b64/lib/web-attach.js): verifies the architectural usefulness of native Web attach. Its broader file tools/mirroring/deployment are outside this plugin's scope. The source comment calling launch tokens one-time does not match current Harness.
- [UynajGI/dsh-ssh, 5b7b4514](https://github.com/UynajGI/dsh-ssh/tree/5b7b451477f61d9b5444d3a02b8773abaeb56ba9): execution-backend integration; its relaxed host-key verification and plaintext credential persistence are not adopted.
- [dsh-ssh/dsh-ssh, 17764146](https://github.com/dsh-ssh/dsh-ssh/tree/17764146e474b44222d12a95c585b5de782f9daa): remote tool replacements, which this project avoids by opening the complete remote Host.
- [Blank-not-black/dsh-Remote, 813db951](https://github.com/Blank-not-black/dsh-Remote/tree/813db9518ae250a38a0c7262c4ec330cc8d67c63): gateway/device UI reference for later research; not a dependency.
- [Codex remote connections](https://learn.chatgpt.com/docs/remote-connections) and [public daemon source, 2839ed76](https://github.com/openai/codex/blob/2839ed763bd3f404398e1f0c95bf4e2d172213c0/codex-rs/app-server-daemon/README.md): separate transport, session, and process lifetimes. Codex now publishes daemon and remote-control host code, but its ChatGPT relay authentication is not reusable for Harness.

No source from these projects is vendored into this plugin.
