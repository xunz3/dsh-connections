/** Read-only measurements of a previously initialized, disposable two-Host fixture.
 * UI navigation changes only this fixture; no model request or user profile is used.
 */
import { chromium } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir, cpus } from 'node:os'
import { performance } from 'node:perf_hooks'

const root = resolve(process.argv[2] ?? '')
if (!root.startsWith(`${tmpdir()}/`) || process.platform !== 'linux') throw new Error('Usage: node scripts/profile-native.mjs /tmp/initialized-two-host-fixture')
const durationMs = Number(process.env.DSH_PROFILE_SAMPLE_MS ?? 15000)
const repetitions = Number(process.env.DSH_PROFILE_REPETITIONS ?? 20)
if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 120000 || !Number.isInteger(repetitions) || repetitions < 2 || repetitions > 100) throw new Error('Invalid sample duration or repetition count')
const metadata = JSON.parse(await readFile(join(root, 'processes.json'), 'utf8'))
for (const build of Object.values(metadata.builds)) for (const [file, expected] of Object.entries(build.files)) {
  const actual = createHash('sha256').update(await readFile(join(build.packageRoot, file))).digest('hex')
  if (actual !== expected) throw new Error('Installed fixture code no longer matches its recorded build')
}
const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function dismissWelcome(surface) {
  for (const [role, name, close] of [
    ['button', /^(Continue|继续)$/, undefined],
    ['dialog', /^(Get started|开始使用)$/, /^(Close|关闭)$/],
    ['dialog', /^(Add an API key to get started|添加一个 API Key 开始使用)$/, /^(Configure later|稍后配置)$/],
  ]) {
    const item = surface.getByRole(role, { name })
    if (await item.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) {
      if (close) await item.getByRole('button', { name: close }).click(); else await item.click()
    }
  }
}
async function proc(pid) {
  try {
    const stat = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    return { pid, start: stat[19], cpu: (Number(stat[11]) + Number(stat[12])) / ticks,
      rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 }
  } catch { return undefined }
}
for (const side of ['host', 'remote']) {
  if ((await proc(metadata[side]?.pid))?.start !== metadata[side]?.start) throw new Error(`The fixture ${side} is not running with its recorded identity`)
}
async function descendants(pid) {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).filter(Boolean).map(Number)
  return [...children, ...(await Promise.all(children.map(descendants))).flat()]
}
const launch = (await readFile(join(root, 'host.log'), 'utf8')).match(/dsh web: (http[^\s]+)/)?.[1]
if (!launch) throw new Error('Fixture startup URL missing')
const report = { schema: 1, capturedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  builds: Object.fromEntries(Object.entries(metadata.builds).map(([side, build]) => [side, build.files])), durationMs, repetitions, samples: [],
  limitations: [
    'Current candidate baseline only; no before/after performance improvement is inferred.',
    'Hosts and SSH are real but both Hosts run on this Linux machine over loopback.',
    'RSS is sampled at approximately 500 ms, not a peak-heap measurement; shared pages may be counted in multiple processes.',
    'Main-target CDP JSHeapUsedSize is not aggregate remote-frame or Host heap; renderer CPU/RSS includes all renderer processes of this test browser.',
    'HTTP byte totals count requests completed in the sample; WebSocket totals count payload bytes, not TLS/framing or total SSH wire bytes.',
    'Navigation timing is click-to-presented UI including automation overhead, not INP or a production latency budget.',
  ] }
