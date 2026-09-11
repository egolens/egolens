/** Local browser benchmark, deliberately not an application build entry. */
import '../src/main'
import { useSceneStore } from '../src/stores/useSceneStore'
import { teachableAuthoringSession } from '../src/teachable/authoring/browserSession'
import { openRemoteSourceInventoryV1 } from '../src/teachable/authoring/RemoteSourceInventory'
import { PANDASET_TEACHING_SAMPLE as sample } from '../src/utils/teachingSample'
import { compileRecipeV1 } from '../src/teachable/recipe/compiler'
import { bundledPhase2OperatorRegistry } from '../src/teachable/operators/bundledPhase2'
import { bindRecipeSceneV1 } from '../src/teachable/runtime/bindRecipeScene'
import { RecipeWorkerPlaybackV1 } from '../src/teachable/runtime/RecipeWorkerPlayback'
const output = document.querySelector<HTMLPreElement>('#report')!
const run = document.querySelector<HTMLButtonElement>('#run')!
const verify = document.querySelector<HTMLButtonElement>('#verify')!
const parity = document.querySelector<HTMLButtonElement>('#parity')!
const checkpointKey = 'egolens:recipe-worker-benchmark:2026-09-11'
const checkpoint = JSON.parse(localStorage.getItem(checkpointKey) ?? 'null')
const report: Record<string, unknown> = checkpoint?.report ?? { schema: 1, userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], trials: [], notes: 'One warm-up followed by five trials. Body bytes are decoded response bytes, not wire/compressed bytes. Store readiness is not GPU presentation time.' }
const trials = report.trials as Record<string, unknown>[]
const requests: Record<string, unknown>[] = []
const originalFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init)
  const url = String(input)
  if (!url.startsWith(sample.rootUrl) || !response.body) return response
  const entry = { url, bytes: 0, status: response.status, range: new Headers(init?.headers).get('range'), done: false }
  requests.push(entry)
  const measured = new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) { entry.bytes += chunk.byteLength; controller.enqueue(chunk) }, flush() { entry.done = true } })), response)
  Object.defineProperty(measured, 'url', { value: response.url })
  Object.defineProperty(measured, 'type', { value: response.type })
  return measured
}
const show = (phase: string) => {
  output.textContent = JSON.stringify({ phase, ...report }, null, 2)
  localStorage.setItem(checkpointKey, JSON.stringify({ phase, report }))
}
if (checkpoint) show(`${checkpoint.phase} (saved checkpoint)`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function cameras(index: number) {
  const start = performance.now()
  while (useSceneStore.getState().currentFrameIndex !== index || (useSceneStore.getState().currentFrame?.cameraImages?.size ?? 0) < 6) {
    if (performance.now() - start > 30000) throw new Error(`Camera completion timed out at frame ${index}`)
    await sleep(20)
  }
}
run.onclick = async () => {
  run.disabled = verify.disabled = parity.disabled = true
  trials.length = 0
  delete report.error
  try {
    for (let trial = 0; trial < 6; trial++) {
      show(`Trial ${trial + 1}/6: connecting`)
      const inventory = await openRemoteSourceInventoryV1({ rootUrl: sample.rootUrl, catalogUrl: sample.catalogUrl, expectedCatalogHash: sample.catalogHash, preferFullObjects: true, limits: { maxTotalResponseBytes: sample.maxTotalResponseBytes } })
      const matches = await teachableAuthoringSession.findSavedRecipes(inventory)
      if (!matches[0]) throw new Error('No sealed adapter matches the hosted sample in this browser.')
      report.recipeHash = matches[0].recipeHash
      report.recipe = matches[0].artifact
      const firstRequest = requests.length
      const start = performance.now()
      await useSceneStore.getState().actions.loadAuthoredScene(inventory, matches[0].artifact)
      if (useSceneStore.getState().status !== 'ready') throw new Error(useSceneStore.getState().error ?? 'Scene failed')
      const firstPointMs = performance.now() - start
      await cameras(0)
      const firstCamerasMs = performance.now() - start
      const samples: { frame: number; ms: number; camerasMs: number; warm: boolean }[] = []
      for (const frame of [40, 40, 41, 42, 43, 44, 45]) {
        const at = performance.now()
        await useSceneStore.getState().actions.loadFrame(frame)
        const ms = performance.now() - at
        await cameras(frame)
        samples.push({ frame, ms, camerasMs: performance.now() - at, warm: samples.length === 1 })
      }
      const snapshot = window.__EGOLENS_PERF__?.snapshot()
      useSceneStore.getState().actions.reset()
      inventory.revoke()
      await sleep(100)
      trials.push({ warmup: trial === 0, firstPointMs, firstCamerasMs, samples, requests: requests.slice(firstRequest), snapshot, disposed: window.__EGOLENS_PERF__?.snapshot().lastDisposedScene })
      show(`Trial ${trial + 1}/6 complete`)
    }
    show('Complete')
  } catch (error) { report.error = String(error); show('Failed') }
  finally { run.disabled = verify.disabled = parity.disabled = false }
}
verify.onclick = async () => {
  run.disabled = verify.disabled = parity.disabled = true
  let inventory: Awaited<ReturnType<typeof openRemoteSourceInventoryV1>> | undefined
  try {
    const connect = async () => {
      inventory = await openRemoteSourceInventoryV1({ rootUrl: sample.rootUrl, catalogUrl: sample.catalogUrl, expectedCatalogHash: sample.catalogHash, preferFullObjects: true, limits: { maxTotalResponseBytes: sample.maxTotalResponseBytes } })
      const [match] = await teachableAuthoringSession.findSavedRecipes(inventory)
      if (!match) throw new Error('No sealed adapter matches the hosted sample.')
      report.recipeHash = match.recipeHash
      await useSceneStore.getState().actions.loadAuthoredScene(inventory, match.artifact)
      if (useSceneStore.getState().status !== 'ready') throw new Error(useSceneStore.getState().error ?? 'Scene failed')
    }
    show('Verifying rapid seeks')
    await connect()
    await Promise.all([50, 10, 60].map(i => useSceneStore.getState().actions.loadFrame(i)))
    await cameras(60)
    await sleep(1000)
    report.rapidSeek = { requested: [50, 10, 60], displayed: useSceneStore.getState().currentFrameIndex, cameraCount: useSceneStore.getState().currentFrame?.cameraImages.size }
    if (useSceneStore.getState().currentFrameIndex !== 60) throw new Error('Stale seek replaced the last requested frame')
    useSceneStore.getState().actions.reset()
    inventory?.revoke()
    await connect()
    const start = performance.now()
    const progress: Record<string, unknown>[] = []
    report.buffering = progress
    while (true) {
      const state = useSceneStore.getState()
      const snapshot = window.__EGOLENS_PERF__?.snapshot().scene
      progress.push({ ms: performance.now() - start, points: state.cachedFrames.length, cameras: state.cameraCachedFrames.length, snapshot })
      show(`Buffering: ${state.cachedFrames.length}/${state.totalFrames} point frames, ${state.cameraCachedFrames.length}/${state.totalFrames} camera frames`)
      if (state.cachedFrames.length === state.totalFrames && state.cameraCachedFrames.length === state.totalFrames) break
      if (performance.now() - start > 240000) throw new Error('Full-sequence buffering did not finish within four minutes')
      await sleep(1000)
    }
    const advances: { frame: number; at: number }[] = []
    let previous = useSceneStore.getState().currentFrameIndex
    const unsubscribe = useSceneStore.subscribe(state => {
      if (state.currentFrameIndex !== previous) { previous = state.currentFrameIndex; advances.push({ frame: previous, at: performance.now() }) }
    })
    useSceneStore.getState().actions.play()
    const playingAt = performance.now()
    while (useSceneStore.getState().isPlaying && performance.now() - playingAt < 30000) await sleep(50)
    useSceneStore.getState().actions.pause()
    unsubscribe()
    report.bufferedPlayback = { advances, elapsedMs: performance.now() - playingAt, finalFrame: useSceneStore.getState().currentFrameIndex }
    useSceneStore.getState().actions.reset()
    inventory?.revoke()
    await sleep(100)
    report.verificationDisposed = window.__EGOLENS_PERF__?.snapshot()
    show('Verification complete')
  } catch (error) { report.verificationError = String(error); show('Verification failed') }
  finally { useSceneStore.getState().actions.reset(); inventory?.revoke(); run.disabled = verify.disabled = parity.disabled = false }
}
async function digestValue(value: unknown): Promise<unknown> {
  if (typeof value === 'bigint') return ['bigint', String(value)]
  if (value === null || typeof value !== 'object') return value
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))
    return [value.constructor.name, bytes.byteLength, [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')]
  }
  if (Array.isArray(value)) return Promise.all(value.map(digestValue))
  if (value instanceof Map || value instanceof Set) return digestValue([...value])
  return Object.fromEntries(await Promise.all(Object.keys(value).sort().map(async key => [key, await digestValue((value as Record<string, unknown>)[key])])))
}
parity.onclick = async () => {
  run.disabled = verify.disabled = parity.disabled = true
  let inventory: Awaited<ReturnType<typeof openRemoteSourceInventoryV1>> | undefined
  let binding: Awaited<ReturnType<typeof bindRecipeSceneV1>> | undefined
  let worker: RecipeWorkerPlaybackV1 | undefined
  try {
    show('Preparing worker parity')
    inventory = await openRemoteSourceInventoryV1({ rootUrl: sample.rootUrl, catalogUrl: sample.catalogUrl, expectedCatalogHash: sample.catalogHash, preferFullObjects: true, limits: { maxTotalResponseBytes: sample.maxTotalResponseBytes } })
    const [match] = await teachableAuthoringSession.findSavedRecipes(inventory)
    if (!match) throw new Error('No matching sealed adapter')
    report.recipeHash = match.recipeHash
    binding = await bindRecipeSceneV1({ compiledRecipe: compileRecipeV1(match.artifact, bundledPhase2OperatorRegistry), source: inventory.resolveAuthorizedSource(), inventory })
    worker = new RecipeWorkerPlaybackV1(binding.scene, 512 * 1024 ** 2, 256 * 1024 ** 2)
    const matches: { frame: number; equal: boolean }[] = []
    report.workerParity = matches
    for (let index = 0; index < binding.scene.index.timestampsMicros.length; index++) {
      worker.focus(index)
      const request = { capabilities: binding.scene.manifest.capabilities }
      const actual = await digestValue(await worker.loadFrame(index, request))
      const expected = await digestValue(await binding.scene.loadFrame(index, request))
      const equal = JSON.stringify(actual) === JSON.stringify(expected)
      matches.push({ frame: index, equal })
      show(`Worker parity: ${index + 1}/80`)
      if (!equal) { report.parityMismatch = { index, actual, expected }; throw new Error(`Worker output differs at frame ${index}`) }
    }
    report.parityWorkers = worker.workerDiagnostics()
    worker.dispose(); binding.scene.dispose(); inventory.revoke()
    report.parityDisposed = worker.workerDiagnostics()
    show('Worker parity complete')
  } catch (error) { report.parityError = String(error); show('Worker parity failed') }
  finally { worker?.dispose(); binding?.scene.dispose(); inventory?.revoke(); run.disabled = verify.disabled = parity.disabled = false }
}
document.querySelector<HTMLButtonElement>('#save')!.onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = 'recipe-playback-benchmark.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
