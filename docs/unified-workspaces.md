# Unified Workspaces

Connections supplies one local navigation surface for workspaces owned by different Harness Hosts. Local runtime admission remains exact `0.2.1-rc.5`, with reviewed remote rc.2/rc.3/rc.5 content. No Harness source fork is required. Remaining capabilities are listed in the [roadmap](roadmap.md).

## Interaction

The existing sidebar contains local and connected remote workspaces together. Remote rows show a quiet computer name and connection status. A row's identity combines the saved connection ID with its native workspace or session ID. Local is the reserved source `local`.

Selecting a session changes the central content through its owning Host's native navigation. Source-labelled list actions and the New Session keyboard command follow the selected source. The independently deployed native brand/New Session button retains local semantics and returns to this computer; Connections does not replace its injected service. Remote content and files remain native documents in the main area. Selecting a local row closes only the remote view, leaving its Host and tasks running.

Add workspace selects the computer and then delegates to that computer's native directory flow. Connection configuration stays in Settings → Connections. The plugin does not create local workspace placeholders for remote paths or copy remote sessions and logs into local storage. Catalogs are temporary presentation data; the only saved UI preference is a source-qualified selection. Previously fetched remote rows remain available during a disconnect in the current client lifetime.

The remote bundle disables the native auto chooser and composes Harness's existing browser directory backend and UI together. This keeps remote directory selection in the browser, including on servers with a desktop display. The local profile retains its native picker choice.

Opening remote content keeps a visible loading state until the delegated native picker mounts or native navigation confirms the selected session. The presentation stage times out after 30 visible seconds without that acknowledgement (hidden time pauses its budget), with controls to retry the operation or cancel back to this computer. Explicit navigation and New Session supersede pending startup restoration; passive native local-session restoration does not clear the saved remote choice.

## Native composition

The local patch leaves the native sidebar deployed. Connections only shadows sidebar.workspaces through the public slot with priority -1; a competing negative-priority provider causes withdrawal instead of silently taking ownership. Native brand, rail, menus, child declarations, services and tracker remain unchanged. The header/list aliases and subscriptions are owned effects and are withdrawn on failure or unload.

No native sidebar factory or copied CSS is built into Connections. A client factory/import failure, entry disable or whole-bundle disable cannot remove that independently owned shell. The unavoidable tradeoff is the native brand's local New Session semantics. Existing shortcut interception is separately checked and reversible; a failed contract withdraws only remote routing.

The managed remote Host installs a separately built content bundle with its own explicit compatibility list. Its patch disables native `ui-layout` and `ui-settings`, keeps the native Account deployment, and enables Connections with `embedded: true`. Connections supplies the public `ILayout` contract and declares the native main, rightbar, bottom and overlay slots. Conversation, files and the plugin manager keep their native components without a second visible sidebar. A separate settings view reuses the remote native settings shell when selected from the local Settings header.

Remote bootstrap obtains the surrounding application's presentation preferences
before native consumers activate. A checked Settings constructor projects those
preferences; execution forms and Account remain destination-owned. See
[compatibility](harness-compatibility.md) for adapter checks and
[settings ownership](host-settings.md) for the preference boundary.

Web renders that content in a same-site loopback iframe. Desktop renders through Harness's existing isolated guest lease API. A checked, reversible resolver adapter on the existing native shortcut service resolves workspace command ownership before dispatch; Connections does not replace that service or its configuration. Separate documents preserve native session binding, media and upload origins, keyboard handlers, approvals and scoped file capabilities. No remote SessionReference is passed to the local session controller. The native ModuleLoader still builds and loads the normal plugin graph; Connections does not alter that graph in the browser.

The local sidebar uses public workspace and session controllers through the Connections owner RPC. Catalog reads include native cold session summaries and do not resume every listed Agent. Rename, pin, archive and workspace removal go back to the owning Host. The custom list implements these common actions; native third-party sidebar row contributions, drag ordering, full-history search and fork actions are not yet composed into this list. The native conversation and file surfaces remain native.

The source-aware list adds copy-session-ID, source-qualified roving focus and visible-row arrow/Home/End navigation, without treating an idle session as completed or claiming server-wide search. Its `Menu`, `Tooltip`, state dots, relative time and icons are Connections-owned controls using inspected theme tokens, with no Harness Client runtime imports. Its own layout follows the native workspace and session rows: open/closed folders, active-folder color, trailing time and pin, and no extra indentation between a workspace and its sessions. Theme tokens supply colors and radii. Owned popover menus retain keyboard navigation, dismissal and focus return, and yield to foreground native dialogs. This is a small source-aware View, not the original workspace row implementation.

The original workspace browser is not a portable renderer: its hooks and row actions bind the local session/workspace controllers, and its row components are not exported by the runtime package. Feeding it remote IDs would misroute actions or require a second session mirror. Extracting private row functions from the compiled bundle would also depend on internal types, slots and CSS. Connections therefore owns its small presentation controls and keeps this View replaceable if upstream exposes a source-independent renderer. The [upstream workspace contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/README.md) documents those Host-bound contributions.

## Workspace list responsibilities

