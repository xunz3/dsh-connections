#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createConnection } from 'node:net'

appendFileSync(process.env.TEST_SSH_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\n')
if (process.env.TEST_SSH_STDIO_ERROR) {
  process.stderr.write(process.env.TEST_SSH_STDIO_ERROR + '\n')
  process.exitCode = 255
} else if (process.env.TEST_SSH_STDIO_HANG) {
  process.stdin.resume()
  setInterval(() => {}, 1_000)
} else {
  const args = process.argv.slice(2)
  const destination = args[args.indexOf('-W') + 1]
  const socket = createConnection({ host: '127.0.0.1', port: Number(destination.split(':')[1]), allowHalfOpen: true })
  socket.on('error', error => { process.stderr.write(error.message); process.exit(255) })
  process.stdin.on('error', () => {})
  process.stdout.on('error', () => process.exit(0))
  process.stdin.pipe(socket)
  socket.pipe(process.stdout, { end: false })
  socket.on('end', () => { process.stdout.write('', () => process.exit(0)) })
}
