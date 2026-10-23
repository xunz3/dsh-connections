# Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:browser
pnpm check:package
```

Tests use temporary loopback TCP and Unix sockets. Run them where local listening is allowed. Browser tests use Playwright Chromium; install it with `pnpm exec playwright install chromium` if needed. No model API key is required.

The optional real OpenSSH test creates an isolated localhost sshd and disposable keys. It never edits user SSH configuration:

```sh
DSH_CONNECTIONS_TEST_SSHD=1 pnpm exec tsx --test test/ssh.test.ts
```

This test requires `/usr/sbin/sshd`, `ssh-keygen` and permission to run the temporary server as the current user.

Source layout:

- `src/host`: credential records, connection lifecycle, authenticated RPC and owned OpenSSH processes.
- `src/client`: native Harness settings section, localized copy and scoped styles.
- `src/shared`: browser-safe wire contracts and strict validation.
- `test`: lifecycle/security tests, real transport fixture and browser interaction coverage.

`pnpm build` creates the host ESM entry with peer dependencies external, emits TypeScript declarations and wraps the client entry in Harness ModuleLoader. `cordis.patch.yml` adds the host plugin. The package checker inspects a real tarball, export targets and shipped file boundaries.

For native integration use a disposable `DSH_HOME` under `/tmp`, install the built checkout with `dsh plugin --profile web add /absolute/path`, then start `dsh web --host 127.0.0.1 --port 0 --no-open`. Keep launch URLs in private temporary files and do not copy them into test reports.

Pass the private startup log to the native settings test:

```sh
DSH_WEB_LOG=/private/path/to/startup.log pnpm exec playwright test native.spec.ts --workers=1
```

The test verifies the installed ModuleLoader bundle, owner RPC, saving across a page reload and deletion from native credential storage. It uses a clearly marked fake connection and makes no remote SSH connection or model request. Restart the isolated Host after rebuilding host code.

## Verification record

Verified on Linux with Harness `0.2.1-rc.2` on 2026-10-23:

- Type checking, production build and 32 Node tests passed, including the opt-in real OpenSSH test.
- Six browser fixture tests passed: connection actions, cancellation and delayed-open races, credential hiding, local-browser restriction, Chinese mobile layout, and light/dark views.
- The installed plugin passed native Harness settings save, reload and removal through its real RPC and credential provider.
- A disposable sshd forwarded a real native Harness Host through the actual connection manager. Two connect/disconnect cycles verified authenticated browser loading, HttpOnly/Strict cookies, live `remote.mux` WebSocket traffic, closed local ports after disconnect, and continued remote Host availability.
- An authorized existing server accepted key-based SSH and two forwarding cycles. Its HTTP endpoint returned 401; it was not identified as Harness. Another configured host timed out. No remote installation or configuration was changed.
- The packed npm artifact passed export, ModuleLoader, file-boundary and documentation-link checks.

No provider account or model inference was used. macOS, Windows, automatic remote startup and persistence across a remote Host restart were not acceptance-tested; see the documented release scope and roadmap.
