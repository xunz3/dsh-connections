Native integration uses two real Harness processes and OpenSSH. It requires
Linux, Node 22.19+ or 24+, `ssh`, `sshd`, `ssh-keygen`, an installed Harness CLI, and a built
plugin. It does not call a model or modify user profiles.

CI installs the checked release tarball by setting `DSH_QA_PACKAGE` to its absolute
path. The default is the repository directory for local development.

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
Remote archives use content-hash filenames so a same-version rebuild cannot
reuse a cached package. Before either Host starts, the helper checks the
installed host/client hashes against the current build and records them in
`processes.json`; rebuild and reinstall when this check reports stale files.

The process-local SSH wrapper uses temporary keys and config; no user SSH
configuration is changed. Its SSH server permits loopback forwarding and rejects
command execution. This verifies real SSH transport between two local processes;
deployment to a separate machine remains a separate lifecycle check.

The tests cover:

- Native remote boot without a second sidebar, and a clear direct-visit prompt.
- One Workspaces sidebar containing local and remote project/session rows.
- Fresh plugin composition providing one native sidebar and one Connections
  settings page, without a duplicate native sidebar deployment.
- Both the sidebar and conversation workspace picker offering local and remote
  computers, with native directory selection, cancellation and switching.
- The global New Session action reusing the selected computer's native blank
  session and preserving its unsent draft on rc.3, with requests reaching only
  that computer. The native More menu remains available.
- The loading overlay remaining until the remote native document acknowledges
  that its directory picker or content is presented.
- Native file trees, text previews, file upload and relative Markdown images.
- Upload/media requests using the remote origin, with no message sent to a model.
- Reload and local Host restart restoring the remote session while the remote
  process remains alive.
- A Host menu beside the original Settings title, with one native dialog for both local and remote settings. Remote Models/plugin inventory and preference writes stay on their Host; local settings, workspace/session lists and selection stay unchanged.
- Keyboard focus and cancellation during a delayed settings-frame load, menu Escape handling, same-Host selection without iframe replacement, and dark/narrow menu placement.
- Native customized archive/fork shortcuts focused in the parent sidebar showing
  a remote-action notice, without archiving or forking the retained local chat.

The test updates only its fixture connection's launch credential after a remote
restart. Its launch URLs are read from private logs and never printed by the
helper. Screenshots are written to Playwright's test output directory.

The optional native reload check installs two revisions of a tiny test bundle
under the same package name and version. It verifies that CLI replacement alone
leaves the active code unchanged, then calls Harness's native PluginManager to
apply the new code without restarting the Host. It removes the test bundle after
the check and leaves the Connections bundle running:

```sh
node test/integration/native-reload.mjs /tmp/dsh-connections-unified-qa
```

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

Remote-version acceptance uses independently installed runtime prefixes and the
built remote archive. It checks the native compatibility evaluator, actual CLI
installation and activation, damaged-file repair, and optional Chromium
workspace/Settings navigation. All Host homes are temporary; no model is called:

```sh
DSH_QA_BROWSER=1 node test/integration/remote-compatibility.mjs \
  /tmp/isolated-harness-rc2 /tmp/isolated-harness-rc3
```

Each prefix must already contain the respective exact `@deepseek-ai/dsh` npm
installation. This check does not stand in for a real systemd cross-version
transaction, third-party plugin compatibility, or provider/model execution.
