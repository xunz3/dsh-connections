// Playwright's server readiness checks run in the test runner, not webServer.env.
// Preserve existing exclusions and proxy settings for non-loopback requests.
const bypass = [...new Set([
  ...(process.env.NO_PROXY ?? '').split(/[,\s]+/),
  ...(process.env.no_proxy ?? '').split(/[,\s]+/),
  '127.0.0.1', 'localhost', '[::1]', '::1',
].filter(Boolean))].join(',')

process.env.NO_PROXY = bypass
process.env.no_proxy = bypass
