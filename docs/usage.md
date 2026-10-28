# Using connections

## Requirements

Install into the local Harness Web profile and restart it. Managed mode installs the remote content plugin automatically. Existing-service mode requires the remote bundle described below. Linux is the verified controller platform; macOS OpenSSH follows the same path but is unverified. Windows ControlMaster is not supported.

The local bundle reuses Harness's native sidebar with navigation routed to the selected computer. Disable the whole Connections bundle to remove its composition patch and restore the original sidebar deployment; disabling only its individual plugin entry leaves the bundle's sidebar patch in place.

Configure SSH normally and verify `ssh devbox` in a terminal first. Connections uses noninteractive key/agent authentication and existing `known_hosts`. Password prompts and first-use host trust are handled in the terminal. Ports, IPv6 targets, jump hosts and other settings belong in SSH config.

For **Run in the background**, the remote computer needs:

- Linux and a running systemd user manager, with `loginctl show-user "$USER" -p Linger` reporting `yes`.
- Node.js 22.19+ or >=24 and npm available to the SSH shell; `flock` and `tar`.
- Access to the npm registry and space for Harness, managed data and an update snapshot.

These installation/update requirements are separate from reconnect: an already installed service can be reused without npm or linger, but still needs Node, its systemd user manager, the maintenance lock and systemd-run. If linger is disabled, logout/boot persistence is no longer assured. For installation, configure it using your host's normal policy (`loginctl enable-linger "$USER"`) before connecting. Connections does not enable it for you. Remote service availability still depends on the operating system and machine; powered-off machines cannot run tasks.

## Add and open

1. In **Settings → Connections → Add connection**, select an SSH host from the dropdown or choose **Add manually** to enter an alias or `user@hostname`. The name is filled from your selection and can be edited.
2. Keep **Run in the background** selected. No launch URL is needed. **Connect automatically when Harness starts** is enabled by default for new managed connections.
3. Save the connection, then select **Connect**. Saving does not initiate SSH. The first connection installs pinned Harness `0.2.1-rc.2`, its Connections content bundle, and starts its user service. Later connections reuse it.
4. Local and remote projects share the **Workspaces** sidebar and the same entry points. Select a project or chat, or use **Add workspace** and choose its computer.
5. Choose a directory using that computer's native picker. Remote computers use Harness's built-in browser directory list, so selection takes place in this window even if the server has a graphical desktop. Conversation and files appear in the main area while the unified sidebar stays available. The top **New Session** button and keyboard command create a chat on the currently selected computer. Select a local row to switch back to this computer.

Selecting a remote computer shows connection and loading feedback in the main area. Loading ends when the native directory picker is mounted or the requested session has become current. If that content-loading stage receives no readiness acknowledgement within 30 seconds, it shows an error: use **Reconnect** to refresh the managed Host address and authentication, rebuild its SSH tunnel and retry the operation, or **Cancel** to return to this computer. SSH setup and first-time installation have their own connection progress; the 30-second limit applies to presenting remote content.

Click the **Host** button beside the native **Settings** title to choose **This computer** or a remote connection. Its menu shows connection status and marks the selected Host. The selected Host supplies the entire native settings page, including Models and its plugin sections, in one native dialog. Models, accounts, API keys and plugin installations are independent; local values are not copied. See [Settings and plugin ownership](host-settings.md), including how to install additional plugins into the managed remote profile. Opening a remote directory does not create a workspace with that path on the local Host.

The dropdown reads SSH configuration on the computer running Harness, including user/system config and static `Include` files. **Refresh SSH hosts** rereads it without changing the draft. Already saved targets are marked; only saved connections appear in the workspace host chooser. Empty or unreadable configuration still permits manual entry, and editing preserves a saved target that is no longer listed.

Discovery lists concrete aliases only; wildcard and negated patterns are not choices. Conditional includes contribute candidates without evaluating `Match` or running commands. Host-dependent include paths cannot be discovered statically. Connection settings are resolved by OpenSSH when connecting; discovery does not copy keys, resolve hosts or contact servers.

Use the browser on the same computer running the local Harness, through `http://127.0.0.1` or `http://localhost`, to open remote content. HTTPS, IPv6 loopback browser URLs and other browser origins are not supported; settings and content use the same eligibility check. The native desktop content path is currently disabled: its menu accelerators bypass document-local command routing and could target a local session. Its guest bridge adapter remains covered by contract tests, pending a native source-aware command interface.

The native brand/New Session controls and New Session keyboard command share the same source-aware action. Search/add commands use the unified list. With focus in the parent sidebar, archive/fork shortcuts show guidance instead of touching the previous local session. Focus the remote conversation to use its native shortcuts, or use its source-labelled row actions.

## Closing and restoring

**Selecting a local workspace/chat**, or cancelling a remote opening operation, closes the remote view. **New Session** keeps the selected computer. **Disconnect**, **Remove**, or closing local Harness closes its owned tunnel. None stops or uninstalls the remote service.

Editing the name or auto-connect preference keeps an active tunnel and view. Changing the destination or existing-service credential disconnects it.

The next local startup reconnects saved auto-connect entries in batches of at most four. If a remote view was selected when the browser closed, it opens again after connecting. The tunnel tries its previous local port to preserve native browser state; if another process owns that port, it allocates a different one. The remote projects and sessions persist regardless of that browser address.

Explicit navigation, including creating a new local session while startup restoration is pending, cancels the older restoration request. Native background restoration of the previous local session does not erase the saved remote selection.

The local preference stores the selected computer and native session ID, so selection can be restored when the content document is recreated. File pane preferences still follow native document storage. The plugin does not persist remote catalogs or conversation logs locally.

The service has `Restart=on-failure` and is enabled for the user's systemd target. Linger allows the user manager to remain after logout and start at boot. Remote task behavior after a Host crash or reboot follows Harness's own recovery rules; process supervision is not a guarantee that an interrupted model operation resumes.

When Connections refreshes its own remote content bundle, it asks the native plugin manager to apply that change without restarting the Host. It records success only after native activation succeeds. If Harness reports that a restart is required, Connections reports that requirement and leaves the Host running.

## Explicit updates

Open the connection's **More actions → Update remote Harness**. Choose an explicitly supported exact version: `0.2.1-rc.2` or `0.2.1-rc.3`. Other versions, tags such as `latest`, and ranges are rejected. Local sidebar compatibility is exactly `rc.3` in the current Connections release; the independently built remote content bundle advertises only the tested remote versions. Cancel leaves the version unchanged. Ordinary connect never upgrades the installed version.

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
- `environment`: private remote proxy, CA, npm networking configuration and a filtered PATH of absolute directories, taken from the remote SSH environment. The recorded Node runtime is placed first. Refreshing this file does not restart a running Host; an updated PATH takes effect on its next normal or explicit start. No local settings or model keys are copied.

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
