import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { workspaceCatalogRevision } from '../src/host/workspace-catalog-revision.js'
import type { WorkspaceCatalog } from '../src/shared/workspace-protocol.js'

// Repeatable projection-only microbenchmark, never a real Host/renderer profile.
// Run: node --expose-gc --import tsx scripts/benchmark-catalog.ts
const baseline = (catalog: WorkspaceCatalog) => createHash('sha256').update(JSON.stringify(catalog)).digest('base64url')
const iterations = 30
function measure(hash: (catalog: WorkspaceCatalog) => string, catalog: WorkspaceCatalog) {
  for (let index = 0; index < 5; index++) hash(catalog)
  global.gc?.()
  const before = process.memoryUsage().heapUsed
  const durations: number[] = []
  for (let index = 0; index < iterations; index++) {
    const start = performance.now()
    hash(catalog)
    durations.push(performance.now() - start)
  }
  const heapDeltaBytes = process.memoryUsage().heapUsed - before
  durations.sort((left, right) => left - right)
  return { p50Ms: Number(durations[Math.floor(iterations / 2)]!.toFixed(3)), p95Ms: Number(durations[Math.ceil(iterations * 0.95) - 1]!.toFixed(3)), heapDeltaBytes }
}
const cases = []
for (const count of [1000, 20_000]) {
  const catalog: WorkspaceCatalog = {
    workspaces: [{ id: 'project', path: '/project', title: 'Benchmark project', sessionIds: Array.from({ length: count }, (_, index) => `session-${index}`) }],
    sessions: Array.from({ length: count }, (_, index) => ({ id: `session-${index}`, title: `Session ${index} 项目😀`, updatedAt: index, running: index % 5 === 0, blank: false, cwd: '/project' })),
    archivedSessionIds: [], pinnedSessionIds: [],
  }
  assert.equal(workspaceCatalogRevision(catalog), baseline(catalog))
  const payloadBytes = Buffer.byteLength(JSON.stringify(catalog))
  let largestSerializedRowBytes = 0
  for (const rows of Object.values(catalog)) for (const row of rows) largestSerializedRowBytes = Math.max(largestSerializedRowBytes, Buffer.byteLength(JSON.stringify(row)))
  cases.push({ sessions: count, payloadBytes, largestSerializedRowBytes, baseline: measure(baseline, catalog), streaming: measure(workspaceCatalogRevision, catalog) })
}
console.log(JSON.stringify({ runtime: process.version, iterations, gcAvailable: typeof global.gc === 'function', scope: 'projected catalog hash only; O(N); heap deltas are GC-sensitive, not peak memory or a CI budget', cases }, null, 2))
