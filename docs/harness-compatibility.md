# Harness compatibility

Connections 0.1.8 targets local Harness `0.2.1-rc.5`. Remote content explicitly
admits `0.2.1-rc.2`, `0.2.1-rc.3` and `0.2.1-rc.5`. The local engine remains
exact: use Connections 0.1.7 for local rc.3, or 0.1.0 for local rc.2.
Published 0.1.7 is rejected by Harness rc.5's native compatibility evaluator;
its engine restriction was not widened retroactively.

## rc.5 contract review

On 2026-10-30, all published `lib/*.js`, `*.d.ts` and `*.json` inputs of the
29 direct Harness development dependencies were compared with rc.3. They match
after normalizing their release labels, except the sidebar build badge and
client module server commit identifiers. The Settings, Account, shortcut
registry, workspace/layout and Typert contracts used here did not change.
The rc.5 [release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5)
describe improved thinking-content display; this source comparison and native
acceptance, rather than the notes alone, determine admission.

All Harness development and peer inputs now target exact rc.5. The build also
checks separately installed rc.2/rc.3 Settings sources against rc.5 before
sharing the one retained ConfigForms constructor adapter. Account uses its
independently deployed native plugin and checked public slot injection, not a
copied factory. Native preference tests execute all three
matching Settings, locale and theme runtimes. A changed implementation fails
the build and needs a separate reviewed adapter. rc.4 and 0.2.2-alpha.2 remain
unadmitted; a compatible-looking neighboring version is not sufficient evidence.

Existing remote Hosts retain their version. Explicit Update defaults to the
latest admitted rc.5; new managed installations retain the original rc.2
baseline. This admission does not silently migrate existing services.

The remaining Settings constructor and shortcut adapters still require exact
tested inputs. `dist/native-inputs.json` records their versions, SHA-512 digests
and boundary inventory; `NOTICE` describes the adapted Settings bootstrap and
owned control behavior with their licenses. Both browser artifacts reject all
Harness Client runtime module imports; native Service/Slot type contracts remain
development inputs. Build checks also verify the native
Models, permission and session-log slot identities used by the remote settings
adapter. Broadening the engine range requires reviewing these contracts and
running native acceptance for each admitted version.

The local rc.5 navigation observer waits for the published first-main binding,
not a private `UiWorkspaceService` field: automatic native blank restoration
also calls `beginNavigation`. Saved remote restoration loads catalogs in parallel
but waits to commit its panel until that binding or a ready empty workspace
baseline, with a 30-second fallback for stalled native startup. That fallback
is not proof of native startup completion. Trusted local input cancels only an
unexpanded cold automatic restore; its temporary listeners neither intercept nor
reroute native input and are removed on completion/unload. Regression tests
execute the published native implementation for both completion orders and
blank reuse.

