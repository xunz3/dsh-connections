Native integration uses two real Harness processes and OpenSSH. It requires
Linux, Node, `ssh`, `sshd`, `ssh-keygen`, an installed Harness CLI, and a built
plugin. It does not call a model or modify user profiles.

Build first so `dist/remote-plugin.tgz` exists, then start the isolated fixture:

```sh
DSH_QA_UNIFIED=1 DSH_QA_CLI=/absolute/path/to/@deepseek-ai/dsh/lib/bin.js \
  node test/integration/native-fixture.mjs start /tmp/dsh-connections-unified-qa

DSH_UNIFIED_FIXTURE=/tmp/dsh-connections-unified-qa \
  pnpm exec playwright test test/browser/unified-native.spec.ts \
    --config=playwright.native.config.ts
```

The helper installs the normal plugin on the local Host and the dedicated
remote bundle on the second Host. The remote bundle uses the official profile
patch to disable the native layout and selects the Connections content layout.
Both keep their native conversation, files and session services. Each Host has
its own temporary `DSH_HOME`, agent store, project directory and loopback port.

The process-local SSH wrapper uses temporary keys and config; no user SSH
configuration is changed. Its SSH server permits loopback forwarding and rejects
command execution. This verifies real SSH transport between two local processes;
deployment to a separate machine remains a separate lifecycle check.

The tests cover:

- Native remote boot without a second sidebar, and a clear direct-visit prompt.
- One Workspaces sidebar containing local and remote project/session rows.
- Native directory selection, cancellation and switching between computers.
- Native file trees, text previews, file upload and relative Markdown images.
- Upload/media requests using the remote origin, with no message sent to a model.
- Reload and local Host restart restoring the remote session while the remote
  process remains alive.
- Native customized archive/fork shortcuts focused in the parent sidebar showing
  a remote-action notice, without archiving or forking the retained local chat.

The test updates only its fixture connection's launch credential after a remote
restart. Its launch URLs are read from private logs and never printed by the
helper. Screenshots are written to Playwright's test output directory.

```sh
# Restart only the local Host; the remote Host keeps running.
node test/integration/native-fixture.mjs restart /tmp/dsh-connections-unified-qa

# After rebuilding, reinstall the remote tarball and restart only that Host.
node test/integration/native-fixture.mjs restart-remote /tmp/dsh-connections-unified-qa

# Close both owned Hosts and the isolated SSH listener.
node test/integration/native-fixture.mjs stop /tmp/dsh-connections-unified-qa
```

Temporary logs, keys and project files remain under the fixture directory.
Without `DSH_QA_UNIFIED=1`, the helper retains its single local Host mode for the
connection-settings smoke test in `test/browser/native.spec.ts`; it then owns no
remote Host and `stop` closes only its local Host and SSH listener.
