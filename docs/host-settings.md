# Settings, models and plugins by Host

Each connection targets an independently configured Harness Host. The
**Host** button beside the native **Settings** title opens a menu for **This computer**
and saved remote connections. The menu marks the selected Host and shows connection
status; the button's tooltip identifies the current Host. Choosing one opens that Host's native Settings,
including its Models page and the settings sections contributed by its own
plugins. It does not change the selected workspace, move a session, or stop work.
Local and remote use the same native title/menu placement and a single Settings
dialog, without an additional outer settings window or explanatory toolbar.
Ownership follows the destination Host's native homes/profile, not the saved
connection name: two connections to the same Host see the same configuration.

## Ownership

| Resource | Local Host | Remote Host |
| --- | --- | --- |
| Model providers, API endpoints, model lists and defaults | Local native settings | Remote native settings |
| API keys, subscriptions and account sign-in | Local credential provider | Remote credential provider |
| Model requests, network/proxy access and provider billing | Issued by local sessions | Issued by remote sessions using remote credentials |
| Host plugins, tools, permissions and plugin configuration | Local profile and process | Remote profile and process |
| Client plugins and plugin settings pages | Loaded from the local Host | Loaded from the remote Host into its document |
| Sessions, workspaces, attachments and files | Local native stores/filesystem | Remote native stores/filesystem |
| Saved SSH connections and the unified sidebar | Owned by Connections on the local Host | Not copied to the remote content bundle |

The remote does **not** inherit the plugins currently installed locally. Managed
setup installs the supported native Harness Web profile and the matching
Connections content bundle. Other plugins must be installed separately into the
remote Host's active profile. An existing-service connection keeps the profile
and plugin installation the operator chose for that service.

A provider plugin installed only locally does not make its model available to a
remote session. Install its compatible version on the remote and configure its
account there. The same applies to tools such as draw.io: installation and any
required external service access must be available to the Host executing them.
A plugin which adds only local sidebar UI does not automatically appear inside
the remote conversation or the unified workspace list.

## Models and credentials

Open Settings, choose the computer, then use its native Models/account pages.
A new unconfigured Host may first show Harness's own onboarding flow. Native
forms retain their normal validation, concurrent-write protection and credential
storage; Connections does not read or copy model secrets. Any plugin-contributed
provider page belongs to the document that loaded that plugin.

Local and remote may be configured with the same provider or API endpoint, but
this is an explicit configuration on each Host, not a shared live setting. There
is currently no automatic credential synchronization or local inference proxy.
The remote continues to use its own provider after the local application exits.
A future shared gateway would need a separate explicit configuration and would
make the remote depend on that gateway's availability; it is not implicit in SSH.

## Installing and managing remote plugins

The native Settings inventory shows the selected Host's plugins. Controls and
editable sections depend on that Host's installed native/plugin UI; Connections
does not turn the native read-only inventory into a package installer. Install
third-party packages through Harness's native CLI on the remote computer, using
that service's **same `DSH_HOME`, `DSH_AGENTS_HOME`, runtime and profile**. For a
managed connection those homes are:

```text
~/.local/share/dsh-connections/home
~/.local/share/dsh-connections/agents
profile: web
```

The managed release is selected through
`~/.local/share/dsh-connections/current`; its Node runtime is recorded in the
private `owner.json`. Using an unrelated `dsh plugin add` without these homes
would modify the remote user's default installation instead of this service.
Follow the native CLI's activation/restart requirement, after allowing running
tasks to finish. Do not run manual package/configuration changes during a
Connections-managed Harness update.

Installed third-party packages and native configuration remain in the managed
home across ordinary disconnects and reconnects. Connections only reconciles its
own remote content bundle. A Harness update can change third-party compatibility;
it does not copy local packages or independently upgrade other remote plugins.

## Isolation and limits

Each remote Settings view uses a separate native document, native transport
and view lease from its workspace view. Both views of the same remote Host share
its origin, cookies and browser storage; that origin is distinct from the local
Host's origin. Switching between local and remote Settings never redirects a
local settings form or a local plugin's RPC to
another Host. Closing Settings closes only that view, not the SSH connection or
remote Host. API secrets are not included in catalogs, selection preferences or
connection status.

The embedded title menu receives only connection IDs, display names and status
through a view-scoped browser message channel. The local parent validates the
current iframe, origin and view lease, and retains all connection operations.
Changing or closing the view revokes that channel; no local credentials or RPC
service are exposed to the remote document.

Remote Settings uses the same supported HTTP localhost/127.0.0.1 browser surface
as remote workspaces. A missing or incompatible content bundle produces an
explicit update instruction. Settings defaults to local on each opening; the
computer chosen for a conversation does not silently change where settings are
written. The local `Connections` section manages the list of SSH connections;
the remote content-only bundle does not recursively install a Connections manager.
