import { connectTunnel } from '../../src/host/ssh.ts'

const tunnel = await connectTunnel({ target: 'fixture', remotePort: 3080 }, {
  sshPath: process.env.TEST_SSH_PATH,
  transport: 'control', startupTimeoutMs: 5_000, shutdownGraceMs: 100,
})
process.send({ port: tunnel.port })
