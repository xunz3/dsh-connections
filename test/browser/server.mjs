import { build } from 'esbuild'
import { createServer } from 'node:http'
// Standalone fixtures render the published native primitives and their CSS.
const [built, workspaces, catalog] = await Promise.all(['test/browser/fixture.tsx', 'test/browser/workspaces.fixture.tsx', 'test/browser/workspace-catalog.fixture.tsx'].map(entry => build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false, outdir: '/tmp/dsh-connections-fixture-build', loader: { '.css': 'local-css', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })))
const script = result => result.outputFiles.find(file => file.path.endsWith('.js')).text
const styles = new Map([
  ['/fixture.css', built], ['/workspaces.fixture.css', workspaces], ['/workspace-catalog.fixture.css', catalog],
].map(([path, result]) => [path, result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')]))
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connections test</title><style>body{margin:0;font:14px/1.5 system-ui;background:var(--dsw-alias-bg-base,#fff)}main{max-width:760px;margin:40px auto;padding:0 28px}@media(prefers-color-scheme:dark){:root{--dsw-alias-bg-base:#1e1f22;--dsw-alias-bg-layer-1:#25262a;--dsw-alias-label-primary:#eceef1;--dsw-alias-label-secondary:#a1a5af;--dsw-alias-border-l1:#34373e;--dsw-alias-border-l2:#484c55}}</style><main id="root"></main><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></html>'
createServer((req, res) => {
  if (styles.has(req.url)) { res.setHeader('Content-Type', 'text/css'); res.end(styles.get(req.url)); return }
  const body = req.url === '/fixture.js' ? script(built) : req.url === '/workspaces.fixture.js' ? script(workspaces) : req.url === '/workspace-catalog.fixture.js' ? script(catalog) : undefined
  res.setHeader('Content-Type', body === undefined ? 'text/html' : 'text/javascript')
  res.end(body ?? (req.url?.startsWith('/catalog') ? html.replaceAll('/fixture.', '/workspace-catalog.fixture.') : req.url?.startsWith('/workspaces') ? html.replaceAll('/fixture.', '/workspaces.fixture.') : html))
}).listen(Number(process.env.DSH_CONNECTIONS_FIXTURE_PORT ?? 43187), '127.0.0.1')
