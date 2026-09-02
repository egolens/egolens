#!/usr/bin/env node

import { constants } from 'node:fs'
import { open, readFile, unlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const ARGUMENT_NAMES = Object.freeze([
  'application-probe', 'dataset-probe', 'output-root', 'forbidden-probe',
  'system-socket-probe', 'port',
])

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!ARGUMENT_NAMES.includes(name)) throw new Error(`Unknown probe argument: --${name}`)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

async function canRead(filename) {
  const handle = await open(filename, constants.O_RDONLY)
  try {
    const byte = Buffer.alloc(1)
    await handle.read(byte, 0, 1, 0)
  } finally {
    await handle.close()
  }
}

async function denied(action) {
  try {
    await action()
    return { denied: false, code: 'ALLOWED' }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR'
    return { denied: code === 'EPERM' || code === 'EACCES', code }
  }
}

async function connect(host, port, timeoutMs = 1500) {
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      const error = new Error('connect timeout')
      error.code = 'ETIMEDOUT'
      reject(error)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function loopbackProbe(port) {
  const server = net.createServer((socket) => socket.end('OK'))
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    await connect('127.0.0.1', port)
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
}

const options = args(process.argv.slice(2))
for (const name of [
  'application-probe', 'dataset-probe', 'output-root', 'forbidden-probe',
  'system-socket-probe', 'port',
]) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
const port = Number(options.port)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an unprivileged TCP port')

const checks = []
const check = (id, passed, observation) => checks.push({ id, passed, observation })

try {
  await canRead(options['application-probe'])
  check('application-read-allowed', true, 'allowed')
} catch (error) {
  check('application-read-allowed', false, `unexpected-${error.code ?? 'error'}`)
}

try {
  await canRead(options['dataset-probe'])
  check('dataset-read-allowed', true, 'allowed')
} catch (error) {
  check('dataset-read-allowed', false, `unexpected-${error.code ?? 'error'}`)
}

const datasetWrite = await denied(async () => {
  const handle = await open(options['dataset-probe'], constants.O_WRONLY)
  await handle.close()
})
check('dataset-write-denied', datasetWrite.denied, `open-write-${datasetWrite.code.toLowerCase()}`)

const sentinel = path.join(options['output-root'], `.boundary-probe-${process.pid}`)
let outputWritten = false
try {
  await writeFile(sentinel, 'probe\n', { flag: 'wx', mode: 0o600 })
  outputWritten = true
  check('output-write-allowed', true, 'created')
} catch (error) {
  check('output-write-allowed', false, `unexpected-${error.code ?? 'error'}`)
}
const outputRead = await denied(async () => await readFile(sentinel))
check('output-read-denied', outputWritten && outputRead.denied, `read-${outputRead.code.toLowerCase()}`)
if (outputWritten) await unlink(sentinel).catch(() => {})

const forbiddenRead = await denied(async () => await canRead(options['forbidden-probe']))
check('forbidden-resource-read-denied', forbiddenRead.denied, `read-${forbiddenRead.code.toLowerCase()}`)

const systemSocketRead = await denied(async () => await canRead(options['system-socket-probe']))
check('system-socket-root-read-denied', systemSocketRead.denied, `read-${systemSocketRead.code.toLowerCase()}`)
const systemSocketWrite = await denied(async () => {
  const handle = await open(options['system-socket-probe'], constants.O_WRONLY)
  await handle.close()
})
check('system-socket-root-unrelated-write-denied', systemSocketWrite.denied,
  `open-write-${systemSocketWrite.code.toLowerCase()}`)

const external = await denied(async () => await connect('93.184.216.34', 80))
check('broker-external-network-denied', external.denied, `connect-${external.code.toLowerCase()}`)

try {
  await loopbackProbe(port)
  check('broker-loopback-allowed', true, 'round-trip-ok')
} catch (error) {
  check('broker-loopback-allowed', false, `unexpected-${error.code ?? error.message ?? 'error'}`)
}

const result = { passed: checks.every((entry) => entry.passed), checks }
process.stdout.write(`${JSON.stringify(result)}\n`)
if (!result.passed) process.exitCode = 1
