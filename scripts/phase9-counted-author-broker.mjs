#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const COUNTED_PUBLIC_TOOLS = Object.freeze([
  'egolens_teachable_apply_revision',
  'egolens_teachable_finalize',
  'egolens_teachable_get_contract',
  'egolens_teachable_get_state',
  'egolens_teachable_inspect',
])

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_VISIBLE_TEXT = 64 * 1024
// A validation sweep over many sampled frames decodes one Parquet row group per
// frame and can legitimately run for minutes; the transport waits that long,
// and tool calls are serialized so a second call can never overlap the first
// inside the page and double its transient memory.
const TOOL_CALL_TIMEOUT_MS = 15 * 60_000
const ARGUMENT_NAMES = Object.freeze([
  'application', 'dataset', 'profile', 'scratch', 'output-file', 'port',
  'controller-token', 'browser-token', 'admin-token', 'chrome', 'playwright',
])
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!ARGUMENT_NAMES.includes(name)) throw new Error(`Unknown broker argument: --${name}`)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
}

function sameToken(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function bearer(request) {
  const value = request.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null
}

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

async function body(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Request body must be JSON.'), { status: 400 })
  }
}

function serveStatic(request, response, applicationRoot, browserToken, pathname) {
  if (!sameToken(request.headers['x-egolens-browser-token'], browserToken)) {
    response.writeHead(403).end()
    return
  }
  const relative = decodeURIComponent(pathname === '/' ? '/amnesia.html' : pathname)
  const resolved = path.resolve(applicationRoot, `.${relative}`)
  if (resolved !== applicationRoot && !resolved.startsWith(`${applicationRoot}${path.sep}`)) {
    response.writeHead(403).end()
    return
  }
  const stream = createReadStream(resolved)
  stream.once('error', () => {
    if (!response.headersSent) response.writeHead(404)
    response.end()
  })
  stream.once('open', () => {
    response.writeHead(200, {
      'content-type': MIME.get(path.extname(resolved)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    if (request.method === 'HEAD') {
      stream.destroy()
      response.end()
    } else stream.pipe(response)
  })
}

export function createBrokerHttpServer({
  adapter,
  applicationRoot,
  controllerToken,
  browserToken,
  adminToken,
  onShutdown = () => {},
}) {
  const calls = new Map(COUNTED_PUBLIC_TOOLS.map((name) => [name, 0]))
  const uiOperations = { view: 0, review: 0, export: 0 }
  const audit = () => ({
    publicTools: [...COUNTED_PUBLIC_TOOLS],
    toolCalls: Object.fromEntries(calls),
    uiOperations: { ...uiOperations },
    exported: adapter.exported === true,
  })

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = requestUrl.pathname
    if (!pathname.startsWith('/__phase9/')) {
      serveStatic(request, response, applicationRoot, browserToken, pathname)
      return
    }
    const isAdmin = sameToken(bearer(request), adminToken)
    const isController = sameToken(bearer(request), controllerToken)
    if (!isAdmin && !isController) {
      json(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    try {
      if (request.method === 'GET' && pathname === '/__phase9/ready') {
        json(response, 200, { ok: adapter.ready === true, tools: await adapter.tools() })
        return
      }
      if (request.method === 'GET' && pathname === '/__phase9/tools') {
        json(response, 200, { ok: true, tools: await adapter.tools() })
        return
      }
      if (request.method === 'POST' && pathname === '/__phase9/call') {
        const input = await body(request)
        if (!exactKeys(input, ['name', 'arguments']) || !COUNTED_PUBLIC_TOOLS.includes(input.name)
          || input.arguments === null || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
          throw Object.assign(new Error('Only one of the five public tools may be called.'), { status: 400 })
        }
        calls.set(input.name, calls.get(input.name) + 1)
        json(response, 200, await adapter.call(input.name, input.arguments))
        return
      }
      if (request.method === 'GET' && pathname === '/__phase9/view') {
        uiOperations.view += 1
        json(response, 200, { ok: true, view: await adapter.view() })
        return
      }
      if (request.method === 'POST' && pathname === '/__phase9/review') {
        const input = await body(request)
        if (!exactKeys(input, ['name', 'checked']) || typeof input.name !== 'string'
          || input.name.length === 0 || input.name.length > 256 || typeof input.checked !== 'boolean') {
          throw Object.assign(new Error('Invalid rendered review control request.'), { status: 400 })
        }
        uiOperations.review += 1
        await adapter.review(input)
        json(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && pathname === '/__phase9/export') {
        const input = await body(request)
        if (!exactKeys(input, [])) throw Object.assign(new Error('Export accepts no path or parameters.'), { status: 400 })
        uiOperations.export += 1
        json(response, 200, { ok: true, result: await adapter.export() })
        return
      }
      if (request.method === 'GET' && pathname === '/__phase9/audit' && isAdmin) {
        json(response, 200, { ok: true, audit: audit() })
        return
      }
      if (request.method === 'POST' && pathname === '/__phase9/shutdown' && isAdmin) {
        json(response, 200, { ok: true })
        queueMicrotask(onShutdown)
        return
      }
      json(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      json(response, Number(error?.status) || 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

function safeClone(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

async function installPublicToolTransport(context) {
  await context.addInitScript(({ allowedNames }) => {
    const allowed = new Set(allowedNames)
    const registered = new Map()
    const summaries = new Map()
    const rejected = new Set()
    let bridgeReady = false

    const clone = (value) => {
      if (value === undefined) return undefined
      try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
    }
    const ensureBridge = () => {
      if (bridgeReady || !document.documentElement) return
      bridgeReady = true
      const host = document.createElement('div')
      host.id = 'egolens-public-webmcp-transport'
      host.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:auto;z-index:2147483647'
      const request = document.createElement('textarea')
      request.id = 'egolens-public-webmcp-request'
      const response = document.createElement('textarea')
      response.id = 'egolens-public-webmcp-response'
      const definitions = document.createElement('textarea')
      definitions.id = 'egolens-public-webmcp-definitions'
      const rejectedNames = document.createElement('textarea')
      rejectedNames.id = 'egolens-public-webmcp-rejected'
      const invoke = document.createElement('button')
      invoke.id = 'egolens-public-webmcp-invoke'
      invoke.type = 'button'
      host.append(request, response, definitions, rejectedNames, invoke)
      document.documentElement.append(host)
      host.refresh = () => {
        definitions.value = JSON.stringify([...summaries.values()])
        rejectedNames.value = JSON.stringify([...rejected])
      }
      invoke.addEventListener('click', async () => {
        let envelope
        try {
          envelope = JSON.parse(request.value)
          const entry = registered.get(envelope.name)
          if (!entry) throw new Error(`public tool not registered: ${envelope.name}`)
          const result = await entry(envelope.arguments ?? {})
          response.value = JSON.stringify({ id: envelope.id, ok: true, result: clone(result) })
        } catch (error) {
          response.value = JSON.stringify({
            id: envelope?.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      host.refresh()
    }
    const registerTool = (...args) => {
      const definition = typeof args[0] === 'string' ? (args[1] ?? {}) : (args[0] ?? {})
      const name = typeof args[0] === 'string' ? args[0] : definition.name
      let handler = typeof args[0] === 'string' ? args[2] : args[1]
      handler ??= definition.execute ?? definition.handler ?? definition.callback ?? definition.run
      if (!allowed.has(name)) {
        rejected.add(String(name))
        ensureBridge()
        document.querySelector('#egolens-public-webmcp-transport')?.refresh?.()
        return
      }
      if (typeof handler !== 'function') throw new Error(`public tool has no callable handler: ${name}`)
      registered.set(name, handler)
      summaries.set(name, {
        name,
        description: definition.description,
        inputSchema: clone(definition.inputSchema ?? definition.parameters ?? definition.schema),
      })
      ensureBridge()
      document.querySelector('#egolens-public-webmcp-transport')?.refresh?.()
    }
    Object.defineProperty(document, 'modelContext', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: Object.freeze({ registerTool }),
    })
    ensureBridge()
    document.addEventListener('DOMContentLoaded', ensureBridge, { once: true })
  }, { allowedNames: COUNTED_PUBLIC_TOOLS })
}

// The candidate output mount is write-only for the broker (Seatbelt denies
// every file-read* on it), so the export must be a plain exclusive create plus
// data writes. Playwright's download.saveAs() goes through copyfile(3), whose
// extra operations on the destination fail with EPERM under that profile.
export async function writeCandidateExport(download, outputFile) {
  const failure = await download.failure()
  if (failure) throw new Error(`Candidate export download failed: ${failure}`)
  const sourcePath = await download.path()
  await pipeline(
    createReadStream(sourcePath),
    createWriteStream(outputFile, { flags: 'wx', mode: 0o600 }),
  )
}

export async function createBrowserAdapter({
  playwrightPath,
  chromePath,
  profileDirectory,
  scratchDirectory,
  datasetRoot,
  outputFile,
  origin,
  browserToken,
}) {
  const playwright = await import(pathToFileURL(playwrightPath).href)
  const chromium = playwright.chromium ?? playwright.default?.chromium
  if (!chromium) throw new Error('Playwright Chromium runtime was not found.')
  await mkdir(path.join(scratchDirectory, 'downloads'), { recursive: true })
  const context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath: chromePath,
    headless: true,
    acceptDownloads: true,
    serviceWorkers: 'block',
    chromiumSandbox: false,
    downloadsPath: path.join(scratchDirectory, 'downloads'),
    extraHTTPHeaders: { 'x-egolens-browser-token': browserToken },
    args: [
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-crash-reporter',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) {
      await route.abort('blockedbyclient')
    } else await route.continue()
  })
  await installPublicToolTransport(context)
  const pages = context.pages()
  const page = pages[0] ?? await context.newPage()
  await page.goto(`${origin}/amnesia.html`, { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles(datasetRoot)
  await page.waitForFunction((expected) => {
    const definitions = document.querySelector('#egolens-public-webmcp-definitions')?.value
    const rejected = document.querySelector('#egolens-public-webmcp-rejected')?.value
    if (!definitions || !rejected) return false
    try {
      const names = JSON.parse(definitions).map((entry) => entry.name).sort()
      return JSON.stringify(names) === JSON.stringify([...expected].sort()) && JSON.parse(rejected).length === 0
    } catch { return false }
  }, COUNTED_PUBLIC_TOOLS, { timeout: 30_000 })

  let sequence = 0
  let exported = false
  let queue = Promise.resolve()
  const serialized = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }
  const tools = async () => JSON.parse(await page.locator('#egolens-public-webmcp-definitions').inputValue())
  const invoke = async (name, argumentsValue) => {
      const id = ++sequence
      const response = page.locator('#egolens-public-webmcp-response')
      await response.fill('', { force: true })
      await page.locator('#egolens-public-webmcp-request').fill(JSON.stringify({ id, name, arguments: argumentsValue }), { force: true })
      // The transport host is a 1px, overflow-hidden fixture, so a real
      // pointer click never reaches the button and the bridge never runs.
      // Dispatch the click event directly; the bridge listener is what matters.
      await page.locator('#egolens-public-webmcp-invoke').dispatchEvent('click')
      await page.waitForFunction(({ expectedId }) => {
        const value = document.querySelector('#egolens-public-webmcp-response')?.value
        if (!value) return false
        try { return JSON.parse(value).id === expectedId } catch { return false }
      }, { expectedId: id }, { timeout: TOOL_CALL_TIMEOUT_MS })
      return JSON.parse(await response.inputValue())
  }
  return {
    ready: true,
    get exported() { return exported },
    tools,
    call(name, argumentsValue) {
      if (!COUNTED_PUBLIC_TOOLS.includes(name)) throw new Error('Tool name is outside the counted author boundary.')
      return serialized(() => invoke(name, argumentsValue))
    },
    async view() {
      // Review controls are the rendered "Accept <capability>" / "Reject
      // <capability>" buttons; `checks` reports one entry per capability with
      // its current verdict so the author can address it by capability name.
      const checks = []
      const accepts = page.getByRole('button', { name: /^Accept /u })
      for (let index = 0; index < await accepts.count(); index += 1) {
        const button = accepts.nth(index)
        const label = await button.getAttribute('aria-label')
        if (!label) continue
        const name = label.slice('Accept '.length)
        const accepted = (await button.getAttribute('aria-pressed')) === 'true'
        const rejected = (await page.getByRole('button', { name: `Reject ${name}`, exact: true }).getAttribute('aria-pressed')) === 'true'
        checks.push({ name, checked: accepted, verdict: accepted ? 'accepted' : rejected ? 'rejected' : null })
      }
      return {
        text: (await page.locator('body').innerText()).slice(0, MAX_VISIBLE_TEXT),
        buttons: (await page.getByRole('button').allTextContents()).filter(Boolean).slice(0, 128),
        checks,
      }
    },
    async review({ name, checked }) {
      const button = page.getByRole('button', { name: `${checked ? 'Accept' : 'Reject'} ${name}`, exact: true })
      if (await button.count() !== 1) throw new Error('Rendered review control is missing or ambiguous.')
      await button.click()
    },
    async export() {
      if (exported) throw new Error('Candidate export is one-shot.')
      const pending = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export JSON', exact: true }).click()
      const download = await pending
      await writeCandidateExport(download, outputFile)
      exported = true
      return { filename: path.basename(outputFile) }
    },
    async close() {
      await context.close()
    },
  }
}

async function main() {
  const options = args(process.argv.slice(2))
  for (const name of [
    'application', 'dataset', 'profile', 'scratch', 'output-file', 'port',
    'controller-token', 'browser-token', 'admin-token', 'chrome', 'playwright',
  ]) if (!options[name]) throw new Error(`Missing --${name}`)
  const port = Number(options.port)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid --port')
  const origin = `http://127.0.0.1:${port}`
  let adapter = {
    ready: false,
    exported: false,
    tools: async () => [],
  }
  const adapterFacade = {
    get ready() { return adapter.ready },
    get exported() { return adapter.exported },
    tools: (...argumentsValue) => adapter.tools(...argumentsValue),
    call: (...argumentsValue) => adapter.call(...argumentsValue),
    view: (...argumentsValue) => adapter.view(...argumentsValue),
    review: (...argumentsValue) => adapter.review(...argumentsValue),
    export: (...argumentsValue) => adapter.export(...argumentsValue),
  }
  let shutdownResolve
  const shutdown = new Promise((resolve) => { shutdownResolve = resolve })
  const server = createBrokerHttpServer({
    adapter: adapterFacade,
    applicationRoot: options.application,
    controllerToken: options['controller-token'],
    browserToken: options['browser-token'],
    adminToken: options['admin-token'],
    onShutdown: shutdownResolve,
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    // Node's default requestTimeout (5 minutes) would cut a long serialized
    // tool call; the tool-call ceiling governs instead.
    server.requestTimeout = TOOL_CALL_TIMEOUT_MS + 60_000
    server.headersTimeout = 60_000
    server.listen(port, '127.0.0.1', resolve)
  })
  try {
    adapter = await createBrowserAdapter({
      playwrightPath: options.playwright,
      chromePath: options.chrome,
      profileDirectory: options.profile,
      scratchDirectory: options.scratch,
      datasetRoot: options.dataset,
      outputFile: options['output-file'],
      origin,
      browserToken: options['browser-token'],
    })
    const registered = (await adapter.tools()).map((entry) => entry.name).sort()
    if (JSON.stringify(registered) !== JSON.stringify([...COUNTED_PUBLIC_TOOLS].sort())) {
      throw new Error('Author build did not expose exactly the five public tools.')
    }
    process.stdout.write(`${JSON.stringify({ ready: true, port, publicTools: registered })}\n`)
    await shutdown
    const audit = {
      publicTools: registered,
      exported: adapter.exported === true,
    }
    process.stdout.write(`${JSON.stringify({ closed: true, audit: safeClone(audit) })}\n`)
  } finally {
    await adapter.close?.().catch(() => {})
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main()
}
