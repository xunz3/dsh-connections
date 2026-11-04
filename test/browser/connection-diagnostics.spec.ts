import { test, expect, type Download, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { en, zh } from '../../src/client/messages.js'

// Keep these fulfilled-only routes isolated under both the standalone config
// and the default suite's localhost baseURL. No DNS or real server is used.
test.use({ baseURL: 'http://task5-diagnostics.test' })

const id = 'connection-12345678-1234-4234-9234-123456789abc'
const receipt = '87654321-4321-4321-8321-cba987654321'
const privateMarker = 'diagnostic-private-token-must-never-be-downloaded'
let script = '', styles = ''

test.beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: 'connection-diagnostics-exclusive-fixture.tsx', loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client'
      import { Panel } from './src/client/Panel.js'
      import { en, zh } from './src/client/messages.js'
      import type { ConnectionsApi, ConnectionDiagnosticExport, ConnectionDiagnosticRef, DeleteConnectionDiagnostic } from './src/shared/types.js'
      const query = new URL(location.href).searchParams
      const copy = query.has('zh') ? zh : en
      const item = { id: '${id}', scope: 'legacy' as const, receipt: '${receipt}', issue: 'invalid-record' as const, canDelete: !query.has('unsafe') }
      let reads = 0, exports = 0, deletes = 0, lists = 0, removed = false
      const publish = () => {
        Object.assign(document.documentElement.dataset, { diagnosticsReads: String(reads), diagnosticsExports: String(exports), diagnosticsDeletes: String(deletes), connectionLists: String(lists) })
      }
      const view = { id: '${id}', name: 'Valid current connection', target: 'dev', mode: 'managed' as const, phase: 'disconnected' as const }
      const report = (): ConnectionDiagnosticExport => ({ format: 'connections-redacted-diagnostic-v1', redacted: true, credentialBackup: false, concurrency: 'same-process-provider-queue-only', record: { id: item.id, scope: item.scope, issue: item.issue, canDelete: item.canDelete } })
      const api: ConnectionsApi = {
        async checkSsh() { return { ok: true } }, async sshHosts() { return [] },
        async list() { ++lists; publish(); return [view] },
        async save() { return view }, async remove() { throw new Error('Regular connection remove must not be used') },
        async connect() { return view }, async reconnect() { return view }, async disconnect() { return view }, async update() { return view }, async open() { throw new Error('Not a diagnostic operation') },
        ...(query.has('unsupported') ? {} : { diagnostics: {
          async list() {
            ++reads; publish()
            if (query.has('list-error')) throw new Error('${privateMarker}')
            return { records: removed ? [] : [item], truncated: false }
          },
          async export(input: ConnectionDiagnosticRef) {
            ++exports; publish()
            if (query.has('export-error')) throw new Error('${privateMarker}')
            if (query.has('dirty-export')) return { ok: true, value: { ...report(), payload: '${privateMarker}', launchUrl: 'http://127.0.0.1:3080/?token=${privateMarker}' } }
            document.documentElement.dataset.exportInput = JSON.stringify(input)
            return { ok: true, value: report() }
          },
          async remove(input: DeleteConnectionDiagnostic) {
            ++deletes; publish(); document.documentElement.dataset.deleteInput = JSON.stringify(input)
            if (query.has('slow-delete')) await new Promise<void>(resolve => window.addEventListener('finish-diagnostic-delete', () => resolve(), { once: true }))
            if (query.has('stale-delete')) return { ok: false, code: 'STALE' as const }
            if (query.has('delete-error')) throw new Error('${privateMarker}')
            removed = true; return { ok: true, value: { deleted: true as const } }
          },
        } }),
      }
      publish()
      createRoot(document.getElementById('root')!).render(<Panel api={api} t={key => copy[key]} local={true} onOpen={async () => {}} />)
    ` },
    bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false, outdir: '/tmp/credential-diagnostics-exclusive-build',
    loader: { '.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  })
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text
  styles = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
})
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error })
  await page.route('http://task5-diagnostics.test/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script })
    if (path === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: styles })
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated diagnostics test</title><style>body{margin:0;font:14px/1.5 system-ui}main{padding:24px}</style><main id="root"></main><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></html>' })
  })
})
async function open(page: Page, query = '') {
  await page.goto('/' + query)
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-reads', '0')
  await page.getByRole('button', { name: query.includes('zh') ? zh.diagnosticOpen : en.diagnosticOpen, exact: true }).click()
  return page.getByRole('dialog')
}
async function downloadReport(page: Page, buttonLabel: string = en.diagnosticExport): Promise<Download> {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: new RegExp('^' + buttonLabel + ':') }).click()
  return pending
}
async function downloadJson(download: Download) {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

test('diagnostics are explicitly opened, never polled, and exact cleanup requires a redacted export and maintenance confirmation', async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  await expect(page.getByText('Valid current connection', { exact: true })).toBeVisible()
  await page.clock.runFor(60_000)
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-reads', '0')
  await page.getByRole('button', { name: en.diagnosticOpen, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(en.diagnosticRedacted)
  await expect(dialog).toContainText(en.diagnosticConcurrency)
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-reads', '1')
  await page.clock.runFor(60_000)
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-reads', '1')
  const download = await downloadReport(page)
  expect(download.suggestedFilename()).toBe('connections-redacted-diagnostic.json')
  const report = await downloadJson(download)
  expect(report).toEqual({ format: 'connections-redacted-diagnostic-v1', redacted: true, credentialBackup: false, concurrency: 'same-process-provider-queue-only', record: { id, scope: 'legacy', issue: 'invalid-record', canDelete: true } })
  for (const forbidden of [privateMarker, 'payload', 'token', 'http:', receipt]) expect(JSON.stringify(report)).not.toContain(forbidden)
  await expect(dialog).toContainText(en.diagnosticExported)
  await expect(dialog.getByRole('button', { name: en.diagnosticDelete, exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: en.back, exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-deletes', '0')
  await downloadReport(page)
  await dialog.getByRole('checkbox', { name: en.diagnosticAcknowledge, exact: true }).check()
  await dialog.getByRole('button', { name: en.diagnosticDelete, exact: true }).click()
  await expect(dialog).toContainText(en.diagnosticEmpty)
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-deletes', '1')
  expect(JSON.parse(await page.locator('html').getAttribute('data-delete-input') ?? '{}')).toEqual({ id, scope: 'legacy', receipt, confirm: true, acknowledgeProcessLocal: true })
  await expect(page.getByText('Valid current connection', { exact: true })).toBeVisible()
})

test('stale deletion requires a new refresh and export instead of replaying cleanup', async ({ page }) => {
  const dialog = await open(page, '?stale-delete')
  await downloadReport(page)
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: en.diagnosticDelete, exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(en.diagnosticStale)
  await expect(dialog.getByRole('button', { name: en.diagnosticDelete, exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: en.diagnosticRefresh, exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-reads', '2')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-deletes', '1')
})

test('an in-flight deletion is single-submit and cannot be dismissed', async ({ page }) => {
  const dialog = await open(page, '?slow-delete')
  await downloadReport(page)
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: en.diagnosticDelete, exact: true }).click()
  await expect(dialog.getByRole('button', { name: en.diagnosticDelete, exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: en.close, exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-deletes', '1')
  await page.evaluate(() => window.dispatchEvent(new Event('finish-diagnostic-delete')))
  await expect(dialog).toContainText(en.diagnosticEmpty)
})

for (const query of ['list-error', 'export-error', 'dirty-export', 'delete-error']) {
  test(`${query} never puts provider internals in the DOM or an unsafe download`, async ({ page }) => {
    const downloads: Download[] = []
    page.on('download', download => downloads.push(download))
    const dialog = await open(page, '?' + query)
    if (query !== 'list-error') {
      if (query === 'delete-error') {
        await downloadReport(page)
        await dialog.getByRole('checkbox').check()
        await dialog.getByRole('button', { name: en.diagnosticDelete, exact: true }).click()
      } else await dialog.getByRole('button', { name: new RegExp('^' + en.diagnosticExport + ':') }).click()
    }
    await expect(dialog.getByRole('alert')).toHaveText(en.diagnosticUnavailable)
    await expect(dialog).not.toContainText(privateMarker)
    expect(downloads.length).toBe(query === 'delete-error' ? 1 : 0)
    if (downloads.length) expect(JSON.stringify(await downloadJson(downloads[0]!))).not.toContain(privateMarker)
    await expect(dialog.getByRole('button', { name: en.diagnosticDelete, exact: true })).toHaveCount(0)
  })
}

test('unsafe-to-fingerprint records support redacted reports but never offer deletion', async ({ page }) => {
  const dialog = await open(page, '?unsafe')
  await expect(dialog).toContainText(en.diagnosticUnsafe)
  const report = await downloadJson(await downloadReport(page))
  expect(report.record.canDelete).toBe(false)
  await expect(dialog.getByRole('alert')).toHaveText(en.diagnosticUnsafe)
  await expect(dialog.getByRole('button', { name: en.diagnosticDelete, exact: true })).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-diagnostics-deletes', '0')
})

test('older optional API adapters keep rendering without a diagnostic entry', async ({ page }) => {
  await page.goto('/?unsupported')
  await expect(page.getByText('Valid current connection', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: en.diagnosticOpen, exact: true })).toHaveCount(0)
})

test('Chinese diagnostic and maintenance confirmation text fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await open(page, '?zh')
  await expect(dialog).toContainText(zh.diagnosticRedacted)
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await downloadReport(page, zh.diagnosticExport)
  await expect(dialog.getByRole('checkbox', { name: zh.diagnosticAcknowledge, exact: true })).toBeVisible()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})
