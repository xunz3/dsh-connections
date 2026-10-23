# Using SSH connections

## Set up once

Install the plugin into the local Harness Web profile. The plugin is not required on the remote Host. The local controller currently requires Linux OpenSSH with ControlMaster; the same mechanism is intended for macOS but has not been verified there. Windows OpenSSH is not supported in this release.

Configure authentication and host trust in your normal SSH configuration. For example:

```sshconfig
Host devbox
  HostName server.example.com
  User developer
  IdentityFile ~/.ssh/id_ed25519
```

Run `ssh devbox` in a terminal, verify the host identity, and confirm the key/agent works. Connections runs SSH noninteractively, so it does not ask for passwords, passphrases or host-key confirmation. Ports, IPv6 destinations, jump hosts and other options belong in SSH config; the plugin takes an alias or `user@hostname`.

On the remote computer, install/configure Harness normally and start its existing Web profile:

```sh
dsh web --host 127.0.0.1 --no-open
```

Keep that Host running. For persistent availability, use the machine's existing service manager. Connections does not install, start, stop or supervise the remote Host.

## Add and use a connection

1. Open local Harness **Settings → Connections**.
2. Add a name, SSH host, and the complete loopback launch URL printed by the remote Harness.
3. Select **Connect**. The plugin establishes SSH forwarding and verifies the native Harness authentication response.
4. Select **Open Harness**. The remote native UI opens in a browser tab. If a browser blocks the popup, select the resulting link.

Use the remote UI's workspace picker, sessions, terminal and approvals as usual. Provider credentials and model access must be configured on the remote Host. Connections does not copy local credentials or plugins to it.

**Disconnect** and **Remove** close only the plugin's SSH tunnel. The existing remote Host continues to own its work. Reconnect opens a fresh tunnel to the same Host; it does not replay prompts. Closing the local Harness or unloading the plugin releases its tunnels. Saved connections remain in Harness credential storage.

## Credentials and troubleshooting

The launch URL contains a credential. The plugin stores it in the existing Harness credential provider; it does not place it in configuration files or public status responses. The provider's own storage protection applies. Editing a connection leaves the saved credential hidden; leave the URL blank to retain it. Changing the SSH destination requires a new launch URL.

Harness `0.2.1-rc.2` launch tokens are reusable for that running process and change when the remote Host restarts. Paste its new launch URL after a restart. Signed browser cookies are separate and bound to each local tunnel authority. The plugin keeps native Host/Origin checks and application authentication enabled.

| Symptom | Action |
| --- | --- |
| Host identity is not trusted | Verify the key in a normal SSH terminal session; do not disable host-key checking. |
| Authentication failed | Unlock the key in your SSH agent and confirm noninteractive SSH access. |
| SSH timeout | Check routing, VPN, alias and jump host configuration. |
| Forwarding failed | Check the server's TCP forwarding policy. |
| Harness authentication failed | Confirm the remote Web Host is running on the port in its current launch URL. |
| Local address opens on the wrong computer | Use the browser on the same computer running the local Harness. A browser accessing Harness through another tunnel does not satisfy this requirement. |

Only the Harness owner may manage connections. The tunnel listens on local `127.0.0.1`; it does not publish a LAN or public endpoint. Other local processes can reach that port, but Harness still requires its own application credential.

Automatic remote startup, device pairing, reboot recovery, inline Host switching and desktop automation are outside this first release; see the [roadmap](roadmap.md).
