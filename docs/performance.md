# Performance and remaining costs

The 2026-10-30 source follow-up removes a sequential duplicate connection-list
read, pauses the view bridges while hidden, and replaces one whole-catalog
string allocation with bounded-array hash batches. These are specific measured
or regression-tested changes, not a claim that a multi-document remote client
has become a single lightweight renderer. See [review follow-up](<review-followup.md>).

## Scheduling and deterministic budgets

Workspace and Settings share one visible-page timer (nominal 2.5 seconds, ±10%
jitter). Each subscriber has its own in-flight guard, so a slow catalog does not
stall Settings. Concurrent connection-list reads coalesce; mutations invalidate
the sample. A catalog refresh now reuses its one list for its own view check.
Standalone navigation/checks still obtain fresh authority. Capturing the view
generation before that list prevents a slow catalog from checking a new lease
against old transport rows.

| Work | Current behavior / regression gate |
| --- | --- |
| One steady-state catalog refresh with ready view | One list + one viewState, not two sequential lists; separate concurrent tasks are not promised a single global read. |
| Selected Host catalog | Eligible 5 seconds after its previous read completes. |
| Other Host catalog | Eligible after 30 seconds. |
| Failed catalog | Nominal backoff 10/20/40/80/120 seconds, ±20% jitter. |
| Catalog source concurrency | At most three, publishing independently. |
| Automatic SSH connections | At most four; bounded SSH preflight queue remains separate. |
| Remote HTTP | Owned keepalive pool, at most eight total/two idle sockets; ends with transport. |
| Parent surface / child snapshot | Nominal 500 ms / 1 second delay after each exchange while visible; transient failures use capped backoff, default cap 30 seconds. |
| Embedded navigation / Desktop Settings relay | Hidden read/timer pause; visible first reconciles the same lease/revision, then reports/selects. |
| Presentation readiness | One-second checks with a 30-second **visible-time** deadline; hiding preserves remaining budget instead of resetting it. |
| Hidden bridge budget | Mock-clock 10-minute regressions assert no periodic bridge/watchdog RPC. An already running carrier can settle; cancellation may send one best-effort tombstone. |

This is **not** a promise that all native Harness traffic stops in the background.
Already-started system browser actions cannot be undone. Host action expiry
(30 seconds) and view lease expiry (30 minutes) use wall-clock time: long-hidden
expired operations fail explicitly, never silently acquire a new ID/lease and
replay a side effect. Completion tombstones are bounded at 512 per lease, not a
durable cross-renderer exactly-once store.

## Catalog and rendering costs

Changed catalogs remain below 256 KiB per page, including split workspace
membership. Unchanged revisions omit row payload; client identity remains the
same. Snapshot expiry/LRU remains eight revisions/64 MiB of history, retaining
the current snapshot even if it alone exceeds the budget. The unchanged path
already skipped pagination before this follow-up; that is not claimed as a new
optimization.

The revision hashes exactly the previous projected JSON bytes, including paths,
optional fields, membership, archive/pin state and all native array order.
Arrays are serialized in batches of at most 128 rows; a single large workspace
membership can still exceed the normal batch size. This avoids a complete
catalog-sized string but does **not** remove native enumeration/projection or
make unchanged reads O(1). There is no second session index or copied log store.

The sidebar initially mounts about 100 rows and adds 100 on request. Selection
and its parent remain reachable; collapsed children do not mount. Search still
examines the complete received directory, not server-wide history. Keyboard
navigation walks only currently mounted visible rows.

## Reproducible hash microbenchmark

```sh
node --expose-gc --import tsx scripts/benchmark-catalog.ts
```

One local run on 2026-10-30, Node v26.5.0, 5 warmups and 30 measured iterations:

| Sessions | Projected bytes | Whole JSON hash p50 / p95 ms | Batched hash p50 / p95 ms |
| --- | ---: | ---: | ---: |
| 1,000 | 130,513 | 0.750 / 0.987 | 0.738 / 1.348 |
| 20,000 | 2,731,713 | 20.401 / 28.281 | 12.669 / 13.700 |

