# Settings, models and plugins by Host

Each connection targets an independently configured Harness Host. The
**Host** button beside the native **Settings** title opens a menu for **This computer**
and saved remote connections. The menu marks the selected Host and shows connection
status; the button's tooltip identifies the current Host. Choosing a remote opens
its native **Models** page and the settings sections contributed by its own
plugins. **General** belongs to the application on this computer: choosing it
from remote Settings returns to the local native General page. It does not
change the selected workspace, move a session, or stop work.
Local and remote use the same native title/menu placement and a single Settings
dialog, without an additional outer settings window or explanatory toolbar.
Ownership follows the destination Host's native homes/profile, not the saved
connection name: two connections to the same Host see the same configuration.

## Ownership

| Resource | Local Host | Remote Host |
| --- | --- | --- |
| Language, theme, fonts and native conversation display/input preferences | Configured in local General | Uses the surrounding application's preferences; remote saved values are unchanged |
| Model providers, API endpoints, model lists and defaults | Local native settings | Remote native settings |
| API keys, subscriptions and account sign-in | Local credential provider | Remote credential provider |
| Model requests, network/proxy access and provider billing | Issued by local sessions | Issued by remote sessions using remote credentials |
| Host plugins, tools, permissions and plugin configuration | Local profile and process | Remote profile and process |
| Client plugins and plugin settings pages | Loaded from the local Host | Loaded from the remote Host into its document |
| Sessions, workspaces, attachments and files | Local native stores/filesystem | Remote native stores/filesystem |
| Saved SSH connections and the unified sidebar | Owned by Connections on the local Host | Not copied to the remote content bundle |

Changing the Settings Host does not change the application's language or theme.
Remote content also follows local work-detail visibility, automatic collapse,
performance/usage detail, link-opening preference, busy-Enter behavior and
developer-tools visibility. These preferences are read without saving them in
the remote Host's configuration. Desktop shortcuts remain owned by the local
native shortcut service.

Model/provider configuration and execution policy continue to belong to the
computer running the session. The remote **Permissions and privacy** section
reuses Harness's original default-permission and Session Log upload controls;
switching to local General does not copy these choices between computers. A
remote control appears only when its native feature is available on that Host.

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

The native Settings inventory shows the selected Host's built-in plugins and
plugin settings. To install or manage packages, open **Settings → Connections**,
connect the computer, then choose its **More actions → Manage plugins**. This
opens that remote Host's original Plugin Manager in the main content area; its
search, installation, removal and activation actions run on that Host. Connections
does not duplicate the package manager. If the remote profile has no native
Plugin Manager, the view explains that it must be enabled there.

The native CLI remains available for administration. Run it on the remote computer
with that service's **same `DSH_HOME`, `DSH_AGENTS_HOME`, runtime and profile**. For
a managed connection those homes are:

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
its origin in a web browser, including cookies and browser storage. Desktop leases
use native isolated guest partitions. In either case the remote document is
separate from the local Host's origin. Switching between local and remote Settings never redirects a
local settings form or a local plugin's RPC to
another Host. Closing Settings closes only that view, not the SSH connection or
remote Host. API secrets are not included in catalogs, selection preferences or
connection status.

The embedded title menu receives only connection IDs, display names and status
through a view-scoped browser message channel on the web. The local parent validates
the current iframe, origin and view lease. Desktop guests exchange the same small
metadata through the authenticated remote view endpoint, bound to the current
Settings navigation revision; a host selection consumes that operation once.
Changing or closing the view revokes the capability. Local interface preferences
and the native sign-in dialog's open-link/copy-link requests use the authenticated
view endpoint too. They do not expose a general local command or RPC service.
The local parent retains connection operations and credentials; opening a remote
account's sign-in link on this computer still authenticates that remote account.

Remote Settings uses the same native Desktop guest or supported HTTP
localhost/127.0.0.1 browser surface as remote workspaces. A missing or incompatible content bundle produces an
explicit update instruction. Settings defaults to local on each opening; the
computer chosen for a conversation does not silently change where settings are
written. Choosing **This computer** returns to local General. The local
`Connections` section manages the list of SSH connections;
the remote content-only bundle does not recursively install a Connections manager.