- **Model:** `workspace-controller.ts` and the validated Host catalogs own transport, navigation and mutations. The native Host remains the source of truth; successful edits are refreshed through that controller.
- **ViewModel:** `workspace-browser-view-model.ts` derives the list using `workspace-catalog.ts` and owns query, filters, collapse preferences, bounded pagination, edit/confirmation targets, pending operations and errors. Every command resolves a source-qualified target against the current model. Duplicate operations on one row are suppressed; old completions cannot close a newer editor or update an unmounted view. Searching temporarily expands matches and restores the previous collapse choices when cleared.
- **View:** `WorkspaceBrowser.tsx` renders rows and binds commands. Input drafts, focus and owned menu visibility stay with their components. `workspace-browser.css.ts` holds the small layout contract; the dictionary is separate. One clock updates relative labels for the visible list, using the same reviewed time buckets without importing a native module.

The catalog currently provides `running` and `updatedAt`, so the list displays those authoritative values. An idle session is not assumed to be completed. Pending approval/question, completion badges, subagent aggregation and third-party row slots require an explicit source-aware Host contract before they can be shown safely.

Local runtime admission still targets exactly Harness rc.5 for the private shortcut and remote factory contracts. The native sidebar itself is no longer a derivation input. Upgrades require contract review and native acceptance before broadening admission. Factory/RPC/slot failures leave the native shell available; a conflicting workspace provider remains mounted and remote opening is disabled rather than routing source-qualified commands through another provider.

## Navigation transport

The owner-only `/api/connections/workspaces` endpoint handles bounded catalog operations and ephemeral view channels. The local Host resolves a saved connection to its current owned tunnel, exchanges native authentication and keeps the resulting HTTP cookie in memory. It never proxies arbitrary URLs. Destination edits, disconnect and plugin unload invalidate the transport generation and cancel outstanding requests.

Catalog and open-view requests negotiate protocol version 3 in both directions; current openView also negotiates required plugin-owned content contracts before credential URL access/navigation. Unsupported or missing versions produce an explicit compatibility error. Catalogs use content revisions and bounded pages (including split workspace membership), and the client publishes a new catalog only after every page has arrived. Unchanged revisions do not retransmit rows. Reads pause while the browser is hidden, use three concurrent source reads at most, refresh the selected source more often, and back off with jitter after failures. These changes reduce network traffic; native Host enumeration remains a snapshot read rather than a second event stream.

Explicit Reconnect creates a new transport generation, re-runs managed preparation and authentication, and replaces the old tunnel. Open probes the Host; network/authentication failures invalidate a stale runtime while protocol or application errors preserve it. Background HTTP read errors preserve a live SSH tunnel and appear as catalog errors rather than connection failures. Authentication rejection allows one renewed exchange and retry. A public opaque transport identity invalidates old iframe reuse even when a replacement tunnel gets the same port. Editing name or auto-connect alone preserves the tunnel. Pending reads and navigation cannot restore an older generation.

Opening content creates a random view channel. Its fragment identifier is passed to the remote document; it carries no launch credential or executable instruction. The parent sends a typed navigation intent through its authenticated local RPC. The child polls its same-origin endpoint and invokes native navigation, including native `startSession` for new chats. It reports presentation readiness separately from the completed selection: a mounted directory picker is ready to interact with before a directory is chosen. Revisions reject stale reports; request IDs make navigation delivery idempotent. Channels have expiry, capacity limits and explicit disposal. A per-tab, per-surface client identity rotates the old server channel on reload; copied active tab storage receives a new identity. Settings and workspace channels are independent. Active catalog page reads renew snapshot expiry; historical snapshots use bounded LRU retention (up to eight revisions and 64 MiB, keeping the current revision), with one clean retry after eviction. The HTTP rendezvous works in browser frames and Desktop guests. Desktop Settings also uses its settings navigation revision to exchange the host-menu metadata and a single validated host selection.

Prompts, logs, tools, uploads and approval responses use the original remote Harness transport. The bridge does not mirror or replay them. Closing a view expires that presentation channel, not the native session or remote service.

## Verification and limits

Run the isolated two-Host acceptance fixture described in [Development](development.md). Verify one visible Workspaces list, destination-owned mutations, native directory selection and files, selection restoration, duplicate IDs on different sources, stale responses and independent disconnection. Mock browser tests alone are insufficient evidence of native integration.

Linux uses native OpenSSH ControlMaster; Windows Desktop uses native OpenSSH stdio forwarding. Web requires the browser on the local Harness machine through HTTP localhost/127.0.0.1. The native shortcut service retains accepted keybindings on both surfaces: the resolver adapter sends search/add to the unified sidebar, New Session to its source, and Close to the selected remote surface. Session/pane commands without safe remote delegation show guidance to use remote controls and cannot affect a hidden local session. If the checked registry contract is unavailable, remote views close or cannot open; native local commands remain available. Managed remote service requirements and existing-service installation instructions are in [Usage](usage.md).

A native persistent-host and multi-source UI API could later replace this adapter. Pairing and computer input remain separate future capabilities; see [Roadmap](roadmap.md).
