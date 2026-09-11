import { assembleGraphSceneV1 } from '../teachable/runtime/GraphSceneAssembler'
import { compileRecipeV1 } from '../teachable/recipe/compiler'
import { bundledPhase2OperatorRegistry } from '../teachable/operators/bundledPhase2'
import { GraphResourceAccountV1, type CoreOperatorExecutionContextV1 } from '../teachable/runtime/GraphValues'
import { releaseGraphValue, type GraphExecutionResultV1 } from '../teachable/runtime/GraphKernel'
import { mapRecipeWorkerGraphV1, frameTransferBuffersV1 } from '../teachable/runtime/recipeWorkerPlan'
import { PayloadCacheV1 } from '../teachable/runtime/PayloadCache'
import { ReadSchedulerV1 } from '../teachable/runtime/ReadScheduler'
import type { NormalizedCapabilityV1, NormalizedSceneV1 } from '../teachable/runtime/normalizedScene'
import type { ByteSourceV1 } from '../teachable/source/ByteSource'
import type { EgoLensAdapterRecipeV1 } from '../teachable/recipe/types'
import { FILE_FRAME_BATCH_SIZE } from './playbackConfig'

declare const self: { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent) => void) | null }

let scene: NormalizedSceneV1
let context: CoreOperatorExecutionContextV1
let lane: 'point' | 'camera'
let nextRead = 0
let activeFrame = 0
let batchController: AbortController | undefined
const pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>()
const lifecycle = new AbortController()
const reads = new ReadSchedulerV1(1)

function requestRead(path: string, start?: number, end?: number, signal = lifecycle.signal): Promise<ArrayBuffer> {
  return reads.read(JSON.stringify([path, start, end]), async readSignal => new Promise((resolve, reject) => {
    const id = nextRead++
    const cancel = () => { pending.delete(id); self.postMessage({ type: 'recipeReadCancel', id }); reject(new DOMException('Read cancelled', 'AbortError')) }
    readSignal.addEventListener('abort', cancel, { once: true })
    pending.set(id, { resolve: bytes => { readSignal.removeEventListener('abort', cancel); resolve(bytes) }, reject: error => { readSignal.removeEventListener('abort', cancel); reject(error) } })
    self.postMessage({ type: 'recipeRead', id, path, start, end, frameIndex: activeFrame })
  }), signal)
}

self.onmessage = async ({ data: message }) => {
  if (message.type === 'yieldBatch') { batchController?.abort(); return }
  if (message.type === 'recipeReadResult') {
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) request?.reject(new Error(message.error))
    else request?.resolve(message.bytes)
    return
  }
  try {
    if (message.type === 'init') {
      lane = message.lane
      const files = new Map<string, number | null>(message.inventory.map((entry: { path: string; size?: number | null }) => [entry.path, entry.size ?? null]))
      const source: ByteSourceV1 = {
        has: path => files.has(path), byteLength: path => files.get(path) ?? null,
        async read(path, options) { return requestRead(path, options?.start, options?.end, options?.signal) },
        async asyncBuffer(path) {
          const byteLength = files.get(path)
          if (byteLength == null) throw new Error(`RECIPE_WORKER_SOURCE_SIZE_REQUIRED: ${path}`)
          return { byteLength, slice: (start, end) => requestRead(path, start, end) }
        },
      }
      const resources = new GraphResourceAccountV1({ maxNodes: 10000, maxSourceBytes: 1024 ** 3, maxAllocationBytes: 512 * 1024 ** 2 })
      const decodedPayloads = new PayloadCacheV1<object, true>(message.decodedCacheBytes)
      context = {
        signal: lifecycle.signal, source, resources, decodedPayloads,
        throwIfAborted() { if (lifecycle.signal.aborted) throw new DOMException('Worker disposed', 'AbortError') },
        async read(path, signal) {
          if (signal?.aborted) throw new DOMException('Frame cancelled', 'AbortError')
          const bytes = await source.read(path, { signal }); resources.sourceBytes(bytes.byteLength); return bytes
        },
        async asyncBuffer(path) { return source.asyncBuffer(path) },
      }
      const outputs = mapRecipeWorkerGraphV1(message.outputs, context) as GraphExecutionResultV1['outputs']
      const graph: GraphExecutionResultV1 = {
        outputs, abortController: lifecycle,
        get resources() { return resources.snapshot() },
        dispose() { lifecycle.abort(); reads.dispose(); decodedPayloads.clear(); releaseGraphValue(outputs, new WeakSet()) },
      }
      scene = assembleGraphSceneV1({
        compiledRecipe: compileRecipeV1(message.recipe as EgoLensAdapterRecipeV1, bundledPhase2OperatorRegistry),
        graph, sceneId: message.sceneId,
      }).scene
      self.postMessage({ type: 'ready', numBatches: Math.ceil(scene.index.timestampsMicros.length / FILE_FRAME_BATCH_SIZE) })
    } else if (message.type === 'loadBatch') {
      batchController = new AbortController()
      const capabilities = lane === 'camera' ? new Set<NormalizedCapabilityV1>(['cameraImages'])
        : new Set([...scene.manifest.capabilities].filter(capability => capability !== 'cameraImages'))
      const end = Math.min((message.batchIndex + 1) * FILE_FRAME_BATCH_SIZE, scene.index.timestampsMicros.length)
      for (let index = message.batchIndex * FILE_FRAME_BATCH_SIZE; index < end; index++) {
        activeFrame = index
        const frame = structuredClone(await scene.loadFrame(index, { capabilities, signal: batchController.signal }))
        self.postMessage({ type: 'recipeFrame', requestId: message.requestId, batchIndex: message.batchIndex, frame,
          resources: context.resources.snapshot(), decodedCacheBytes: context.decodedPayloads?.bytes }, frameTransferBuffersV1(frame))
      }
      self.postMessage({ type: 'batchReady', requestId: message.requestId, batchIndex: message.batchIndex })
    }
  } catch (error) {
    self.postMessage({ type: batchController?.signal.aborted ? 'batchYielded' : 'error', requestId: message.requestId, message: error instanceof Error ? error.message : String(error) })
  }
}
