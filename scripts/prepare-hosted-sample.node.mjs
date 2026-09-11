import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import { canonicalize } from './lib/oracle-receipts.mjs'
import { CHUNK_SIZE, MAX_ENTRIES, prepareHostedSample, validateCatalog, verifyHostedSample } from './prepare-hosted-sample.mjs'

const script = fileURLToPath(new URL('./prepare-hosted-sample.mjs', import.meta.url))
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const catalogFor = (entries) => {
  const payload = { schema: 'egolens-source-catalog-v1', entries }
  return { ...payload, catalogHash: hash(canonicalize(payload)) }
}

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'egolens-hosted-sample-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'source')
  await mkdir(root)
  return { base, root, output: path.join(base, 'publish') }
}

test('stages all original bytes and attribution with browser-compatible deterministic 1 MiB chunks', async (t) => {
  const { base, root, output } = await fixture(t)
  const originals = new Map([
    ['LICENSE.txt', Buffer.from('Original attribution and terms\n')],
    ['a/empty.bin', Buffer.alloc(0)],
    ['a/exact.bin', Buffer.alloc(CHUNK_SIZE, 43)],
    ['a/long.bin', Buffer.alloc(CHUNK_SIZE + 7, 81)],
    ['a/single.bin', Buffer.from([255])],
    ['a/Z.bin', Buffer.from([12])],
    ['a/space # ü.bin', Buffer.from([13])],
    ['.original-metadata', Buffer.from('unchanged')],
  ])
  for (const [name, bytes] of originals) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), bytes)
  }
  const result = await prepareHostedSample({ root, output })
  const catalog = JSON.parse(await readFile(path.join(output, 'source-catalog.json'), 'utf8'))
  assert.deepEqual(Object.keys(catalog).sort(), ['catalogHash', 'entries', 'schema'])
  assert.deepEqual(catalog.entries.map(e => e.path), [...originals.keys()].sort())
  for (const entry of catalog.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['chunks', 'path', 'sha256', 'size'])
    const bytes = originals.get(entry.path)
    assert.deepEqual(await readFile(path.join(output, entry.path)), bytes)
    assert.deepEqual(await readFile(path.join(root, entry.path)), bytes)
    assert.equal(entry.sha256, hash(bytes))
    assert.equal(entry.chunks.size, CHUNK_SIZE)
    assert.deepEqual(entry.chunks.digests, Array.from({ length: Math.ceil(bytes.length / CHUNK_SIZE) }, (_, i) =>
      hash(bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))))
  }
  // Exercise the real consumer, not just a second script-side hash helper.
  const server = await createServer({
    configFile: false,
    cacheDir: path.join(base, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, ws: false },
    appType: 'custom',
  })
  try {
    const { validateSourceCatalogV1 } = await server.ssrLoadModule('/src/teachable/source/SourceCatalog.ts')
    const browser = validateSourceCatalogV1(catalog)
    assert.equal(browser.catalogHash, result.catalogHash)
    assert.equal(browser.sourceManifestHash, result.sourceManifestHash)
    const { selectedFileSelectionV1 } = await server.ssrLoadModule('/src/teachable/authoring/selectedFileKeys.ts')
    const selected = selectedFileSelectionV1([...originals.keys()].map(name => ({
      name: path.basename(name), webkitRelativePath: `original-wrapper/${name}`,
    })))
    assert.equal(selected.strippedRoot, 'original-wrapper')
    assert.deepEqual(selected.entries.map(([name]) => name).sort(), catalog.entries.map(e => e.path))
  } finally {
    await server.close()
  }
  assert.equal(result.entryCount, originals.size)
  assert.equal(result.totalBytes, [...originals.values()].reduce((sum, bytes) => sum + bytes.length, 0))
  assert.equal(result.stagedBytes, result.totalBytes + result.catalogBytes)
  assert.deepEqual(await verifyHostedSample({ root: output }), result)
  await prepareHostedSample({ root, output: path.join(base, 'again') })
  assert.deepEqual(await readFile(path.join(output, 'source-catalog.json')), await readFile(path.join(base, 'again/source-catalog.json')))
})

test('verification rejects corrupted bytes, chunk digests, and unlisted additions', async (t) => {
  const { root, output } = await fixture(t)
  await writeFile(path.join(root, 'raw.bin'), Buffer.alloc(CHUNK_SIZE + 1, 7))
  await prepareHostedSample({ root, output })
  const filename = path.join(output, 'source-catalog.json')
  const original = JSON.parse(await readFile(filename, 'utf8'))
  await writeFile(path.join(output, 'raw.bin'), Buffer.alloc(CHUNK_SIZE + 1, 8))
  await assert.rejects(verifyHostedSample({ root: output }), /bytes or chunks differ/)
  await writeFile(path.join(output, 'raw.bin'), Buffer.alloc(CHUNK_SIZE + 1, 7))
  const changed = structuredClone(original.entries)
  changed[0].chunks.digests[1] = hash('wrong final chunk')
  await writeFile(filename, JSON.stringify(catalogFor(changed)))
  await assert.rejects(verifyHostedSample({ root: output }), /bytes or chunks differ/)
  await writeFile(filename, JSON.stringify(original))
  await writeFile(path.join(output, 'extra'), 'unlisted')
  await assert.rejects(verifyHostedSample({ root: output }), /file count/)
})

