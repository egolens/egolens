export interface WorkerPoolPerformanceSnapshotV1 {
  readonly workers: number
  readonly readyWorkers: number
  readonly queued: number
  readonly inFlight: number
  readonly requests: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  readonly staleResponses: number
  readonly terminated: boolean
}

export interface ScenePerformanceSnapshotV1 {
  readonly sceneGeneration: number
  readonly disposed: boolean
  readonly cache: {
    readonly pointBytes: number
    readonly pointPeakBytes: number
    readonly pointByteLimit: number
    readonly cameraBytes: number
    readonly cameraPeakBytes: number
    readonly cameraByteLimit: number
    readonly metadataFrames: number
    readonly metadataFrameLimit: number
    readonly pointFrames: number
    readonly cameraFrames: number
    readonly pointBatches: number
    readonly cameraBatches: number
  }
  readonly operations: {
    readonly pointBatchRequests: number
    readonly pointBatchLoads: number
    readonly pointBatchEvictions: number
    readonly cameraBatchRequests: number
    readonly cameraBatchLoads: number
    readonly cameraBatchEvictions: number
    readonly rowGroupFetches: number
    readonly rowGroupCacheHits: number
    readonly recentRowGroupKeys: readonly string[]
    readonly decompressions: number
    readonly cancellations: number
    readonly staleResponses: number
  }
  readonly workers: {
    readonly point: WorkerPoolPerformanceSnapshotV1 | null
    readonly camera: WorkerPoolPerformanceSnapshotV1 | null
  }
}

export interface EgoLensPerformanceSnapshotV1 {
  readonly schemaVersion: 1
  readonly timestampMs: number
  readonly scene: ScenePerformanceSnapshotV1 | null
  readonly lastDisposedScene: ScenePerformanceSnapshotV1 | null
  readonly resources: {
    readonly objectUrlsCreated: number
    readonly objectUrlsRevoked: number
    readonly liveObjectUrls: number
    readonly liveObjectUrlIds: readonly string[]
    readonly imageBitmapsCreated: number
    readonly imageBitmapsClosed: number
    readonly liveImageBitmaps: number
    readonly liveImageBitmapIds: readonly string[]
  }
  readonly renderer: {
    readonly textures: number
    readonly geometries: number
    readonly programs: number
    readonly materials: number
  }
  readonly marks: readonly { name: string; startTime: number; detail?: unknown }[]
}

export interface EgoLensPerformanceProbeV1 {
  readonly schemaVersion: 1
  snapshot(): EgoLensPerformanceSnapshotV1
}

interface RuntimeSnapshotProvider {
  snapshotPerformance(): ScenePerformanceSnapshotV1
}

declare global {
  interface Window {
    __EGOLENS_PERF__?: EgoLensPerformanceProbeV1
  }
}

let activeRuntime: RuntimeSnapshotProvider | null = null
let lastDisposedScene: ScenePerformanceSnapshotV1 | null = null
let objectUrlsCreated = 0
let objectUrlsRevoked = 0
let imageBitmapsCreated = 0
let imageBitmapsClosed = 0
let nextResourceId = 1
let nextMarkId = 1
const liveObjectUrls = new Map<string, string>()
const imageBitmapIds = new WeakMap<ImageBitmap, string>()
const liveImageBitmapIds = new Set<string>()
let renderer = { textures: 0, geometries: 0, programs: 0, materials: 0 }
const pendingFrameRequests = new Map<string, number>()
const renderedSceneGenerations = new Set<number>()

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function markEntries(): { name: string; startTime: number; detail?: unknown }[] {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return []
  return performance.getEntriesByType('mark')
    .filter((entry) => entry.name.startsWith('egolens:'))
    .slice(-256)
    .map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
      ...('detail' in entry ? { detail: (entry as PerformanceMark).detail } : {}),
    }))
}

export function performanceSnapshotV1(): EgoLensPerformanceSnapshotV1 {
  return {
    schemaVersion: 1,
    timestampMs: monotonicNow(),
    scene: activeRuntime?.snapshotPerformance() ?? null,
    lastDisposedScene,
    resources: {
      objectUrlsCreated,
      objectUrlsRevoked,
      liveObjectUrls: liveObjectUrls.size,
      liveObjectUrlIds: [...liveObjectUrls.values()],
      imageBitmapsCreated,
      imageBitmapsClosed,
      liveImageBitmaps: liveImageBitmapIds.size,
      liveImageBitmapIds: [...liveImageBitmapIds],
    },
    renderer: { ...renderer },
    marks: markEntries(),
  }
}

