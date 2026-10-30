# Performance and remaining costs

The 2026-10-30 review's C6 scheduling issue is addressed in Connections 0.1.7.
That correction reduces duplicate work and bounds resource use; it does not
establish a measured CPU, memory or responsiveness improvement.

## Scheduling and request bounds

Workspace and Settings share one visible-page timer, with a nominal 2.5-second
interval and ±10% jitter. Each subscriber allows only one in-flight task, so a
slow workspace catalog does not stall Settings. Concurrent connection-list
reads share one RPC; mutations invalidate that pending sample. View checks also
share their in-flight operation.

The timer stops scheduling automatic refreshes when its document is hidden and
samples again when visible. Already running requests can finish. Explicit
navigation, mutations and forced refreshes may request fresh data independently.

| Work | Current behavior |
| --- | --- |
| Catalog for the selected Host | Eligible for automatic refresh 5 seconds after its previous read completes. |
| Catalog for another Host | Eligible after 30 seconds. |
| Failed catalog read | Nominal backoff of 10, 20, 40, 80, then 120 seconds, with ±20% jitter. Success resets it. |
| Concurrent catalog reads | At most three; source results publish independently. |
| Automatic SSH connections | At most four, from the startup snapshot. |
| Remote HTTP connections | Owned keepalive pool: at most eight total sockets, including at most two idle; destroyed with its transport. |
| Presentation readiness | A temporary 1-second check ends after presentation acknowledgement or its deadline. |

Catalog eligibility is sampled by the shared timer, so it is not an exact
network-request interval. Request duration and available workers also affect it.

Changed catalogs use pages below 256 KiB. Unchanged revisions omit the catalog
payload, and the client retains the previous catalog identity. Historical
snapshots use sliding expiry and an LRU bounded by eight revisions and 64 MiB;
the current catalog is retained even if it alone exceeds that byte budget.

The sidebar initially mounts approximately 100 rows and adds 100 on request.
The selected row and its parent remain reachable beyond the current page.
Collapsed workspace children are not mounted. Filtering and search still
examine the complete received catalog, rather than just the mounted rows.

## Costs still present

The review's P1-7 content boundary remains: a remote view runs a separate native
Harness document, with its own client tree, resources and browser behavior.
Focus, shortcuts, IME and notifications therefore retain document boundaries.
This is not a single client connected to multiple Hosts.

An open view also retains its browser-action and presentation bridges. Parent
surface synchronization has a nominal 500 ms delay between exchanges; the child
samples its surface snapshot at 1-second intervals. These loops run until the
lease is disposed and have no document-visibility pause. They are separate from
the shared Workspace/Settings timer and temporary readiness check above.
Completed browser actions retain at most 512 IDs per lease. Further unknown
actions are refused rather than evicting completed IDs and risking replay.

An unchanged catalog response saves transfer bytes but does not eliminate the
server's full scan. The endpoint still lists native sessions, builds the catalog
and serializes it for its revision hash before deciding it is unchanged.
Pagination bounds individual responses; it does not make that work constant
time. Complete client-side search and filtering also still scale with catalog
size, despite bounded mounted rows.

Catalogs remain snapshots. Native approval, question, progress and notification
events are not forwarded into a local control plane. Replacing polling with
those events would require a separately designed authenticated subscription and
lifecycle contract; it is not part of the C6 correction.

## Verification and profiling

The following five focused Node test files passed on 2026-10-30 under Node
26.5.0, with no failures:

```sh
node --import tsx --test \
  test/connection-polling.test.ts \
  test/client-rpc.test.ts \
  test/workspace-catalog.test.ts \
  test/workspace-browser-view-model.test.ts \
  test/view-surface.test.ts
```

They verify hidden-page scheduling, independent subscribers, cleanup, concurrent
read coalescing and invalidation, plus bounded rendering and complete search of
a 20,000-session catalog. They verify behavior and resource bounds, not a
before/after performance benchmark.

A useful future profile would count RPCs and bytes by operation during visible
idle, hidden, remote-workspace and remote-Settings states, while sampling Host
and renderer CPU and heap. Separate unchanged-catalog measurements at increasing
session counts would quantify the remaining full scan and hash. No such
measurements or measured speedup are claimed here.