The small-case p95 did not improve in this sample. The script emits GC-sensitive
heap deltas for investigation; they are not peak-heap measurements or a portable
memory budget. A per-row streaming prototype was measurably slower and was
replaced by batches before adoption. These numbers measure **projected hashing
only**, not native Host scan time, renderer CPU, network throughput, or navigation
latency, and should be rerun on the target platform.

A 2026-11-03 rerun with the same runtime, warmups and iteration counts measured
whole/batched p50–p95 of **0.775–0.989 / 0.891–1.230 ms** at 1,000 sessions and
**21.763–39.733 / 12.632–15.022 ms** at 20,000 sessions. The small case was slower
with batching; the larger hash-only case improved. This benchmark was not run
concurrently with the final native resource sample below.

## Agent tool prompt/output budget — 2026-10-31

The optional local Host tool is one combined `connections` action schema, with no additional system-prompt section. Its added first-turn schema contribution was measured with the installed DSH token-meter `estimateToolsTokens` fixed-density heuristic (rc.3): **0 → 829 estimated tokens**, one tool, **3,304 UTF-8 JSON bytes**. This compares this plugin's absent/present tool contribution, not the complete session prompt; it is not a provider tokenizer or billing count. No model request was submitted. The runtime tool authoring/registry contract is checked against the exact rc.5 SDK, not inferred from this estimator's version.

List/catalog responses default to 20 and cap at 50 rows; catalog paths cap at 1,024 characters with a truncation flag, and large workspace membership is a count. These bounds protect model context, not the cost of collecting the native catalog: each catalog action still consumes a complete immutable catalog through the existing paged protocol. There is no new session index, mirrored log or claimed O(1) server search. Mutations stay exclusive, because even a list can reconcile a stale transport or migrate credential keys.

## Dependency-convergence artifact sizes — 2026-11-01

Compared with the checked 2026-10-31 SSH-completion candidate, using the same
non-minified production build format:

| Artifact | Previous bytes | Current bytes |
| --- | ---: | ---: |
| Local Client JavaScript | 338,907 | 367,080 |
| Nested remote content archive (`dist/remote-plugin.tgz`) | 2,524,170 | 60,823 |

The local bundle grows because its controls/stores are now owned source instead
of imports of Harness Client runtime modules. The remote package no longer
contains the native Account factory, its embedded assets or copied CSS. Native
Account is still supplied by the destination Harness: this archive reduction is
**not** a measurement of total page downloads, renderer memory, CPU, first paint
or navigation p95. The retained Settings store updates only a shallow snapshot
and does not add a recursive equality scan of the complete settings document.
A 100-row browser regression checks one owned control stylesheet at the View
boundary rather than a complete duplicate per row.

## Native resource sampling — 2026-11-03

`scripts/profile-native.mjs` measures a disposable, initialized two-Host fixture.
It checks the recorded process start identities and installed artifact hashes,
then opens its own Chromium context. Run the native integration setup/suite first
as described in `test/integration/README.md`, and keep other test or benchmark
runs idle during sampling:

```sh
node scripts/profile-native.mjs /tmp/dsh-connections-unified-qa
```

Defaults are 15 seconds per steady state and 20 local-to-remote navigations.
`DSH_PROFILE_SAMPLE_MS` and `DSH_PROFILE_REPETITIONS` configure bounded alternatives.
The fixture's `performance.json` contains environment/build metadata, numeric
samples and at most 100 categorized HTTP failures. It excludes launch URLs,
cookies, request bodies and session content. An interrupted run retains its
partial samples with `complete: false`; successful-navigation percentiles must
not conceal a failed run.

CPU is the change in Linux process CPU time divided by wall time, expressed as
percent of one core. Renderer CPU/RSS groups all renderer processes of this test
browser; it is not the complete browser/GPU process tree. RSS maxima are sampled
approximately every 500 ms and may double-count shared pages. Main-target CDP
JS heap is recorded separately and is not total remote-frame or Host heap.
HTTP totals count bytes for requests completed during the sample; WebSocket
totals count payloads. Neither is a complete SSH/TLS wire-byte measurement.
Navigation timing is automated click-to-presented UI with warm caches, not INP.

