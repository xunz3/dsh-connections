# Using connections

## Requirements

Install into the local Harness profile. Managed mode installs the remote content plugin automatically. Existing-service mode requires the remote bundle described below. Linux uses OpenSSH ControlMaster; macOS follows the same path. Windows uses an owned loopback listener with native OpenSSH stdio forwarding. Historical Desktop checks and the current platform-specific acceptance limits are recorded in [development](development.md). Remote content uses the native Desktop guest bridge or a local HTTP browser.

The current source keeps Harness's native sidebar independently deployed. Connections contributes only its source-aware workspace list and settings header; failure or disabling either its entry or whole bundle does not remove the native navigation shell. The list/header withdraw when another negative-priority provider owns their slot. The native shortcut provider and configuration remain in place. User keybindings remain in native storage. Keep `stopSequenceMs` on the native `shortcuts` deployment; restore it there if an old installation moved it into Connections. See [review follow-up](<review-followup.md>) for the changed New Session tradeoff and migration boundary.

Installing and first enabling 0.1.5 could blank an open rc.3 Desktop renderer. Version 0.1.6 removes the shortcut-provider replacement responsible for the reproduced failure. Migrating an active 0.1.5 installation may still need one renderer reload as its old provider retires. Save unsent drafts before migration; Connections never reloads automatically. See [Desktop migration details](harness-compatibility.md#updating-an-open-rc3-desktop).

Configure SSH normally and verify `ssh devbox` in a terminal first. Connections uses noninteractive key/agent authentication and existing `known_hosts`. Password prompts and first-use host trust are handled in the terminal. Ports, IPv6 targets, jump hosts and other settings belong in SSH config.

The connection form also offers **Test SSH** before saving. It runs a fixed, read-only command through system OpenSSH with a 15-second deadline, without saving a connection, installing Harness or starting a service. It does not accept new host keys or update existing ones. Success verifies SSH authentication and command execution in a POSIX-compatible remote shell; Node, systemd, forwarding and Harness readiness are checked separately when connecting. Changing the target clears the previous result. Failure distinguishes host trust, authentication, DNS, refused connections, network reachability and timeout, without exposing SSH output.

For **Run in the background**, the remote computer needs:

- Linux and a running systemd user manager, with `loginctl show-user "$USER" -p Linger` reporting `yes`.
- Node.js 22.19+ or >=24 and npm; `flock` and `tar`.
- Access to the npm registry and space for Harness, managed data and an update snapshot.

These installation/update requirements are separate from reconnect: an already installed service can be reused without npm or linger, but still needs Node, its systemd user manager, the maintenance lock and systemd-run. If linger is disabled, logout/boot persistence is no longer assured. For installation, configure it using your host's normal policy (`loginctl enable-linger "$USER"`) before connecting. Connections does not enable it for you. Remote service availability still depends on the operating system and machine; powered-off machines cannot run tasks.

Connections uses the Node on the remote noninteractive SSH PATH. Verify it with `ssh HOST node --version`; an interactive terminal may use a different runtime. Configure your account’s noninteractive environment when using a version manager such as nvm. Connections does not run login or interactive shell startup to discover a runtime. Existing managed services retain their recorded runtime and native-module ABI.

On Windows, each local TCP connection uses a separate system `ssh -W` process; HTTP keepalive and WebSockets retain their stream. The listener is owned before use, and the native Harness authentication exchange must succeed before the connection is shown as connected. Idle listeners have no SSH process; the next stream authenticates again. Both transports preserve native SSH configuration and disable inherited port forwarding, agent forwarding and local commands.

After establishment, forwarding/network/launch failures close only the affected stream. A later authentication or host-key failure instead revokes the connection, closes its streams and shows terminal/key verification guidance; it never retries authentication automatically. A forwarding channel's own permission error is not mistaken for authentication failure. SSH launch failures are contained and must not terminate the Harness Host. Initial authentication failure remains a connection error.

Workspace control requests reuse a bounded HTTP connection pool owned by their SSH transport. A pool retains at most two idle streams and admits eight active streams; idle streams expire after 30 seconds. Disconnect, reconnect and unload destroy it. Authentication exchanges remain separate, and an uncertain failed write is never replayed automatically.

## Add and open

1. Open **Settings → Connections → Add**. The dialog lists SSH-configured hosts that have not already been added. Select one or more, then choose **Add**. Refresh rereads configuration; long lists offer search. Opening the dialog or selecting checkboxes never starts SSH.
2. **Add** saves and enables the selected connections, then starts preparing each Host. The dialog closes after saving; connection progress appears in the list. If a save fails, successful entries stay saved and only the failed selections remain for retry. Quick-add uses **Run in the background**; the dialog explains its Linux/systemd requirement. The first connection installs pinned Harness `0.2.1-rc.2` and its content bundle; later connections reuse the service.
3. To customize the name/target or attach an existing service, choose **Add manually**. Enter an alias or `user@hostname`, optionally **Test SSH**, then choose **Add and connect**. Existing-service mode requires the launch URL. Names can be edited later from the row menu.
4. Local and remote projects share the **Workspaces** sidebar and the same entry points. Select a project or chat, or use **Add workspace** and choose its computer.
5. Connected rows also offer **Add workspace** and **View workspaces** icon buttons. These close Settings and open the native remote picker or existing workspace. Remote computers use Harness's built-in browser directory list, so selection takes place in this window even if the server has a graphical desktop. Conversation and files appear in the main area while the unified sidebar stays available. The list's **New Session** action and guarded keyboard command target the selected computer. The retained native top **New Session** button intentionally returns to this computer and uses local native navigation. Select a local row to switch back as well.

Selecting a remote computer shows connection and loading feedback in the main area. Loading ends when the native directory picker is mounted or the requested session has become current. If that content-loading stage receives no readiness acknowledgement within 30 visible seconds (the presentation budget pauses in a hidden document), it shows an error: use **Reconnect** to refresh the managed Host address and authentication, rebuild its SSH tunnel and retry the operation, or **Cancel** to return to this computer. SSH setup and first-time installation have their own connection progress; the 30-second limit applies to presenting remote content.

Click the **Host** button beside the native **Settings** title to choose **This computer** or a remote connection. Its menu shows connection status and marks the selected Host. Remote Settings starts in that Host's native **Models** page; its accounts, API keys, plugins and execution permissions remain independent. **General** opens the local application's native preferences, including language, theme and fonts. Switching Hosts keeps the application's presentation consistent without changing saved remote preferences. See [Settings and plugin ownership](host-settings.md). Opening a remote directory does not create a workspace with that path on the local Host.

To install or manage remote plugins, connect the computer in **Settings → Connections**, then choose its **More actions → Manage plugins**. The remote native Plugin Manager opens in the main area and applies changes to that Host. Select a local workspace/chat to return; local plugin installations are unchanged.

The candidate list reads SSH configuration on the computer running Harness, including user/system config and static `Include` files. **Refresh SSH hosts** preserves selections that still exist. Already saved targets are omitted; only saved connections appear in the workspace host chooser. Empty or unreadable configuration still permits manual entry, and editing preserves a saved target that is no longer listed.

Discovery lists concrete aliases only; wildcard and negated patterns are not choices. Conditional includes contribute candidates without evaluating `Match` or running commands. Host-dependent include paths cannot be discovered statically. Connection settings are resolved by OpenSSH when connecting; discovery does not copy keys, resolve hosts or contact servers.

Use native Desktop or a browser on the same computer running the local Harness, through `http://127.0.0.1` or `http://localhost`, to open remote content. HTTPS, IPv6 loopback browser URLs and other browser origins are not supported. Desktop uses the native isolated guest lease API for both content and Settings, and its Add button follows that capability instead of the browser URL restriction. Native shortcut dispatch retains its platform, binding and menu behavior. If the checked native command-routing contract is unavailable, Connections closes or refuses remote views while retaining native local controls.

The native brand/New Session button retains local semantics; Connections does not intercept its service or injected callback. Source-labelled row actions and the New Session keyboard command remain source-aware. Search/add commands use the unified list. Close dismisses the selected remote view or Settings without closing the Desktop window. Remote session, terminal, browser and pane commands that cannot yet be delegated safely show guidance; use the remote native menus and pane controls, or the source-labelled row actions. These commands never operate on the retained local session. In a web browser, keyboard input inside the remote iframe continues to use that document’s native shortcuts.

## Closing and restoring

**Selecting a local workspace/chat**, cancelling a remote opening operation, or invoking the native top **New Session** button closes the remote view. The source-aware keyboard/list **New Session** action keeps the selected computer. Switching the connection off, choosing **Remove**, or closing local Harness closes its owned tunnel. On POSIX, a small local process holds the master process group until cleanup completes; loss of its parent pipe also cleans up after an abruptly terminated Host. This cannot guarantee cleanup after killing that supervisor itself or an operating-system failure. None of these local actions stops or uninstalls the remote service.

The switch enables a connection now and remembers it for the next Harness start. Switching off also cancels an in-progress connection; it closes only local access and does not stop remote work. A failed enabled connection keeps its switch on and offers **Retry**. Explicit connections from workspace navigation also enable this saved preference. Editing a name keeps the current transport; editing the destination or credential replaces access, and an enabled connection is reconnected to the edited destination. The edit form preserves a switch change made from another settings view.

The next local startup reconnects enabled entries with at most four attempts running concurrently, starting the next whenever a slot is free. If a remote view was selected when the browser closed, it opens again after connecting. The tunnel tries its previous local port to preserve native browser state; if another process owns that port, it allocates a different one. The remote projects and sessions persist regardless of that browser address.

Explicit navigation, including creating a new local session while startup restoration is pending, cancels the older restoration request. Native background restoration of the previous local session does not erase the saved remote selection.

The local preference stores the selected computer and native session ID, so selection can be restored when the content document is recreated. File pane preferences still follow native document storage. The plugin does not persist remote catalogs or conversation logs locally.

The service has `Restart=on-failure` and is enabled for the user's systemd target. Linger allows the user manager to remain after logout and start at boot. Remote task behavior after a Host crash or reboot follows Harness's own recovery rules; process supervision is not a guarantee that an interrupted model operation resumes.

When Connections refreshes its own remote content bundle, it asks the native plugin manager to apply that change without restarting the Host. It records success only after native activation succeeds. If Harness reports that a restart is required, Connections reports that requirement and leaves the Host running.

The connection list shows the actual preparation, tunnel and authentication stages while connecting or updating. Startup restore runs at most four hosts concurrently and starts the next as soon as a slot is free. Manually disconnecting or editing a queued host takes precedence. The settings list pauses automatic polling in a hidden page and refreshes when it becomes visible again. These changes do not enable automatic retries after an unexpected disconnection; use **Reconnect** to restore access.

## Explicit updates

Enable the connection, then open **More actions → Update remote Harness**. The dialog defaults to the **latest compatible version**, currently `0.2.1-rc.5`, and shows the exact target without a version input. Choose **Update** to proceed or **Cancel** to leave it unchanged. Updating an already current Host does not restart it. Ordinary connect never upgrades the installed version.

“Latest compatible” means the newest version verified for the bundled remote content, not an unvalidated npm dist-tag. The npm `latest` tag observed on 2026-10-29 still pointed to rc.2, while `next` pointed to rc.4; installing `@latest` blindly could downgrade rc.3. If a managed installation already uses a version outside this plugin's verified list, a default update stops and asks you to update Connections rather than replacing that installation. The typed update API retains explicit exact-version selection for deliberate recovery; unknown versions and ranges are rejected. Local runtime compatibility remains exactly rc.5 while the private shortcut and remote settings/account contracts are version-reviewed.

Let running tasks finish before submitting: updating restarts the remote Host. The new package is installed and validated first. The updater then snapshots the managed Harness home and agents directory while stopped, switches release, and checks native authentication. Failed startup rolls back the previous release and managed state. It does not snapshot or revert project files outside those directories. A rollback failure preserves the recovery snapshot and reports the error.

Remote maintenance is owned by a transient systemd unit. Closing the local controller does not cancel a remote update already underway; reconnect to obtain its result. Do not launch manual writes to that managed home during an update.

This guarantee covers controller/SSH disconnection, not a power loss or forced termination of remote maintenance. After such an interruption, reconnect runs journal recovery; the enabled service may already have started at boot, and rollback can replace managed state written since the snapshot. Avoid scheduling a remote reboot during an update. Reboot-safe update transactions are not an acceptance-tested feature.

## Remote installation

The owned installation is under `~/.local/share/dsh-connections`:

- `home` and `agents`: dedicated native Harness data, separate from default `.dsh`.
- `releases` and `current`: pinned packages and selected release.
- `plugins` and `installer`: verified content bundles and a pinned pnpm used by the native plugin installer.
- `service.log`, `install.log` and `maintenance.log`: private diagnostics; the former contains the native launch credential. Do not share them unredacted.
- Each release retains its npm `package-lock.json` and `release.json` with the main package SRI and lock digest for auditing. npm verifies fetched tarballs against their registry integrity. This is not publisher signature verification or an offline release format.
- Installer subprocesses receive only required execution variables plus an allowlist of proxy, CA and npm networking configuration. Native package lifecycle scripts remain enabled because Harness and its native dependencies require them.
- `environment`: private remote proxy, CA, npm networking configuration and a filtered PATH of absolute directories, taken from the remote SSH environment. The recorded Node runtime is placed first, followed by the owned pnpm installer directory so native plugin management can resolve it. Refreshing this file does not restart a running Host; an updated PATH takes effect on its next normal or explicit start. No local settings or model keys are copied.

New installations use `$XDG_CONFIG_HOME/systemd/user/dsh-connections.service` when an absolute `XDG_CONFIG_HOME` is set, otherwise `~/.config/systemd/user/dsh-connections.service`. Existing owned installations retain their recorded unit location. The service pins its installed Node runtime so native dependency ABI stays consistent. Keep that runtime available; a removed runtime or incompatible Node/npm combination produces an explicit repair diagnostic instead of silently switching executables. Inspect or explicitly stop it on the remote computer:

```sh
systemctl --user status dsh-connections.service
systemctl --user disable --now dsh-connections.service
```

Connecting in managed mode starts/enables it again. Remove or disable auto-connect locally first if you intend to leave it stopped. Removing a saved connection deliberately preserves remote data and the service. Uninstalling remote data is a separate manual action.

## Connect an existing service

Prepare a dedicated remote Web profile with the bundled content layout. Copy `dist/remote-plugin.tgz` from the built local plugin to the remote machine, then install it through the native plugin manager:

```sh
dsh plugin --profile web add /absolute/path/to/remote-plugin.tgz
dsh web --host 127.0.0.1 --no-open
```

Use an isolated `DSH_HOME` and configure models there if the machine already has a separate full Harness interface. The bundle replaces the layout in its selected profile; it keeps native conversation, files and overlays. Its native settings remain accessible through the local Settings host selector. Normal local plugin installation uses the main package, not this embedded bundle.

Choose **Use an existing service** locally and supply the complete loopback launch URL printed by that Host. The service must listen on IPv4 `127.0.0.1`; a `localhost` URL alone does not establish IPv4 availability. Keep it running using your existing service manager. Connections does not install, restart or update an existing-service Host. Its launch credential stays in the native credential provider; leave the URL blank while editing to retain it. Refresh it after the destination Host restarts. Older saved connections retain their settings, but require the remote content bundle before unified Workspaces can open them.

## Agent tools

When the local Host composes the native Tools service, Connections also registers one `connections` tool. It calls the same validated Host operations as the owner UI, not another SSH implementation:

- `list`, `ssh_hosts`, `check_ssh`: inspect saved connections, page through SSH aliases, or run the fixed SSH preflight.
- `catalog`: page native workspace/session identities with their `transportId`. Pages default to 20 rows, at most 50; large paths are explicitly truncated and workspace membership is reported as a count rather than an unbounded list.
- `rename`, `connect`, `reconnect`, `disconnect`, `forget`, `update`: change an existing saved connection, after native approval. Approval shows its name, SSH target and mode; a Host-only revision refuses a destination/credential replacement while approval was pending. Disconnect preserves remote work; forget permanently removes locally stored connection credentials; update may interrupt remote work.
- `mutate`: rename/forget workspace membership, rename/archive/pin a session. Use the exact `transportId` from the catalog supplying those IDs; an old/missing identity is refused before forwarding. Archiving with `stopActivity: true` explicitly stops activity and is included in approval.

Adding a target, provisioning a launch credential, opening a content view and confirming damaged-record cleanup remain in Settings. The tool accepts neither a launch URL/token nor a record-delete confirmation. No generic command, event-answer, view-channel or arbitrary RPC action is exposed. If approval, an initiating Agent or the Host snapshot capability is missing, changes fail closed. An uncertain or cancelled started operation is not replayed: inspect authoritative state before retrying. Approval/connection revision checks serialize one manager's operations; they do not establish cross-process compare-and-delete for credentials.

## Damaged saved-record diagnostics

Open **Settings → Connections → Review damaged saved records** to list damaged recognized current/legacy records. This is an explicit read, not another background poll. Export downloads a **redacted diagnostic, not a recoverable credential backup**. To delete, first export, stop other writers and explicitly acknowledge permanent loss and the process-local concurrency boundary. A changed/expired receipt, a now-valid record or an unsafe-to-fingerprint payload refuses cleanup; refresh and inspect rather than replaying deletion.

Native credentials has no compare-and-delete: the guard only serializes Connections operations sharing the same provider object in one process. It cannot exclude another process/caller between its reread and exact-key delete. Unknown scopes/invalid keys are never claimed. See [diagnostic limits](<review-followup.md#诊断导出不是凭据备份>).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Unknown or changed host key | Verify host identity in a normal SSH terminal; do not disable checking. |
| Authentication failed | Unlock the SSH agent key and confirm noninteractive SSH. |
| Remote requirements not met | Check Node in the SSH shell, the systemd user manager, linger, npm and required tools. |
| Installation failed | Check registry access, disk space and private `install.log` on the remote computer. |
| Service ownership conflict | Inspect the named managed directory/unit. Connections will not overwrite a foreign unit or drop-in. |
| Service startup failed | Inspect `systemctl --user status` and the private `service.log`. |
| Remote content plugin version mismatch | Update the remote content bundle from the same local package, then reconnect. Managed mode verifies/repairs activation on prepare. |
| Maintenance failed | Inspect private `maintenance.log`; this is distinct from an operation still holding the maintenance lock. |
| Maintenance still running | Reconnect after the active operation completes; a second operation waits on its lock. |
| SSH forwarding failed | Check network routing and the server's TCP forwarding policy. |
| Existing Host authentication failed | Confirm the Host is running and update its launch URL. |
| Remote content did not finish loading | Check the SSH connection, then use Reconnect to retry or Cancel to return to this computer. |
| Local address opens on the wrong machine | Use a browser on the same computer as the local Harness. |

All connection management requires Harness owner authorization. Tunnels listen only on local loopback and preserve native application authentication.
