# Harness compatibility

Reviewed against the published rc.2 and rc.3 packages on 2026-10-28. Connections
0.1.2 targets local Harness `0.2.1-rc.3`; 0.1.0 remains available for local rc.2.
The separate remote content archive supports both explicitly tested versions.

## Desktop sidebar stylesheet ownership

Connections 0.1.2 fixes missing native sidebar styling on Desktop. The rc.3
Desktop and npm sidebar builds use different generated CSS class names but the
same stylesheet IDs. Reusing the npm factory with those IDs could skip its CSS
when Desktop had already loaded its own copy. The native loader could also remove
the copied styles when retiring the disabled original sidebar.

The build adapter now assigns both the stylesheet owner and deduplication IDs to
Connections. Native CSS, class names and components remain unchanged. Harness
therefore inventories, reloads and removes these styles with Connections, while
the original sidebar can be restored independently. A changed upstream ownership
format fails the build instead of silently producing an unstyled shell.

Regression coverage includes the actual Harness module-loader replacement and
reload lifecycle, plus computed native button styles and panel layout with a
preloaded Desktop-style collision. This browser coverage does not run Electron.
The fixed build was additionally checked in the installed Windows Desktop rc.3
application with isolated Harness and Electron data directories: native styling,
More menu, New Session draft preservation, Connections Settings and renderer
reload passed. See [development acceptance boundaries](development.md).

## What rc.3 changes

| Native change | Effect on Connections |
| --- | --- |
| `ui-sidebar` declares `sidebar.panellist.actions` | The original sidebar can render official and third-party More menu rows without a second menu implementation. |
| The sidebar supplies `entries`, `onOpen`, `onPinnedChange` and `onDismiss` | The native sidebar owns panel selection, temporary pin state and menu dismissal. Connections preserves these capabilities and their lifecycle. |
| `uiWorkspace.startSession` now resolves the workspace's reusable blank | Repeated New Session can preserve the current session ID and unsent draft. A different ID is no longer evidence required for successful navigation. |
| Blank resolution handles preset eligibility, archived sessions and pending requests | Reuse decisions remain on the destination's native navigation and session services; Connections must not choose or copy a blank from its catalog. |

The rc.3 default `ui-entry-customization` sidebar menu currently provides plugin
browsing and creation. The pin callback is an extension capability; it does not
mean the default sidebar menu already exposes a full pin editor. Its plugin
creation action supplies the `cordis` preset and appends a prompt through its own
Host's `uiWorkspace`. Connections does not rewrite that action into a generic
remote New Session request or discard its preset/draft options.

## Changes adopted

- Build the native sidebar factory and typecheck against rc.3, with matching
  credential and Typert peers. Preserve the new child slot and original menu
  registrations, callbacks and in-memory state.
- Keep the selected remote row while an unqualified New Session request is in
  flight on the same Host. Retain the native document and replace the selection
  only after its acknowledged result, whether it reused a blank or created one.
  Explicit navigation to another workspace or Host still changes the target.
- Continue invoking native `startSession`; do not reproduce blank selection,
  preset fallback, draft merging or creation failure notices in Connections.
- Verify real local and remote rc.3 drafts survive New Session, session catalogs
  do not gain duplicate blanks, and session requests reach only the selected
  Host. Keep native panel-menu and contribution-lifetime regression coverage.
- Gate publication on installation and browser acceptance of the exact checked
  tarball in the declared local runtime, without version exemptions.

## What these APIs do not replace

The More slot contains global panel actions, not workspace/session data sources,
Host selection or a source-aware New Session callback. Adding a Connections
panel there would duplicate Settings and would not make native navigation target
a remote Host. Settings therefore retains its existing Host selector.

The rc.3 sidebar still closes over its own `uiWorkspace` service when installing
its injected New Session callback. The public slot registry exposes registration
and disposal, not mutation of another registrant's injected callbacks. Connections
therefore retains the small isolated native-sidebar composition. Other plugins
keep their native service; no global navigation replacement or DOM interception
is introduced. The native workspace browser still reads one Host's workspace and
session services, so the source-aware list remains necessary as well.

The remote adapter still waits for completed native navigation, including a
same-session result. `startSession` returns `void`; calling `connectWorkspace`
alone would skip native selection, draft handling and failure presentation. The
existing presentation acknowledgement cannot be removed merely because rc.3 can
reuse a blank. The remote rc.2 runtime also retains its own native semantics.

Future simplification should follow a public source-aware navigation hook and a
multi-Host workspace data contract, or an awaitable native navigation result.
Those would let Connections remove adapters without recreating session policy.