Connections 0.1.3 separates workspace presentation and interaction state using
MVVM, aligns its list with native icons and spacing, and fixes catalog snapshot
and asynchronous action handling. It retains the 0.1.2 stylesheet ownership fix.
See [workspace list responsibilities](unified-workspaces.md#workspace-list-responsibilities).

## Version policy and automatic admission

The intended policy is a minimum supported version and an explicit compatibility
boundary, with narrowly excluded releases that have demonstrated a regression.
The latest stable release within that contract should be installable without a
new Connections release. The build input version, installed-version admission
and CI's actually tested versions are separate facts; a passing matrix should
not itself become an installation allowlist.

The current source now completes the fail-open prerequisite: its local patch no longer disables the native sidebar, and no copied native factory/Proxy is deployed. Import/factory/entry failures leave native navigation independently available. Source-aware keyboard/list New Session remains; the native brand button deliberately stays local.

This is necessary, not sufficient, for broader admission. The private shortcut registry, remaining Settings constructor and Account slot-injection contracts still need reviewed inputs. A bare `>=` would promise future prerelease/private APIs that this plugin cannot verify. The exact local rc.5 gate is retained.

The [contract inventory](<../dist/contracts.json>) and openView handshake now check the required plugin-owned workspace/surface/settings/account revisions before enabling remote content. Failure preserves native navigation, basic connection management and an update remedy. This is not a public platform capability negotiation: build inputs remain pinned, the remaining Settings constructor is still reviewed per runtime, and automatic admission of an unchanged future rc.6 remains outstanding. A public source-aware navigation/module/provider seam would remove more private adapters.

Harness's current evaluator uses semver with `includePrerelease: true`. A lower
bound alone also admits future alpha releases and incompatible major versions.
A future range must therefore state its contract boundary and channel policy;
“not yet tested” and “known incompatible” should remain distinct. Remote
maintenance must additionally resolve a compatible version explicitly, verify
its protocol/capabilities and avoid automatically upgrading a running Host.

## Desktop remote content and commands

Connections uses the native Desktop guest lease API for remote workspaces and
Settings. In 0.1.6, the Connections settings page recognizes that same capability;
0.1.5 incorrectly applied the browser's HTTP-loopback requirement to Desktop and
disabled Add. A supported version-1 bridge must provide guest acquisition,
release and popup subscription. Merely opening an arbitrary custom-protocol URL
does not enable Desktop support. Ordinary browsers still require HTTP localhost
or 127.0.0.1 on the local Harness computer.

Version 0.1.6 retains the running native `ShortcutsService`, its provider and
Host configuration. A version-checked adapter wraps only content-namespace and settings.open command
resolvers in the tested private `registry.commands` map. Unrelated application
and third-party commands, including immutable objects, stay outside that seam. Native code retains
keybindings, conflicts, revisions, repeat handling, keyboard/menu dispatch and
disposal. The adapter follows command registration changes and restores its own
wrappers when disposed. The command guard lives with the view controller,
independent of sidebar component mounting.

New Session, search, add workspace and Close route to the selected surface.
Commands without a safe remote delegation show guidance to use remote controls;
they do not operate on the local session behind the remote view. Build-time
source checks and runtime registry/ownership checks bound this private adapter
to the reviewed rc.5 contract. If it cannot attach safely, remote views close or
cannot open; the native local shortcut service remains available. A future
public command-resolver hook would let Connections remove this private adapter.

The remote bundle retains one version-checked Settings bootstrap. It extends the
ConfigForms accessor for five local UI preference namespaces and explicitly
injects an owned snapshot-store dependency; native schemas, describe mirror and
execution-setting write queues remain intact. Account keeps its native provider,
components and CSS. Public slot delegation adapts only its sign-in presentation
and browser open/copy operations, leaving native account state, credentials and
authorization attempts on the destination Host.

Removing the remaining constructor requires a real upstream pre-consumer form
projection seam. Runtime method wrapping cannot notify consumers that already
cached the original subscription, and Host Loader isolation is not carried into
the Client boot graph. Connections does not invent a mirror revision, globally
replace those native consumers, or claim these mechanisms are public middleware.
The rc.2/rc.3/rc.5 Settings inputs are still compared before sharing this adapter;
a changed implementation fails the build and needs review.

### Updating an open rc.3 Desktop

Installing and first enabling 0.1.5 can leave an already open rc.3 frontend
blank; it does not require an upgrade from an earlier Connections release.
This was reproduced in an isolated Windows Desktop profile. The Desktop and
Host processes remained alive while the renderer failed. The native module
loader's `ClientEntries.replace` tears down the shortcut provider before
activating its replacement, temporarily removing the dependent layout's `root` slot.
The native renderer's `RootOutlet` throws `SlotAssemblyError` for that gap; its
error boundary rethrows assembly errors, so restored services do not remount the
React tree. These behaviors are present in the published rc.3
`@deepseek-ai/dsh-client-modules` and `@deepseek-ai/dsh-client-ui-renderer`
client bundles. Version 0.1.6 removes Connections' shortcut-provider replacement;
the native provider and its dependent layout keep their lifetime when the new
adapter attaches or detaches.

An upgrade from 0.1.5 still has to retire that release's old replacement provider.
It may therefore require one renderer reload after installation; the new
adapter cannot guarantee uninterrupted removal of an already active old
provider. Save any unsent drafts before migrating. If the frontend becomes
blank, reload it after installation finishes; this failure does not require
restarting the local or remote Host. Connections does not reload automatically
or take ownership of the native React root. Broader resilience to another
plugin replacing a root dependency remains an upstream renderer concern.

Shortcut configuration now belongs to the native `shortcuts` deployment. If a
previous version required moving `stopSequenceMs` into the Connections entry's
`shortcuts` field, restore that override to the native deployment when upgrading.
The adapter does not migrate or duplicate native configuration.

## Historical sidebar adapter (released 0.1.2–0.1.8)

The following describes the previously released implementation. The current source removes that adapter entirely and keeps native stylesheet/provider identity unchanged; it ships no copied-sidebar license or factory. Entry/bundle disable no longer requires native sidebar restoration. Save drafts when upgrading an old active patch; a running loader may still need one refresh to retire the old composition.

### Desktop stylesheet ownership in that historical adapter

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

## Historical rc.3 changes adopted

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
