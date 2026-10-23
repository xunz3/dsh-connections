# Using connections

## Requirements

Install into the local Harness Web profile and restart it. The remote Host does not need this plugin. Linux is the verified controller platform; macOS OpenSSH follows the same path but is unverified. Windows ControlMaster is not supported.

Configure SSH normally and verify `ssh devbox` in a terminal first. Connections uses noninteractive key/agent authentication and existing `known_hosts`. Password prompts and first-use host trust are handled in the terminal. Ports, IPv6 targets, jump hosts and other settings belong in SSH config.

For **Run in the background**, the remote computer needs:

- Linux and a running systemd user manager, with `loginctl show-user "$USER" -p Linger` reporting `yes`.
- Node.js 22.19+ or >=24 and npm available to the SSH shell; `flock` and `tar`.
- Access to the npm registry and space for Harness, managed data and an update snapshot.

If linger is disabled, configure it using your host's normal policy (`loginctl enable-linger "$USER"`) before connecting. Connections does not enable it for you. Remote service availability still depends on the operating system and machine; powered-off machines cannot run tasks.

## Add and open

1. In **Settings → Connections**, add a name and SSH host.
2. Keep **Run in the background** selected. No launch URL is needed. **Connect automatically when Harness starts** is enabled by default for new managed connections.
3. Select **Connect**. The first connection installs pinned Harness `0.2.1-rc.2` and starts its user service. Later connections reuse it.
4. Select **Open Harness**, or use the normal **Add workspace / Choose workspace** entry and choose the remote computer.
5. In the remote native interface, choose a project directory. Use its native sidebar file tree and previews as usual. The top bar identifies the remote connection and provides **Return to this computer**.

Configure models, accounts and plugins in that remote Harness. Local accounts, API keys and plugins are not copied. Opening a remote directory does not create a workspace with that path on the local Host.

Use the browser on the same computer running the local Harness, through `http://127.0.0.1` or `http://localhost`, or use the desktop app. HTTPS and other browser origins are not supported for the embedded remote view. Desktop uses Harness's existing guest bridge; its actual Electron surface has not yet been acceptance-tested.

## Closing and restoring

**Return to this computer** closes the remote view. **Disconnect**, **Remove**, or closing local Harness closes its owned tunnel. None stops or uninstalls the remote service.

The next local startup reconnects saved auto-connect entries. If a remote view was selected when the browser closed, it opens again after connecting. The tunnel tries its previous local port to preserve native browser state; if another process owns that port, it allocates a different one. The remote projects and sessions persist regardless of that browser address.

In a Web browser, a stable origin preserves the native selected project/session and file pane. The current native desktop guest partition is temporary: after fully quitting the desktop app, the remote connection can restore, but you may need to choose the project/session again. This is an upstream bridge limitation, not loss of remote work.

The service has `Restart=on-failure` and is enabled for the user's systemd target. Linger allows the user manager to remain after logout and start at boot. Remote task behavior after a Host crash or reboot follows Harness's own recovery rules; process supervision is not a guarantee that an interrupted model operation resumes.

## Explicit updates

Open the connection's **More actions → Update remote Harness**. Enter an exact compatible version such as `0.2.1-rc.3`; tags like `latest` and ranges are rejected. Cancel leaves the version unchanged. Ordinary connect never upgrades the installed version.

Let running tasks finish before submitting: updating restarts the remote Host. The new package is installed and validated first. The updater then snapshots the managed Harness home and agents directory while stopped, switches release, and checks native authentication. Failed startup rolls back the previous release and managed state. It does not snapshot or revert project files outside those directories. A rollback failure preserves the recovery snapshot and reports the error.

Remote maintenance is owned by a transient systemd unit. Closing the local controller does not cancel a remote update already underway; reconnect to obtain its result. Do not launch manual writes to that managed home during an update.

This guarantee covers controller/SSH disconnection, not a power loss or forced termination of remote maintenance. After such an interruption, reconnect runs journal recovery; the enabled service may already have started at boot, and rollback can replace managed state written since the snapshot. Avoid scheduling a remote reboot during an update. Reboot-safe update transactions are not an acceptance-tested feature.

## Remote installation

The owned installation is under `~/.local/share/dsh-connections`:

- `home` and `agents`: dedicated native Harness data, separate from default `.dsh`.
- `releases` and `current`: pinned packages and selected release.
- `service.log` and `install.log`: private diagnostics; the former contains the native launch credential. Do not share them unredacted.
- `environment`: private remote proxy, CA and npm networking configuration, taken from the remote SSH environment. No local settings or model keys are copied.

The unit is `~/.config/systemd/user/dsh-connections.service`. Inspect or explicitly stop it on the remote computer:

```sh
systemctl --user status dsh-connections.service
systemctl --user disable --now dsh-connections.service
```

Connecting in managed mode starts/enables it again. Remove or disable auto-connect locally first if you intend to leave it stopped. Removing a saved connection deliberately preserves remote data and the service. Uninstalling remote data is a separate manual action.

## Connect an existing service

Choose **Use an existing service** and supply the complete loopback launch URL printed by:

```sh
dsh web --host 127.0.0.1 --no-open
```

Keep that Host running using your existing service manager. Connections does not install, restart or update it. Its launch credential is stored in the existing Harness credential provider and stays hidden when editing. Leave the URL blank to retain it; provide a fresh URL after the Host restarts or the destination changes. Existing connections saved by the first plugin version continue to work.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Unknown or changed host key | Verify host identity in a normal SSH terminal; do not disable checking. |
| Authentication failed | Unlock the SSH agent key and confirm noninteractive SSH. |
| Remote requirements not met | Check Node in the SSH shell, the systemd user manager, linger, npm and required tools. |
| Installation failed | Check registry access, disk space and private `install.log` on the remote computer. |
| Service ownership conflict | Inspect the named managed directory/unit. Connections will not overwrite a foreign unit or drop-in. |
| Service startup failed | Inspect `systemctl --user status` and the private `service.log`. |
| Maintenance still running | Reconnect after the active operation completes; a second operation waits on its lock. |
| SSH forwarding failed | Check network routing and the server's TCP forwarding policy. |
| Existing Host authentication failed | Confirm the Host is running and update its launch URL. |
| Local address opens on the wrong machine | Use a browser on the same computer as the local Harness. |

All connection management requires Harness owner authorization. Tunnels listen only on local loopback and preserve native application authentication.
