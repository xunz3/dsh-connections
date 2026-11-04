# Known limits and roadmap

Connections currently provides SSH access, a unified workspace list and native
remote content/settings. The items below are remaining work, not implemented
features. Platform evidence and unresolved acceptance failures are recorded in
[development](development.md#acceptance-boundaries).

## Current limits

- **Workspace list:** no native fork action, server-wide history search, drag ordering, third-party row contributions or native hover cards. Search covers received catalogs; status does not infer completion from an idle session.
- **Events and control:** approvals, questions and task progress stay in the remote document. There is no local attention feed, subagent aggregation or independent controller identity.
- **Access:** no phone/public access, device pairing, controller scopes/revocation or computer-input control. Browser use requires the same computer as the local Harness.
- **Runtime compatibility:** exact local rc.5 admission, checked remote versions and remaining Settings/shortcut/layout/authentication adapters. See [compatibility](harness-compatibility.md).
- **Remote profiles:** embedded content requires a dedicated profile; third-party shell/provider combinations and a profile-conflict diagnostic are not comprehensively verified.
- **Presentation and cost:** remote content remains a separate native document and uses polling. It mirrors the local resolved palette; independently sourced palettes are not implemented. See [performance](performance.md).
- **Maintenance:** damaged-record cleanup is process-local, not cross-process compare-and-delete. Legacy lock-free environment/request temporary files cannot be safely reclaimed by a newer worker. Real cross-version update/reboot recovery still needs acceptance.

## Next directions

1. **Stability and platform coverage.** Diagnose the intermittent native authorization/presentation failures; expand Desktop, macOS, accessibility and managed-service recovery acceptance.
2. **Reduce native adapters.** Adopt public source-aware navigation, command resolvers, Settings projection and persistent Host APIs as they become available. Broader version admission needs an explicit contract boundary and native checks.
3. **Workspace parity.** Add source-aware native list capabilities without mirroring sessions or duplicating their lifecycle. Keep destination-qualified identity and per-source recovery.
4. **Event integration.** Evaluate the official Remote/Peer client with reconnect and answer ownership before adding attention indicators. Native approval/question events use waterfall delivery: a passive-looking listener can consume a pending answer. Verify two simultaneous clients, cancellation and interrupted delivery; never replay uncertain writes.
5. **Additional access modes.** Reuse established private networking and target-side authorization. Pairing, if needed, must be directional, short-lived and revocable. Remote OS support should use launchd or Windows services rather than a custom daemon. Computer interaction belongs to destination plugins and OS permissions.

Official SSH filesystem/process providers remain the alternative for local
sessions that only need remote tools. They serve a different execution model
from a complete remote Harness Host.
