# Unified Workspaces

Connections supplies one local navigation surface for workspaces owned by different Harness Hosts. It uses public plugin composition and UI slots on Harness `0.2.1-rc.2`; no Harness source fork is required.

## Interaction

The existing sidebar contains local and connected remote workspaces together. Remote rows show a quiet computer name and connection status. A row's identity combines the saved connection ID with its native workspace or session ID. Local is the reserved source `local`.

Selecting a session changes the central content through its owning Host's native navigation. Local and remote workspaces share the same entry points: the native brand/New Session controls and New Session keyboard command all follow the currently selected source. Remote selection opens a native remote conversation and its files in the same main area, while the unified sidebar remains visible. Selecting a local row closes the remote view, leaving its Host and tasks running.

Add workspace selects the computer and then delegates to that computer's native directory flow. Connection configuration stays in Settings → Connections. The plugin does not create local workspace placeholders for remote paths or copy remote sessions and logs into local storage. Catalogs are temporary presentation data; the only saved UI preference is a source-qualified selection. Previously fetched remote rows remain available during a disconnect in the current client lifetime.

The remote bundle disables the native auto chooser and composes Harness's existing browser directory backend and UI together. This keeps remote directory selection in the browser, including on servers with a desktop display. The local profile retains its native picker choice.

Opening remote content keeps a visible loading state until the delegated native picker mounts or native navigation confirms the selected session. The presentation stage times out after 30 seconds without that acknowledgement, with controls to retry the operation or cancel back to this computer. Explicit navigation and New Session supersede pending startup restoration; passive native local-session restoration does not clear the saved remote choice.

## Native composition

The local bundle patch disables the separate `ui-sidebar` deployment. Connections installs the original native sidebar module under a Cordis scope that isolates `uiWorkspace`, forwarding its complete interface and routing only `startSession` to the current source. The original module owns the sidebar component, brand and rail controls, injected hooks, child slots and cleanup. Other plugins retain the original navigation service. The workspace list is the plugin's source-aware slot occupant; the surrounding sidebar is native.

At build time, an adapter includes the installed native sidebar's ModuleLoader factory in the plugin bundle and leaves its dependencies supplied by Harness. No sidebar source fork or replacement renderer is maintained. The package retains the upstream MIT license as `dist/native-sidebar.LICENSE`. Disabling the entire Connections bundle removes its composition patch and restores the native sidebar deployment; disabling only the Connections entry does not remove the patch.

The managed remote Host installs the same plugin code with a different bundle patch: disable native `ui-layout` and enable Connections with `embedded: true`. The plugin supplies the public `ILayout` contract and declares the native main, rightbar, bottom and overlay slots. It renders conversation and files without a second sidebar or settings shell. Theme presentation subscribes to the native theme service. The Host marks this dedicated profile through the documented `webserver/index-inject` hook.

Web renders that content in a same-site loopback iframe. A desktop guest adapter uses Harness's existing lease API, but the desktop entry is disabled until native menu commands can follow the active source. Separate documents preserve native session binding, media and upload origins, keyboard handlers, approvals and scoped file capabilities. No remote SessionReference is passed to the local session controller. The native ModuleLoader still builds and loads the normal plugin graph; Connections does not alter that graph in the browser.

The local sidebar uses public workspace and session controllers through the Connections owner RPC. Catalog reads include native cold session summaries and do not resume every listed Agent. Rename, pin, archive and workspace removal go back to the owning Host. The custom list implements these common actions; native third-party sidebar row contributions, drag ordering, full-history search and fork actions are not yet composed into this list. The native conversation and file surfaces remain native.

## Navigation transport

The owner-only `/api/connections/workspaces` endpoint handles bounded catalog operations and ephemeral view channels. The local Host resolves a saved connection to its current owned tunnel, exchanges native authentication and keeps the resulting HTTP cookie in memory. It never proxies arbitrary URLs. Destination edits, disconnect and plugin unload invalidate the transport generation and cancel outstanding requests.

Opening content creates a random view channel. Its fragment identifier is passed to the remote document; it carries no launch credential or executable instruction. The parent sends a typed navigation intent through its authenticated local RPC. The child polls its same-origin endpoint and invokes native navigation, including native `startSession` for new chats. It reports presentation readiness separately from the completed selection: a mounted directory picker is ready to interact with before a directory is chosen. Revisions reject stale reports; request IDs make navigation delivery idempotent. Channels have expiry, capacity limits and explicit disposal. The HTTP rendezvous does not depend on a desktop messaging protocol; enabling desktop still requires safe native command routing.

Prompts, logs, tools, uploads and approval responses use the original remote Harness transport. The bridge does not mirror or replay them. Closing a view expires that presentation channel, not the native session or remote service.

## References and choices

The [Codex source review](codex-reference.md) informed source ownership and the separation between transport and session lifetime. Public Codex code covers app-server/TUI behavior; its desktop Projects implementation is not part of that repository.

[Golden-Pigeon/dsh-remote](https://github.com/Golden-Pigeon/dsh-remote/tree/30554c99d25688134afce8c87929ffa9cffef8a1) already integrates remote work into the native sidebar. It creates local Workspace/Session mirrors and an Agent facade, then coordinates log projections, approvals, files and terminal routing. It also intercepts native navigation and DOM events. Connections borrows the source-labelled navigation idea, while keeping all remote session state and content execution at its original Host. This keeps the integration focused on connections and avoids maintaining a second session projection.

[flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) provides file mirroring and a full native Web attachment flow. [blank-dsh-remote](https://github.com/Blank-not-black/dsh-Remote) is a separate remote access application. Neither is a dependency of this plugin. No reference source is vendored.

## Verification and limits

Run the isolated two-Host acceptance fixture described in [Development](development.md). Verify one visible Workspaces list, destination-owned mutations, native directory selection and files, selection restoration, duplicate IDs on different sources, stale responses and independent disconnection. Mock browser tests alone are insufficient evidence of native integration.

The current controller platform verified in this repository is Linux. Web requires the browser on the local Harness machine through HTTP localhost/127.0.0.1. Web commands are matched against accepted native key bindings: search/add reach the new sidebar, new session follows its source, and parent archive/fork cannot affect a hidden local session. Native desktop opening is currently disabled because native menu accelerators cannot yet follow the selected source. Managed remote service requirements and existing-service installation instructions are in [Usage](usage.md).

A native persistent-host and multi-source UI API could later replace this adapter. Pairing and computer input remain separate future capabilities; see [Roadmap](roadmap.md).
