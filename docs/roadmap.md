# After SSH connections

Keep the connection record and native Harness Host as the product boundary.

1. **Remote bootstrap.** Prefer a future native Harness service/attach command. Otherwise integrate an OS user service manager, with explicit installation, start and stop actions. Discover an existing Host before starting one; establish exclusive runtime/index ownership. A network failure must never trigger a second Host. Distinguish surviving disconnect, recovering after crash, and starting after reboot.
2. **Control other PC through existing networking.** Connect to a workstation's native Harness using SSH or an already configured private network. Reuse the workstation's sessions, credentials and capabilities. Reassess native client Host switching when Harness exposes that contract; do not patch its global connection service.
3. **Control this PC / device pairing.** Only if access without SSH is needed, evaluate existing Harness auth and an established private networking or relay solution. Pairing must be short-lived, directional and revocable, with explicit target identity and local disable controls. Keep authorization on the destination Host. Do not create accounts, discovery, a cloud relay or a second RPC protocol in advance.
4. **Computer interaction.** Discover and display capabilities already provided by the destination's plugins. Screen capture, mouse/keyboard control and browser automation belong to those plugins and OS permissions. Connections should not implement desktop drivers, job queues, sessions or an automation engine.

Acceptance for later stages includes reconnecting to existing work, preserving pending approvals, rejecting revoked devices, no duplicate prompts after uncertain delivery, and clear target identity. Reuse Harness session request IDs and event recovery instead of creating replay logic here.
