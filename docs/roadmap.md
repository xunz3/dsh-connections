# Connections roadmap

[Unified Workspaces](unified-workspaces.md) is implemented through public plugin composition: one source-aware sidebar and native remote conversation/files. Future work should shrink adapters as Harness provides broader source composition APIs.

The next compatibility step is to separate build inputs, installation ranges
and verified versions. Native provider ownership and failure recovery must be
resolved before replacing the exact local gate with a lower bound, contract
boundary and known exclusions. See [version policy](harness-compatibility.md#version-policy-and-automatic-admission).

1. **Complete native list extensibility.** Preserve third-party row actions, native fork/search and manual ordering without mirroring remote sessions. Verify more remote capabilities and actual desktop rendering. Keep source-qualified identities and per-source recovery.
2. **Upstream integration.** Keep the plugin responsible for connections. Adopt native persistent Host/service and multi-source client APIs as they become available. Official `fs-ssh` / `process-ssh` providers remain the choice for local sessions with remote tools; that is a separate mode and should only be added for a concrete need.
3. **More operating systems.** Verify the macOS controller path. Add a remote OS service adapter only when needed, reusing launchd or Windows services rather than writing a daemon. Keep existing-service attachment for machines without supported managed services.
4. **Control other PC.** SSH already reaches a configured workstation's native Harness. Broader access should reuse existing private networking and destination-side authorization. Evaluate pairing only if access without SSH is required.
5. **Control this PC / pairing.** Use an established private network or relay and native Harness authorization. Pairing must be directional, short-lived and revocable, with explicit target identity and a local disable control. Do not preemptively add accounts, cloud discovery, a relay or another RPC protocol.
6. **Computer interaction.** Use capabilities supplied by destination plugins and operating-system permissions. Screen capture, input control, browser automation, jobs and sessions belong to those components. Connections supplies access and target identity.

Future acceptance should include revoked-device rejection, pending-approval continuity and no duplicate prompt submission after interrupted delivery. Reuse native request IDs and event recovery; do not add prompt replay here.
