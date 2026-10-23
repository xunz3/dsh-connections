# Beyond managed SSH

The current implementation manages one saved connection and reuses a full native remote Harness. Keep that boundary.

1. **Upstream integration.** Track native persistent Host/service commands, public live Host switching, and persistent desktop guest partitions. Adopt them when available to simplify this plugin. Official `fs-ssh` / `process-ssh` providers remain the choice for local sessions with remote tools; that is a separate mode and should only be added for a concrete need.
2. **More operating systems.** Verify the macOS controller path. Add a remote OS service adapter only when needed, reusing launchd or Windows services rather than writing a daemon. Keep existing-service attachment for machines without supported managed services.
3. **Control other PC.** SSH already reaches a configured workstation's full native Harness. Broader access should reuse existing private networking and destination-side authorization. Evaluate pairing only if access without SSH is required.
4. **Control this PC / pairing.** Use an established private network or relay and native Harness authorization. Pairing must be directional, short-lived and revocable, with explicit target identity and a local disable control. Do not preemptively add accounts, cloud discovery, a relay or another RPC protocol.
5. **Computer interaction.** Use capabilities supplied by destination plugins and operating-system permissions. Screen capture, input control, browser automation, jobs and sessions belong to those components. Connections supplies access and target identity.

Future acceptance should include revoked-device rejection, pending-approval continuity and no duplicate prompt submission after interrupted delivery. Reuse native request IDs and event recovery; do not add prompt replay here.