let stage = 'browser-start'
const save = () => writeFile(join(root, 'performance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
report.httpFailures = []
report.navigationSamplesMs = []
const browser = await chromium.launch({ headless: process.env.DSH_PROFILE_HEADED !== '1' })
try {
  report.environment.chromium = browser.version()
  const context = await browser.newContext({ viewport: { width: 1360, height: 940 } })
  const page = await context.newPage()
  page.on('response', response => {
    if (response.status() >= 400 && report.httpFailures.length < 100) report.httpFailures.push({ stage, status: response.status(),
      connections: new URL(response.url()).pathname.startsWith('/api/connections/') })
  })
  page.setDefaultTimeout(30000)
  const system = await browser.newBrowserCDPSession(), cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  let network, pending = new Set()
  page.on('requestfinished', request => {
    const sample = network
    if (!sample) return
    const completion = request.sizes().then(size => {
      sample.requests++
      sample.httpBytes += size.requestBodySize + size.requestHeadersSize + size.responseBodySize + size.responseHeadersSize
      // Paths and parameters can contain credentials/native identities. Keep
      // only a bounded category count, never URLs, cookies or request bodies.
      const path = new URL(request.url()).pathname
      const category = path.startsWith('/api/connections/') ? 'connections' : path.startsWith('/api/') ? 'otherApi' : 'assets'
      sample.categories[category] = (sample.categories[category] ?? 0) + 1
    }).catch(() => { sample.unmeasuredRequests++ }).finally(() => pending.delete(completion))
    pending.add(completion)
  })
  page.on('websocket', socket => {
    for (const event of ['framesent', 'framereceived']) socket.on(event, ({ payload }) => {
      if (network) network.webSocketPayloadBytes += Buffer.byteLength(payload)
    })
  })
  const workspaces = page.getByRole('region', { name: 'Workspaces', exact: true })
  const local = workspaces.getByRole('button', { name: 'local-project', exact: true })
  const remote = workspaces.getByRole('button', { name: 'remote-project · Unified native SSH', exact: true })
  const readyRemote = async () => {
    await page.frameLocator('iframe[title="Remote workspace"]').locator('.dc-embedded-layout').waitFor({ state: 'visible' })
    await page.locator('.dc-remote-loading').waitFor({ state: 'hidden' })
  }
  await page.goto(launch, { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('Fixture navigation failed') })
  await dismissWelcome(page)
  // Native acceptance initializes the fixture's first-use flows and both project rows.
  await local.waitFor({ state: 'visible' }); await remote.waitFor({ state: 'visible' })
  report.renderedCatalog = { workspaces: await page.locator('.dcw-project').count(), sessions: await page.locator('.dcw-session').count() }
  const processes = async () => {
    const infos = (await system.send('SystemInfo.getProcessInfo')).processInfo
    const groups = new Map([[metadata.host.pid, 'localHost'], [metadata.remote.pid, 'remoteHost']])
    for (const pid of await descendants(metadata.host.pid)) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
      groups.set(pid, command.includes('--input-type=commonjs') && command.includes('argumentsJson, directory, grace') ? 'supervisor' : 'otherLocalChildren')
    }
    for (const info of infos) if (info.type === 'renderer') groups.set(info.id, 'renderers')
    const result = []
    for (const [pid, group] of groups) { const sample = await proc(pid); if (sample) result.push({ ...sample, group }) }
    return result
  }
  const heap = async () => (await cdp.send('Performance.getMetrics')).metrics.find(row => row.name === 'JSHeapUsedSize')?.value ?? 0
  const sample = async name => {
    stage = name
    // Separate navigation/loading from steady-state sampling.
    await pause(2000)
    const net = { requests: 0, unmeasuredRequests: 0, httpBytes: 0, webSocketPayloadBytes: 0, categories: {} }
    network = net
    const start = performance.now(), initial = await processes(), seen = new Map(initial.map(row => [`${row.pid}/${row.start}`, row]))
    const groups = {}, heaps = []
    const capture = async () => {
      const rss = {}
      for (const row of await processes()) {
        const key = `${row.pid}/${row.start}`, previous = seen.get(key)
        const group = groups[row.group] ??= { cpuSeconds: 0, peakSampledRssBytes: 0 }
        if (previous) group.cpuSeconds += Math.max(0, row.cpu - previous.cpu)
        seen.set(key, row)
        rss[row.group] = (rss[row.group] ?? 0) + row.rss
      }
      for (const [name, bytes] of Object.entries(rss)) groups[name].peakSampledRssBytes = Math.max(groups[name].peakSampledRssBytes, bytes)
      heaps.push(await heap())
    }
    await capture()
    while (performance.now() - start < durationMs) { await pause(500); await capture() }
    network = undefined
    await Promise.all([...pending])
    const elapsedMs = performance.now() - start
    for (const group of Object.values(groups)) group.cpuPercentOneCore = group.cpuSeconds / (elapsedMs / 1000) * 100
    report.samples.push({ name, elapsedMs, visibility: await page.evaluate(() => document.visibilityState), groups,
      mainTargetPeakSampledJsHeapBytes: Math.max(...heaps), network: net })
    await save()
    console.log(`Sampled ${name}`)
  }
  await local.click(); await page.locator('iframe[title="Remote workspace"]').waitFor({ state: 'detached' })
  await sample('local-visible')
  await remote.click(); await readyRemote()
  await dismissWelcome(page.frameLocator('iframe[title="Remote workspace"]'))
  await sample('remote-workspace-visible')
  // Never substitute a frozen page or synthetic visibility event for actual
  // browser backgrounding. Headless Chromium may leave both tabs visible.
  const background = await context.newPage(); await background.goto('about:blank'); await background.bringToFront()
  const hidden = await page.evaluate(() => document.visibilityState === 'hidden')
  if (hidden) await sample('remote-workspace-hidden')
  else report.limitations.push('This browser kept the background tab visible; hidden resource sampling was omitted. Existing hidden-time behavior tests are separate evidence.')
  await background.close(); await page.bringToFront()
  const timings = []
  for (let i = 0; i < repetitions; i++) {
    stage = `navigation-${i + 1}`
    await local.click(); await page.locator('iframe[title="Remote workspace"]').waitFor({ state: 'detached' })
    const start = performance.now(); await remote.click(); await readyRemote(); timings.push(performance.now() - start)
    report.navigationSamplesMs.push(timings.at(-1))
    await save()
    if ((i + 1) % 5 === 0) console.log(`Completed ${i + 1}/${repetitions} navigations`)
  }
  timings.sort((a, b) => a - b)
  report.remoteNavigation = { samples: timings.length, p50Ms: timings[Math.ceil(timings.length * .5) - 1], p95Ms: timings[Math.ceil(timings.length * .95) - 1], minMs: timings[0], maxMs: timings.at(-1) }
  await local.click(); await page.locator('iframe[title="Remote workspace"]').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Host: This computer', exact: true }).click()
  await page.getByRole('menuitem', { name: /Unified native SSH/ }).click()
  await page.frameLocator('.dcs-remote-settings iframe').locator('.dc-embedded-layout').waitFor({ state: 'visible' })
  await page.locator('.dcs-settings-status').waitFor({ state: 'detached' })
  await dismissWelcome(page.frameLocator('.dcs-remote-settings iframe'))
  await sample('remote-settings-visible')
  report.complete = true
  await save()
  console.log(`Wrote sanitized measurements to ${join(root, 'performance.json')}`)
} catch (error) {
  report.complete = false
  report.failure = { stage, type: error.name }
  await save()
  throw new Error(`Native profile failed during ${stage}; sanitized partial measurements retained`, { cause: error })
} finally { await browser.close() }
