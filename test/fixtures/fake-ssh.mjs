#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const controlPath = args[args.indexOf('-S') + 1]
const log = (entry) => appendFileSync(process.env.TEST_SSH_LOG, JSON.stringify({ pid: process.pid, args, ...entry }) + '\n')
log({ event: 'start' })
if (process.env.TEST_SSH_LEGACY_OPTIONS && args.includes('ForkAfterAuthentication=no')) {
  const ignored = args.indexOf('IgnoreUnknown=ForkAfterAuthentication')
  if (ignored < 0 || ignored > args.indexOf('ForkAfterAuthentication=no')) {
    process.stderr.write('Bad configuration option: forkafterauthentication')
    process.exit(255)
  }
}

if (args.includes('-M')) {
  if (process.env.TEST_SSH_DESCENDANT) {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    log({ event: 'descendant', pid: child.pid, args: [] })
  }
  if (process.env.TEST_SSH_MASTER_ERROR) {
    process.stderr.write(process.env.TEST_SSH_MASTER_ERROR)
    process.exit(255)
  }
  if (process.env.TEST_SSH_HANG === 'master') setInterval(() => {}, 1000)
  else {
    let attempts = 0
    createServer((socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(data.toString())
        if (process.env.TEST_SSH_HANG === request.operation) return
        if (request.operation === 'check') { socket.end(JSON.stringify({ code: 0 })); return }
        attempts++
        if (process.env.TEST_SSH_FORWARD_FAIL || attempts <= Number(process.env.TEST_SSH_FORWARD_RACES ?? 0)) {
          socket.end(JSON.stringify({ code: 255, stderr: 'mux_client_forward: forwarding request failed: Port forwarding failed' }))
          return
        }
        const port = Number(request.forward.split(':')[1])
        const forward = createServer((client) => client.end('owned forward'))
        forward.once('error', () => socket.end(JSON.stringify({ code: 255, stderr: 'Address already in use' })))
        forward.listen(port, '127.0.0.1', () => {
          socket.end(JSON.stringify({ code: 0 }))
          if (process.env.TEST_SSH_EXIT_AFTER_FORWARD) setTimeout(() => process.exit(23), Number(process.env.TEST_SSH_EXIT_AFTER_FORWARD))
        })
      })
    }).listen(controlPath)
  }
} else {
  const socket = createConnection(controlPath)
  socket.once('error', () => process.exit(255))
  socket.once('connect', () => socket.write(JSON.stringify({ operation: args[args.indexOf('-O') + 1], forward: args[args.indexOf('-L') + 1] })))
  socket.once('data', (data) => {
    const response = JSON.parse(data.toString())
    if (response.stderr) process.stderr.write(response.stderr)
    socket.destroy()
    process.exitCode = response.code
  })
}
