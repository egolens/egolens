import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  countedBrowserSeatbeltArgumentsV1,
  endpointForOriginV1,
  inspectOfficialChromeIdentityV1,
} from './lib/phase10-counted-browser-boundary.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE = path.resolve('scripts/phase10-counted-browser.sb')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result ?? {})
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new CdpClient(socket)
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() { this.socket.close() }
}

async function server(hostname) {
  let hits = 0
  const instance = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '2' })
    response.end('ok')
  })
  await new Promise((resolve, reject) => {
    instance.once('error', reject)
    instance.listen(0, hostname, resolve)
  })
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('Probe server has no address')
  return {
    origin: `http://${address.address}:${address.port}`,
    hits: () => hits,
    close: () => new Promise((resolve) => instance.close(resolve)),
  }
}

async function selectedEndpoint(profile, processHandle) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited ${processHandle.exitCode}`)
    try {
      const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')
      const response = await fetch(`http://127.0.0.1:${Number(port)}/json/version`)
      if (response.ok) return response.json()
    } catch { /* still launching */ }
    await delay(100)
  }
  throw new Error('Chrome did not publish a self-selected CDP endpoint')
}

async function evaluated(client, session, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, session)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result?.value
}

async function browserFetch(client, session, url) {
  return evaluated(client, session, `(async () => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2500);
    try { await fetch(${JSON.stringify(url)}, { mode: 'no-cors', cache: 'no-store', signal: controller.signal }); return true; }
    catch { return false; } finally { clearTimeout(timer); }
  })()`)
}

test('final counted Chrome Seatbelt allows only exact source/app and denies live egress', {
  skip: process.platform !== 'darwin',
  timeout: 60_000,
}, async () => {
  const nonLoopback = Object.values(networkInterfaces()).flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address
  assert.ok(nonLoopback, 'a live non-loopback IPv4 interface is required')
  const canonicalTemp = await realpath(tmpdir())
  const [profile, scratch, source, forbidden] = await Promise.all([
    mkdtemp(path.join(canonicalTemp, 'egolens-browser-test-profile-')),
    mkdtemp(path.join(canonicalTemp, 'egolens-browser-test-scratch-')),
    mkdtemp(path.join(canonicalTemp, 'egolens-browser-test-source-')),
    mkdtemp(path.join(canonicalTemp, 'egolens-browser-test-forbidden-')),
  ])
  const sourceFile = path.join(source, 'allowed.txt')
  const forbiddenFile = path.join(forbidden, 'ambient.txt')
  await Promise.all([
    writeFile(sourceFile, 'EGOLENS_ALLOWED_SOURCE'),
    writeFile(forbiddenFile, 'EGOLENS_FORBIDDEN_SENTINEL'),
  ])
  const [app, decoy, external] = await Promise.all([
    server('127.0.0.1'), server('127.0.0.1'), server(nonLoopback),
  ])
  let chrome
  let client
  try {
    const before = await inspectOfficialChromeIdentityV1(CHROME)
    const [profileReal, scratchReal, sourceReal, socketReal, chromeReal, chromeRoot] = await Promise.all([
      realpath(profile), realpath(scratch), realpath(source), realpath(tmpdir()), realpath(CHROME),
      realpath(path.resolve(CHROME, '../../..')),
    ])
    const parameters = {
      APP_REMOTE_ENDPOINT: endpointForOriginV1(app.origin),
      BROWSER_PROFILE: profile,
      BROWSER_PROFILE_REAL: profileReal,
      CHROME_ROOT: chromeRoot,
      RUNTIME_SCRATCH: scratch,
      RUNTIME_SCRATCH_REAL: scratchReal,
      SOURCE_REAL_ROOT: sourceReal,
      SOURCE_REMOTE_ENDPOINT: endpointForOriginV1(app.origin),
      SOURCE_ROOT: source,
      SYSTEM_SOCKET_REAL_ROOT: socketReal,
      SYSTEM_SOCKET_ROOT: tmpdir(),
    }
    chrome = spawn('/usr/bin/sandbox-exec', countedBrowserSeatbeltArgumentsV1(PROFILE, parameters, [
      chromeReal,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `--crash-dumps-dir=${scratch}`, `--disk-cache-dir=${path.join(scratch, 'cache')}`,
      '--headless=new', '--disable-background-networking', '--disable-component-update',
      '--disable-crash-reporter', '--disable-default-apps', '--disable-extensions', '--disable-sync',
      '--no-first-run', '--no-default-browser-check', '--no-pings', '--password-store=basic',
      // Same launch shape as scripts/phase6-cdp-benchmark.mjs: the outer
      // Seatbelt profile is the boundary under test; Chrome's nested helper
      // sandbox cannot initialize inside it.
      '--use-mock-keychain', '--no-sandbox', 'about:blank',
    ]), {
      detached: true,
      stdio: 'ignore',
      env: { HOME: profile, LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TMPDIR: scratch },
    })
    const endpoint = await selectedEndpoint(profile, chrome)
    client = await CdpClient.connect(endpoint.webSocketDebuggerUrl)
    const target = await client.send('Target.createTarget', { url: 'about:blank' })
    const attached = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const session = attached.sessionId
    await Promise.all([
      client.send('Runtime.enable', {}, session), client.send('DOM.enable', {}, session),
    ])
    assert.equal(await browserFetch(client, session, `${app.origin}/index.html`), true)
    assert.equal(await browserFetch(client, session, `${decoy.origin}/forbidden`), false)
    assert.equal(await browserFetch(client, session, `${external.origin}/egress`), false)
    assert.equal(decoy.hits(), 0)
    assert.equal(external.hits(), 0)

    await evaluated(client, session, `document.body.innerHTML = '<input id="probe" type="file">'; true`)
    const document = await client.send('DOM.getDocument', { depth: 2 }, session)
    const input = await client.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#probe' }, session)
    await client.send('DOM.setFileInputFiles', { files: [sourceFile], nodeId: input.nodeId }, session)
    assert.equal(await evaluated(client, session, `document.querySelector('#probe').files[0].text()`), 'EGOLENS_ALLOWED_SOURCE')
    let ambient = false
    try {
      await client.send('DOM.setFileInputFiles', { files: [forbiddenFile], nodeId: input.nodeId }, session)
      ambient = (await evaluated(client, session, `document.querySelector('#probe').files[0].text()`))
        === 'EGOLENS_FORBIDDEN_SENTINEL'
    } catch { /* denied before a File can be read */ }
    assert.equal(ambient, false)
    const after = await inspectOfficialChromeIdentityV1(CHROME)
    assert.equal(after.identityHash, before.identityHash)
  } finally {
    client?.close()
    if (chrome?.pid) {
      try { process.kill(-chrome.pid, 'SIGKILL') } catch { /* already stopped */ }
    }
    await Promise.allSettled([app.close(), decoy.close(), external.close()])
    await Promise.all([profile, scratch, source, forbidden]
      .map((directory) => rm(directory, { recursive: true, force: true })))
  }
})
