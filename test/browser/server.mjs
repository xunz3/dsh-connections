import { build } from 'esbuild'
import { createServer } from 'node:http'
const [built, workspaces] = await Promise.all(['test/browser/fixture.tsx', 'test/browser/workspaces.fixture.tsx'].map(entry => build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false })))
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connections test</title><style>body{margin:0;font:14px/1.5 system-ui;background:var(--dsw-alias-bg-base,#fff)}main{max-width:760px;margin:40px auto;padding:0 28px}@media(prefers-color-scheme:dark){:root{--dsw-alias-bg-base:#1e1f22;--dsw-alias-bg-layer-1:#25262a;--dsw-alias-label-primary:#eceef1;--dsw-alias-label-secondary:#a1a5af;--dsw-alias-border-l1:#34373e;--dsw-alias-border-l2:#484c55}}</style><main id="root"></main><script type="module" src="/fixture.js"></script></html>'
createServer((req, res) => {
  const script = req.url === '/fixture.js' ? built.outputFiles[0].text : req.url === '/workspaces.fixture.js' ? workspaces.outputFiles[0].text : undefined
  res.setHeader('Content-Type', script === undefined ? 'text/html' : 'text/javascript')
  res.end(script ?? (req.url?.startsWith('/workspaces') ? html.replace('/fixture.js', '/workspaces.fixture.js') : html))
}).listen(Number(process.env.DSH_CONNECTIONS_FIXTURE_PORT ?? 43187), '127.0.0.1')