test('refuses overlapping, existing, or repository destinations without touching their contents', async (t) => {
  const { base, root, output } = await fixture(t)
  await writeFile(path.join(root, 'data'), 'original')
  await mkdir(output)
  await writeFile(path.join(output, 'keep'), 'existing')
  await assert.rejects(prepareHostedSample({ root, output }), /EEXIST/)
  assert.equal(await readFile(path.join(output, 'keep'), 'utf8'), 'existing')
  await assert.rejects(prepareHostedSample({ root, output: path.join(root, 'nested') }), /overlap/)
  await assert.rejects(prepareHostedSample({ root, output: base }), /overlap/)
  await assert.rejects(prepareHostedSample({ root, output: fileURLToPath(new URL('../hosted-test-output', import.meta.url)) }), /outside the repository/)
  const alias = path.join(base, 'alias')
  await symlink(root, alias)
  await assert.rejects(prepareHostedSample({ root, output: path.join(alias, 'nested') }), /overlap/)
})

test('rejects symlinks, noncanonical names, and catalog collisions instead of silently dropping originals', async (t) => {
  const { base, root, output } = await fixture(t)
  await writeFile(path.join(base, 'outside'), 'not source data')
  await symlink(path.join(base, 'outside'), path.join(root, 'linked'))
  await assert.rejects(prepareHostedSample({ root, output }), /Symlinks/)
  await rm(path.join(root, 'linked'))
  await symlink(base, path.join(root, 'linked-dir'))
  await assert.rejects(prepareHostedSample({ root, output }), /Symlinks/)
  await rm(path.join(root, 'linked-dir'))
  await writeFile(path.join(root, 'bad\\name'), 'bad')
  await assert.rejects(prepareHostedSample({ root, output }), /Noncanonical/)
  await rm(path.join(root, 'bad\\name'))
  await writeFile(path.join(root, 'source-catalog.json'), 'original catalog')
  await assert.rejects(prepareHostedSample({ root, output }), /already contains source-catalog/)
  assert.equal(await readFile(path.join(root, 'source-catalog.json'), 'utf8'), 'original catalog')
  await assert.rejects(lstat(output), { code: 'ENOENT' })
})

test('detects source drift and removes only its newly created incomplete stage', async (t) => {
  const { root, output } = await fixture(t)
  await writeFile(path.join(root, 'data'), 'original')
  let changed = false
  await assert.rejects(prepareHostedSample({ root, output, onProgress: ({ copied }) => {
    if (copied && !changed) {
      changed = true
      execFileSync(process.execPath, ['--input-type=module', '-e', 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[1], "changed!")', path.join(root, 'data')])
    }
  } }), /Source tree changed/)
  await assert.rejects(lstat(output), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(root, 'data'), 'utf8'), 'changed!')
})

test('enforces 50000 entries, 16 MiB, canonical paths, sorting, and complete chunks', () => {
  const entry = { path: 'data', size: 0, sha256: hash(''), chunks: { size: CHUNK_SIZE, digests: [] } }
  const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ ...entry, path: String(i).padStart(5, '0') }))
  validateCatalog(catalogFor(entries))
  assert.throws(() => validateCatalog(catalogFor([...entries, { ...entry, path: 'extra' }])), /Invalid source catalog/)
  assert.throws(() => validateCatalog(catalogFor([{ ...entry, chunks: { size: CHUNK_SIZE, digests: [hash('')] } }])), /Invalid 1 MiB chunks/)
  assert.throws(() => validateCatalog(catalogFor([{ ...entry, path: '../escape' }])), /Noncanonical/)
  assert.throws(() => validateCatalog(catalogFor([{ ...entry, path: 'z' }, entry])), /unique and sorted/)
  assert.throws(() => validateCatalog(catalogFor([entry, entry])), /unique and sorted/)
  assert.throws(() => validateCatalog({ ...catalogFor([entry]), catalogHash: hash('wrong') }), /hash mismatch/)
  assert.throws(() => validateCatalog(catalogFor(Array.from({ length: 5000 }, (_, i) => ({ ...entry, path: `${i}-${'x'.repeat(4000)}` })))), /16 MiB/)
})

test('CLI verifies offline and rejects unknown or duplicate options', async (t) => {
  const { root, output } = await fixture(t)
  await writeFile(path.join(root, 'data'), 'original')
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const staged = run('--root', root, '--output', output)
  assert.equal(run('--verify', output).catalogHash, staged.catalogHash)
  assert.throws(() => run('--upload', 'r2:example'))
  assert.throws(() => run('--root', root, '--root', root, '--output', output))
  assert.throws(() => run('--verify', output, '--output', output))
})