The browser must report actual `document.visibilityState === 'hidden'` before a
hidden-state sample is admitted. The original run's headless Playwright session
kept both tabs visible, so no hidden sample was recorded. The later Desktop
check below identified default focus emulation as a visibility-test confound;
the original headless run has not been repeated with corrected instrumentation. No
synthetic visibility event or page freeze substitutes for a hidden resource
measurement. The existing mock-clock pause/resume regressions remain separate
behavioral evidence.

The final completed run used Linux, Node v26.5.0, Chromium 153.0.8010.12 and an
Intel Core i7-10700 (16 logical CPUs), with both rc.5 Hosts on this machine over
real loopback OpenSSH. The initial rendered catalog contained two workspaces and
one session; these are rendered counts, not a large-catalog workload. Each row
below samples approximately 15 seconds after settling:

| Visible state | Local / remote Host CPU, % of one core | Renderer CPU, % of one core | Local / remote Host sampled RSS, MiB | Renderer sampled RSS, MiB | Completed HTTP requests / bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local workspace | 0.67 / 0.40 | 0.27 | 297.9 / 290.7 | 213.2 | 8 / 11,867 |
| Remote workspace | 1.62 / 1.23 | 3.12 | 293.6 / 296.2 | 244.0 | 62 / 127,279 |
| Remote Settings | 1.56 / 0.98 | 2.21 | 305.3 / 346.4 | 283.3 | 66 / 133,175 |

The one connection's Node supervisor had **57.1 MiB sampled RSS** and no measured
CPU tick increase in these windows. That does not mean it has zero overhead.
Main-target sampled JS heap was 29.9 / 41.0 / 55.2 MiB respectively. All completed
HTTP requests counted in these windows were categorized as Connections API
requests; no request-size reads failed and observed WebSocket payload bytes were
zero. Other local child-process measurements remain in the JSON report.

The final run completed **20/20** warm local-to-remote navigations: **p50 1,309 ms,
p95 1,456 ms, range 767–1,460 ms**, with no observed HTTP error responses. An
earlier sampling attempt timed out after 30 seconds waiting for the remote
loading indicator to disappear. Separately, the fresh native suite passed 4/5
before its unauthorized `viewState` case passed unchanged on a focused rerun.
Neither failure has a confirmed root cause; this successful timing sample does
not close navigation/authorization stability acceptance. See
[development](<development.md>) for the suite evidence.

## Actual Windows Desktop visibility — 2026-11-04

An isolated packaged rc.5 Desktop (Electron 44.7.0) loaded this candidate and
opened its remote file view through Windows OpenSSH to an isolated WSL Host.
Connecting Playwright with `noDefaults: true` avoided its default focus-emulation
override. Windows `IsIconic` then confirmed actual minimization, and both the
parent and real guest document reported `hidden`. After two seconds to settle,
their request observers saw **zero Connections API requests in 10.004 seconds**.
Both documents returned to `visible` on restore and the file preview remained.

This closes one real Desktop hidden-request check. It does not measure hidden
CPU/RSS, all native traffic, full SSH wire bytes, long-duration background
behavior or all Desktop Settings paths. A separate transient remote presentation
timeout remains unresolved; see [development](<development.md>) for the complete
acceptance record and the setup failures that were distinguished from it.

## Costs and acceptance still outstanding

A remote view remains a separate native client tree/document. Visible idle
surface polling, full presentation payloads, native browser behavior, focus/IME,
shortcuts and notification boundaries still exist. Hidden pause/backoff is not
an incremental presentation protocol. Each POSIX connection also has a local
Node master supervisor; a single Linux connection is sampled above, while
multi-connection scaling and packaged Desktop overhead remain unmeasured.

Approval/question/progress events are not forwarded into a local control plane.
Native waterfall delivery cannot be treated as a harmless observer; the next
phase must design its Peer/reconnect/answer ownership before replacing polling.

Deterministic RPC-count, hidden-time, immutable-revision, Unicode byte-equivalence
and bounded rendering tests are CI behavior gates. The current small-directory
resource baseline is not a performance budget or proof of a before/after gain.
Peak heap, full wire bytes, hidden-state CPU/RSS, several native catalog
sizes and before/after target-machine traces remain outstanding. The intermittent
native authorization/presentation failures observed during acceptance also need
separate diagnosis before treating navigation timing as a reliability guarantee.
Commands and actual suite evidence are in [development](<development.md>).
