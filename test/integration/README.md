Native integration uses real Harness processes and OpenSSH. It requires Linux,
Node, `ssh`, `sshd`, `ssh-keygen`, an installed Harness CLI, and a built plugin.

Start an isolated controller and SSH listener:

```sh
DSH_QA_CLI=/absolute/path/to/@deepseek-ai/dsh/lib/bin.js \
  node test/integration/native-fixture.mjs start /tmp/dsh-connections-native-qa
```

The helper links this plugin into a temporary `DSH_HOME`, selects a local port,
and prints its PID, port, SSH alias, and private log path. Its process-local SSH
wrapper uses temporary keys and config; no user SSH configuration is changed.
The SSH server permits loopback forwarding and rejects command execution.

Use a separate disposable Harness Host as the SSH destination. Give it a project
directory containing `README.md` and `nested/source.txt`, whose content includes
`native sidebar nested file`. Its startup log supplies the launch credential
without printing it. The following test configures an existing-service connection,
opens the remote project, checks the native file tree and preview, returns local,
and reopens the saved project:

```sh
DSH_WEB_LOG=/tmp/dsh-connections-native-qa/host.log \
DSH_REMOTE_LOG=/tmp/remote-fixture/host.log \
DSH_REMOTE_TARGET=native-workspace-fixture \
DSH_REMOTE_NAME='Native workspace SSH' \
DSH_REMOTE_PROJECT=/tmp/remote-fixture/project \
  pnpm exec playwright test test/browser/remote-workspace.spec.ts \
    --config=playwright.native.config.ts
```

Set `DSH_QA_RESTART_FIXTURE=/tmp/dsh-connections-native-qa` to also restart the
owned controller inside the same browser context. This checks that the tunnel
origin, selected remote session, and open file preview survive. If the destination
Host is a second local process, `DSH_QA_REMOTE_PID` also verifies its Linux process
start time is unchanged. This exercises real SSH transport and separate Host
lifetimes; deployment to a separate machine is a separate lifecycle check.

For a previously saved connection, omit `DSH_REMOTE_LOG` and
`DSH_REMOTE_TARGET`. Set `DSH_REMOTE_REOPEN=1` to select the existing project
without calling project creation. The native config needs no mock web server.

Stop owned controller and SSH processes, retaining private logs and evidence:

```sh
node test/integration/native-fixture.mjs stop /tmp/dsh-connections-native-qa
```

The destination Host has its own lifecycle and is never stopped by this helper.