/** Install the read-only benchmark surface. Production enables it with `?perf=1`. */
export function installPerformanceProbe(force = false): void {
  if (typeof window === 'undefined') return
  const enabled = force
    || import.meta.env.DEV
    || new URLSearchParams(window.location.search).get('perf') === '1'
  if (!enabled || window.__EGOLENS_PERF__) return
  const probe: EgoLensPerformanceProbeV1 = Object.freeze({
    schemaVersion: 1,
    snapshot: performanceSnapshotV1,
  })
  Object.defineProperty(window, '__EGOLENS_PERF__', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: probe,
  })
}

export function registerPerformanceRuntime(provider: RuntimeSnapshotProvider): () => void {
  const sceneGeneration = provider.snapshotPerformance().sceneGeneration
  activeRuntime = provider
  return () => {
    if (activeRuntime === provider) {
      lastDisposedScene = provider.snapshotPerformance()
      activeRuntime = null
    }
    renderedSceneGenerations.delete(sceneGeneration)
    for (const key of pendingFrameRequests.keys()) {
      if (key.startsWith(`${sceneGeneration}:`)) pendingFrameRequests.delete(key)
    }
  }
}

export function markPerformanceEvent(name: string, detail?: Readonly<Record<string, unknown>>): void {
  if (typeof window !== 'undefined' && !window.__EGOLENS_PERF__) return
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    performance.mark(`egolens:${name}:${nextMarkId++}`, detail ? { detail } : undefined)
  } catch {
    performance.mark(`egolens:${name}:${nextMarkId++}`)
  }
}

export function noteFrameRequest(sceneGeneration: number, frameIndex: number): void {
  if (typeof window !== 'undefined' && !window.__EGOLENS_PERF__) return
  pendingFrameRequests.set(`${sceneGeneration}:${frameIndex}`, monotonicNow())
  while (pendingFrameRequests.size > 256) {
    const oldest = pendingFrameRequests.keys().next().value as string | undefined
    if (!oldest) break
    pendingFrameRequests.delete(oldest)
  }
}

/** Called from the R3F render loop, so "presented" means a real canvas frame. */
export function markRenderedFrame(sceneGeneration: number, frameIndex: number): void {
  if (typeof window !== 'undefined' && !window.__EGOLENS_PERF__) return
  const key = `${sceneGeneration}:${frameIndex}`
  const requestedAt = pendingFrameRequests.get(key)
  pendingFrameRequests.delete(key)
  if (requestedAt !== undefined) {
    markPerformanceEvent('frame-presented', {
      sceneGeneration,
      frameIndex,
      inputToFrameMs: monotonicNow() - requestedAt,
    })
  }
  if (!renderedSceneGenerations.has(sceneGeneration)) {
    renderedSceneGenerations.add(sceneGeneration)
    markPerformanceEvent('first-usable-frame', { sceneGeneration, frameIndex })
  }
}

export function currentPerformanceSceneGeneration(): number | null {
  return activeRuntime?.snapshotPerformance().sceneGeneration ?? null
}

/** Create an object URL while tracking only its string identity, never its Blob. */
export function createTrackedObjectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob)
  objectUrlsCreated += 1
  liveObjectUrls.set(url, `object-url-${nextResourceId++}`)
  return url
}

export function revokeTrackedObjectUrl(url: string): void {
  URL.revokeObjectURL(url)
  if (liveObjectUrls.delete(url)) objectUrlsRevoked += 1
}

export async function createTrackedImageBitmap(blob: ImageBitmapSource): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(blob)
  imageBitmapsCreated += 1
  const id = `image-bitmap-${nextResourceId++}`
  imageBitmapIds.set(bitmap, id)
  liveImageBitmapIds.add(id)
  return bitmap
}

export function closeTrackedImageBitmap(bitmap: ImageBitmap): void {
  bitmap.close()
  const id = imageBitmapIds.get(bitmap)
  if (id && liveImageBitmapIds.delete(id)) imageBitmapsClosed += 1
}

export function updateRendererPerformanceInfo(next: {
  readonly textures: number
  readonly geometries: number
  readonly programs: number
  readonly materials: number
}): void {
  renderer = { ...next }
}
