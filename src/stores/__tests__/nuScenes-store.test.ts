/**
 * Integration tests for nuScenes store loading pipeline.
 *
 * Verifies the full flow: loadFromFiles → recipe graph → selectSegment
 * → graph scene assembly → applyMetadataBundle → workers → frame cache.
 *
 * Workers are mocked to return synthetic point cloud / camera data.
 * The nuScenes JSON metadata is synthetic and retains the original table shape.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { tableFromArrays, tableToIPC } from '@uwdata/flechette'
import type { NuScenesFrameDescriptor } from '../../workers/nuScenesLidarWorker'
import type { NuScenesCameraFrameDescriptor } from '../../workers/nuScenesCameraWorker'

const workerInitPayloads = vi.hoisted(() => [] as Record<string, unknown>[])

interface MutableRecipeFixture {
  identity: { name: string }
  match: { inventory: { rootEntries: unknown[] } }
  sources: Record<string, { params?: unknown }>
  pipelines: Record<string, { nodes: Array<{ inputs?: Record<string, string> }> }>
}

// ---------------------------------------------------------------------------
// Mock WorkerPool — handles nuScenes init payloads (frameBatches + fileEntries)
// ---------------------------------------------------------------------------

vi.mock('../../workers/workerPool', () => ({
  WorkerPool: class MockNuScenesWorkerPool {
    private batches: unknown[][] = []
    private _isReady = false
    private isCamera = false

    constructor(public readonly concurrency: number, _workerFactory?: () => Worker) {}

    async init(opts: Record<string, unknown>) {
      workerInitPayloads.push(opts)
      if ('frameBatches' in opts) {
        this.batches = opts.frameBatches as unknown[][]
        this._isReady = true
        // Detect camera vs lidar: camera frame descriptors have 'images' array
        const firstFrame = this.batches[0]?.[0] as Record<string, unknown> | undefined
        if (firstFrame && 'images' in firstFrame) {
          this.isCamera = true
        }
        return { numBatches: this.batches.length }
      }
      // Waymo-style init (cameraUrl / lidarUrl) — not used here
      if ('cameraUrl' in opts) return { numBatches: 0 }
      return { numBatches: 0 }
    }

    async reinit(opts: Record<string, unknown>) { return this.init(opts) }
    isReady() { return this._isReady }

    async requestBatch(batchIndex: number) {
      const batch = this.batches[batchIndex]
      if (!batch) throw new Error(`Invalid batch: ${batchIndex}`)

      if (this.isCamera) {
        const frames = (batch as NuScenesCameraFrameDescriptor[]).map((frame) => ({
          timestamp: frame.timestamp,
          images: frame.images.map((img) => ({
            cameraName: img.cameraId,
            jpeg: new ArrayBuffer(100),
          })),
        }))
        return { type: 'batchReady' as const, requestId: 0, batchIndex, frames, totalMs: 1 }
      }

      // LiDAR: return 2 synthetic points per frame (x,y,z,intensity interleaved)
      const frames = (batch as NuScenesFrameDescriptor[]).map((frame) => ({
        timestamp: frame.timestamp,
        sensorClouds: [{
          laserName: 1,
          positions: new Float32Array([1, 2, 3, 0.5, 4, 5, 6, 0.8]),
          pointCount: 2,
        }],
        convertMs: 0.5,
      }))
      return { type: 'batchReady' as const, requestId: 0, batchIndex, frames, totalMs: 1 }
    }

    async requestRowGroup(batchIndex: number) { return this.requestBatch(batchIndex) }
    terminate() {}
  },
}))

// ---------------------------------------------------------------------------
// Imports (AFTER vi.mock)
// ---------------------------------------------------------------------------

import {
  createActiveConformanceScene,
  getActiveConformanceDescriptor,
  useSceneStore,
} from '../useSceneStore'
import { getManifest } from '../../adapters/registry'
import { argoverse2CompiledRecipe, nuScenesCompiledRecipe } from '../../adapters/recipes/bundled'
import { bundledPhase2OperatorRegistry } from '../../teachable/operators/bundledPhase2'
import { compileRecipeV1 } from '../../teachable/recipe/compiler'

// ---------------------------------------------------------------------------
// Synthetic nuScenes data factory
// ---------------------------------------------------------------------------

function createSyntheticNuScenesSegments(): Map<string, Map<string, File>> {
  const allFiles = new Map<string, File>()

  // JSON metadata tables
  const sensor = [
    { token: 'sensor_lidar', channel: 'LIDAR_TOP', modality: 'lidar' },
    { token: 'sensor_cam_front', channel: 'CAM_FRONT', modality: 'camera' },
  ]
  const calibratedSensor = [
    { token: 'cal_lidar', sensor_token: 'sensor_lidar', translation: [0, 0, 1.8], rotation: [1, 0, 0, 0], camera_intrinsic: [] },
    { token: 'cal_cam_front', sensor_token: 'sensor_cam_front', translation: [1.5, 0, 1.5], rotation: [0.5, -0.5, 0.5, -0.5], camera_intrinsic: [[1266, 0, 816], [0, 1266, 491], [0, 0, 1]] },
  ]
  const category = [
    { token: 'cat_car', name: 'vehicle.car', description: 'Car', index: 0 },
    { token: 'cat_ped', name: 'human.pedestrian.adult', description: 'Adult pedestrian', index: 1 },
  ]
  const instance = [
    { token: 'inst_car1', category_token: 'cat_car', nbr_annotations: 2, first_annotation_token: 'ann1', last_annotation_token: 'ann3' },
    { token: 'inst_ped1', category_token: 'cat_ped', nbr_annotations: 2, first_annotation_token: 'ann2', last_annotation_token: 'ann4' },
  ]
  const scene = [
    { token: 'scene_1', log_token: 'log_1', nbr_samples: 2, first_sample_token: 'sample_1', last_sample_token: 'sample_2', name: 'scene-0001', description: 'Test scene 1' },
    { token: 'scene_2', log_token: 'log_1', nbr_samples: 1, first_sample_token: 'sample_3', last_sample_token: 'sample_3', name: 'scene-0002', description: 'Test scene 2' },
  ]
  const sample = [
    { token: 'sample_1', timestamp: 1000000, prev: '', next: 'sample_2', scene_token: 'scene_1' },
    { token: 'sample_2', timestamp: 1500000, prev: 'sample_1', next: '', scene_token: 'scene_1' },
    { token: 'sample_3', timestamp: 2000000, prev: '', next: '', scene_token: 'scene_2' },
  ]
  const egoPose = [
    { token: 'ego_1_lidar', timestamp: 1000000, rotation: [1, 0, 0, 0], translation: [0, 0, 0] },
    { token: 'ego_1_cam', timestamp: 1000050, rotation: [1, 0, 0, 0], translation: [0.1, 0, 0] },
    { token: 'ego_2_lidar', timestamp: 1500000, rotation: [1, 0, 0, 0], translation: [5, 0, 0] },
    { token: 'ego_2_cam', timestamp: 1500050, rotation: [1, 0, 0, 0], translation: [5.1, 0, 0] },
    { token: 'ego_3_lidar', timestamp: 2000000, rotation: [1, 0, 0, 0], translation: [10, 0, 0] },
    { token: 'ego_3_cam', timestamp: 2000050, rotation: [1, 0, 0, 0], translation: [10.1, 0, 0] },
  ]
  const sampleData = [
    { token: 'sd_1_lidar', sample_token: 'sample_1', ego_pose_token: 'ego_1_lidar', calibrated_sensor_token: 'cal_lidar', timestamp: 1000000, fileformat: 'pcd.bin', is_key_frame: true, height: 0, width: 0, filename: 'samples/LIDAR_TOP/frame1.pcd.bin', prev: '', next: 'sd_2_lidar' },
    { token: 'sd_1_cam', sample_token: 'sample_1', ego_pose_token: 'ego_1_cam', calibrated_sensor_token: 'cal_cam_front', timestamp: 1000050, fileformat: 'jpg', is_key_frame: true, height: 900, width: 1600, filename: 'samples/CAM_FRONT/frame1.jpg', prev: '', next: 'sd_2_cam' },
    { token: 'sd_2_lidar', sample_token: 'sample_2', ego_pose_token: 'ego_2_lidar', calibrated_sensor_token: 'cal_lidar', timestamp: 1500000, fileformat: 'pcd.bin', is_key_frame: true, height: 0, width: 0, filename: 'samples/LIDAR_TOP/frame2.pcd.bin', prev: 'sd_1_lidar', next: '' },
    { token: 'sd_2_cam', sample_token: 'sample_2', ego_pose_token: 'ego_2_cam', calibrated_sensor_token: 'cal_cam_front', timestamp: 1500050, fileformat: 'jpg', is_key_frame: true, height: 900, width: 1600, filename: 'samples/CAM_FRONT/frame2.jpg', prev: 'sd_1_cam', next: '' },
    { token: 'sd_3_lidar', sample_token: 'sample_3', ego_pose_token: 'ego_3_lidar', calibrated_sensor_token: 'cal_lidar', timestamp: 2000000, fileformat: 'pcd.bin', is_key_frame: true, height: 0, width: 0, filename: 'samples/LIDAR_TOP/frame3.pcd.bin', prev: '', next: '' },
    { token: 'sd_3_cam', sample_token: 'sample_3', ego_pose_token: 'ego_3_cam', calibrated_sensor_token: 'cal_cam_front', timestamp: 2000050, fileformat: 'jpg', is_key_frame: true, height: 900, width: 1600, filename: 'samples/CAM_FRONT/frame3.jpg', prev: '', next: '' },
  ]
  const sampleAnnotation = [
    { token: 'ann1', sample_token: 'sample_1', instance_token: 'inst_car1', visibility_token: '4', attribute_tokens: [], translation: [10, 5, 0], size: [2, 4.5, 1.5], rotation: [1, 0, 0, 0], prev: '', next: 'ann3', num_lidar_pts: 50, num_radar_pts: 0 },
    { token: 'ann2', sample_token: 'sample_1', instance_token: 'inst_ped1', visibility_token: '3', attribute_tokens: [], translation: [3, 2, 0], size: [0.6, 0.7, 1.7], rotation: [1, 0, 0, 0], prev: '', next: 'ann4', num_lidar_pts: 10, num_radar_pts: 0 },
    { token: 'ann3', sample_token: 'sample_2', instance_token: 'inst_car1', visibility_token: '4', attribute_tokens: [], translation: [12, 5, 0], size: [2, 4.5, 1.5], rotation: [1, 0, 0, 0], prev: 'ann1', next: '', num_lidar_pts: 45, num_radar_pts: 0 },
    { token: 'ann4', sample_token: 'sample_2', instance_token: 'inst_ped1', visibility_token: '2', attribute_tokens: [], translation: [4, 2, 0], size: [0.6, 0.7, 1.7], rotation: [1, 0, 0, 0], prev: 'ann2', next: '', num_lidar_pts: 8, num_radar_pts: 0 },
    { token: 'ann5', sample_token: 'sample_3', instance_token: 'inst_car1', visibility_token: '4', attribute_tokens: [], translation: [15, 5, 0], size: [2, 4.5, 1.5], rotation: [1, 0, 0, 0], prev: '', next: '', num_lidar_pts: 40, num_radar_pts: 0 },
  ]

  const jsonData: Record<string, unknown[]> = {
    'sensor.json': sensor,
    'calibrated_sensor.json': calibratedSensor,
    'category.json': category,
    'instance.json': instance,
    'scene.json': scene,
    'sample.json': sample,
    'ego_pose.json': egoPose,
    'sample_data.json': sampleData,
    'sample_annotation.json': sampleAnnotation,
    'visibility.json': [],
    'attribute.json': [],
    'log.json': [],
    'map.json': [],
  }

  for (const [name, data] of Object.entries(jsonData)) {
    allFiles.set(name, new File([JSON.stringify(data)], name, { type: 'application/json' }))
  }

  // Fake sample data files (workers are mocked — content doesn't matter)
  const sampleFileNames = [
    'samples/LIDAR_TOP/frame1.pcd.bin',
    'samples/LIDAR_TOP/frame2.pcd.bin',
    'samples/LIDAR_TOP/frame3.pcd.bin',
    'samples/CAM_FRONT/frame1.jpg',
    'samples/CAM_FRONT/frame2.jpg',
    'samples/CAM_FRONT/frame3.jpg',
  ]
  for (const name of sampleFileNames) {
    allFiles.set(name, new File([new ArrayBuffer(10)], name.split('/').pop()!))
  }

  // Wrap in sentinel key format (same as folderScan produces)
  return new Map([['__nuscenes__', allFiles]])
}

function feather(columns: Record<string, unknown>): ArrayBuffer {
  const bytes = tableToIPC(tableFromArrays(columns as never))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function createSyntheticAV2Segments(): Map<string, Map<string, File>> {
  const timestamp = 1_000_000n
  const files = new Map<string, File>([
    ['__logId__', new File([], 'av2-log')],
    [`sensors/lidar/${timestamp}.feather`, new File([feather({
      x: new Float64Array([1, 2]), y: new Float64Array([3, 4]),
      z: new Float64Array([5, 6]), intensity: new Uint8Array([7, 8]),
    })], `${timestamp}.feather`)],
    ['city_SE3_egovehicle.feather', new File([feather({
      timestamp_ns: new BigInt64Array([timestamp]), qw: new Float64Array([1]),
      qx: new Float64Array([0]), qy: new Float64Array([0]), qz: new Float64Array([0]),
      tx_m: new Float64Array([0]), ty_m: new Float64Array([0]), tz_m: new Float64Array([0]),
    })], 'city_SE3_egovehicle.feather')],
    ['calibration/egovehicle_SE3_sensor.feather', new File([feather({
      sensor_name: ['ring_front_center'], qw: new Float64Array([0.5]),
      qx: new Float64Array([-0.5]), qy: new Float64Array([0.5]), qz: new Float64Array([-0.5]),
      tx_m: new Float64Array([0]), ty_m: new Float64Array([0]), tz_m: new Float64Array([0]),
    })], 'egovehicle_SE3_sensor.feather')],
    ['calibration/intrinsics.feather', new File([feather({
      sensor_name: ['ring_front_center'], fx_px: new Float64Array([100]),
      fy_px: new Float64Array([100]), cx_px: new Float64Array([50]), cy_px: new Float64Array([50]),
      k1: new Float64Array([0]), k2: new Float64Array([0]), k3: new Float64Array([0]),
      height_px: new Uint16Array([100]), width_px: new Uint16Array([100]),
    })], 'intrinsics.feather')],
    ['sensors/cameras/ring_front_center/1000100.jpg', new File([
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ], '1000100.jpg')],
    ['annotations.feather', new File([feather({
      timestamp_ns: new BigInt64Array([timestamp]), category: ['REGULAR_VEHICLE'],
      track_uuid: ['track'], qw: new Float64Array([1]), qx: new Float64Array([0]),
      qy: new Float64Array([0]), qz: new Float64Array([0]), tx_m: new Float64Array([10]),
      ty_m: new Float64Array([0]), tz_m: new Float64Array([0]), length_m: new Float64Array([4]),
      width_m: new Float64Array([2]), height_m: new Float64Array([2]),
    })], 'annotations.feather')],
  ])
  return new Map([['__argoverse2__', files]])
}

function installClassicRemoteFetch(files: ReadonlyMap<string, File>, baseUrl: string) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    calls.push(`${method} ${url}`)
    if (url === `${base}index.json`) return new Response(null, { status: 404 })
    const prefix = `${base}v1.0-mini/`
    if (!url.startsWith(prefix)) return new Response(null, { status: 404 })
    const name = url.slice(prefix.length)
    const file = files.get(name)
    if (!file) return new Response(null, { status: 404 })
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(file.size) },
      })
    }
    return new Response(await file.arrayBuffer(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const state = () => useSceneStore.getState()
const actions = () => state().actions

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nuScenes store integration', () => {
  afterEach(() => {
    actions().reset()
    vi.unstubAllGlobals()
  })

  describe('loadFromFiles with nuScenes sentinel', () => {
    it('detects nuScenes and discovers scenes', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      // Should have discovered 2 scenes
      expect(state().availableSegments).toEqual(['scene-0001', 'scene-0002'])
    }, 10000)

    it('sets active manifest to nuScenes', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      expect(getManifest().id).toBe('nuscenes')
      expect(getManifest().name).toBe('nuScenes')
    }, 10000)

    it('auto-selects first scene and loads to ready', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      expect(state().status).toBe('ready')
      expect(state().currentSegment).toBe('scene-0001')
      expect(state().loadProgress).toBe(1)
      expect(state().error).toBeNull()
    }, 10000)

    it('loads correct frame count for scene-0001 (2 frames)', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      expect(state().totalFrames).toBe(2)
    }, 10000)

    it('loads lidar calibration (1 LIDAR_TOP)', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      expect(state().lidarCalibrations.size).toBe(1)
      expect(state().lidarCalibrations.has(1)).toBe(true) // LIDAR_TOP → id 1
    }, 10000)

    it('loads camera calibration (1 CAM_FRONT)', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      expect(state().cameraCalibrations).toHaveLength(1)
      expect(state().cameraCalibrations[0]['key.camera_name']).toBe(2) // CAM_FRONT → id 2
    }, 10000)

    it('has box data', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      expect(state().hasBoxData).toBe(true)
    }, 10000)
  })

  describe('a failed local load surfaces as an error, not a hung load', () => {
    // The drop zone is only rendered while status is 'idle', and local loading
    // flips status to 'loading' before it parses anything. A throw that escaped
    // left the store in 'loading' with no error and no drop zone — a skeleton
    // the user could not get out of without reloading the page.
    const corrupt = (file: string) => {
      const segments = createSyntheticNuScenesSegments()
      segments.get('__nuscenes__')!.set(file, new File(['{ not json'], file, { type: 'application/json' }))
      return segments
    }

    it('lands in error, never in loading, when a metadata table is unparseable', async () => {
      await expect(actions().loadFromFiles(corrupt('scene.json'))).resolves.toBeUndefined()

      expect(state().status).toBe('error')
      expect(state().error).toBeTruthy()
    }, 10000)

    it('reports the failure with a classified code so telemetry can read it', async () => {
      await actions().loadFromFiles(corrupt('sample_data.json'))

      expect(state().status).toBe('error')
      expect(state().errorCode).toBeTruthy()
    }, 10000)

    it('leaves the store recoverable — a good folder still loads afterwards', async () => {
      await actions().loadFromFiles(corrupt('scene.json'))
      expect(state().status).toBe('error')

      await actions().loadFromFiles(createSyntheticNuScenesSegments())

      expect(state().status).toBe('ready')
      expect(state().availableSegments).toEqual(['scene-0001', 'scene-0002'])
    }, 15000)
  })

  describe('first frame (auto-loaded)', () => {
    it('starts at frame 0 with point cloud data', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      expect(state().currentFrameIndex).toBe(0)
      expect(state().currentFrame).not.toBeNull()
      const clouds = state().currentFrame!.sensorClouds
      expect(clouds.size).toBeGreaterThan(0)
      // Mock returns 2 points per frame for LIDAR_TOP
      expect(clouds.get(1)?.pointCount).toBe(2)
    }, 10000)

    it('has bounding boxes from annotations', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      // Frame 0 (sample_1): 2 annotations (car + pedestrian)
      expect(state().currentFrame!.boxes.length).toBe(2)
    }, 10000)

    it('has vehicle pose from poseByFrameIndex', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      // nuScenes: pose comes from poseByFrameIndex (not vehiclePoseByFrame Parquet column)
      expect(state().currentFrame!.vehiclePose).not.toBeNull()
      expect(state().currentFrame!.vehiclePose).toHaveLength(16)
    }, 10000)

    it('has camera images', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      const camImages = state().currentFrame!.cameraImages
      expect(camImages.size).toBeGreaterThan(0)
      // Mock returns 100-byte ArrayBuffer for each camera
      expect(camImages.get(2)?.byteLength).toBe(100) // CAM_FRONT → id 2
    }, 10000)
  })

  describe('scene switching', () => {
    it('keeps a fresh Phase 9 author recipe on the managed scene and every reload', async () => {
      const authored = structuredClone(nuScenesCompiledRecipe.recipe) as unknown as MutableRecipeFixture
      authored.identity.name = 'Fresh Phase 9 nuScenes recipe'
      authored.match.inventory.rootEntries.reverse()
      authored.sources.blindAuthoredSamples = authored.sources.samples
      delete authored.sources.samples
      for (const pipeline of Object.values(authored.pipelines)) {
        for (const node of pipeline.nodes) {
          for (const [name, value] of Object.entries(node.inputs ?? {})) {
            if (typeof value === 'string' && value.startsWith('samples.')) {
              node.inputs[name] = `blindAuthoredSamples.${value.slice('samples.'.length)}`
            }
          }
        }
      }
      const compiled = compileRecipeV1(authored as never, bundledPhase2OperatorRegistry)

      await actions().loadFromFiles(createSyntheticNuScenesSegments(), compiled)
      expect(getManifest().name).toBe('Fresh Phase 9 nuScenes recipe')
      expect(getActiveConformanceDescriptor()).toMatchObject({ datasetId: 'nuscenes', frameCount: 2 })

      await actions().selectSegment('scene-0002')
      expect(getManifest().name).toBe('Fresh Phase 9 nuScenes recipe')
      expect(getActiveConformanceDescriptor()).toMatchObject({ datasetId: 'nuscenes', frameCount: 1 })
      const reloaded = await createActiveConformanceScene()
      expect(reloaded.index.segments).toMatchObject([{ id: 'scene-0002', frameCount: 1 }])
      reloaded.dispose()
    }, 15000)

    it('can switch to scene-0002', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      // Currently on scene-0001 (2 frames)
      expect(state().totalFrames).toBe(2)

      // Switch to scene-0002 (1 frame)
      await actions().selectSegment('scene-0002')
      expect(state().currentSegment).toBe('scene-0002')
      expect(state().totalFrames).toBe(1)
      expect(state().status).toBe('ready')
    }, 15000)

    it('preserves available segments across scene switches', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)
      await actions().selectSegment('scene-0002')

      expect(state().availableSegments).toEqual(['scene-0001', 'scene-0002'])
    }, 15000)

    it('scene-0002 has correct box data (1 annotation)', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)
      await actions().selectSegment('scene-0002')

      expect(state().currentFrame!.boxes.length).toBe(1)
    }, 15000)
  })

  describe('frame navigation', () => {
    it('nextFrame advances to frame 1', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      await actions().nextFrame()
      expect(state().currentFrameIndex).toBe(1)
      expect(state().currentFrame?.sensorClouds.size).toBeGreaterThan(0)
    }, 10000)

    it('prevFrame goes back to frame 0', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      await actions().nextFrame()
      await actions().prevFrame()
      expect(state().currentFrameIndex).toBe(0)
    }, 10000)
  })

  describe('playback controls (shared logic, nuScenes context)', () => {
    it('play/pause toggles', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      // loadFromFiles auto-plays, so pause first
      actions().pause()
      expect(state().isPlaying).toBe(false)
      actions().play()
      expect(state().isPlaying).toBe(true)
      actions().pause()
    }, 10000)
  })

  describe('reset', () => {
    it('returns to idle after nuScenes load', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)
      expect(state().status).toBe('ready')

      actions().reset()
      expect(state().status).toBe('idle')
      expect(state().totalFrames).toBe(0)
      expect(state().currentFrame).toBeNull()
    }, 10000)
  })

  describe('segment metadata', () => {
    it('stores segment meta for loaded scene', async () => {
      const segments = createSyntheticNuScenesSegments()
      await actions().loadFromFiles(segments)

      const meta = state().segmentMetas.get('scene-0001')
      expect(meta).toBeDefined()
      expect(meta!.segmentId).toBe('scene-0001')
    }, 10000)
  })

  describe('isolated conformance', () => {
    it('re-executes the same raw-source graph without prepared database state', async () => {
      await actions().loadFromFiles(createSyntheticNuScenesSegments())

      expect(getActiveConformanceDescriptor()).toMatchObject({
        datasetId: 'nuscenes', frameCount: 2,
      })
      const scene = await createActiveConformanceScene()
      expect(scene.index.timestampsMicros).toEqual([1_000_000n, 1_500_000n])
      expect(scene.index.segments).toMatchObject([{ id: 'scene-0001', frameCount: 2 }])
      scene.dispose()
    }, 10000)
  })

  describe('Argoverse 2 counted external recipe', () => {
    it('keeps renamed author sources on the managed scene, worker, conformance, and reload paths', async () => {
      const authored = structuredClone(argoverse2CompiledRecipe.recipe) as unknown as MutableRecipeFixture
      authored.identity.name = 'Fresh Phase 9 Argoverse 2 recipe'
      const lidarParams = authored.sources.lidarFrames.params as { columns: Array<{ name: string; type: string }> }
      for (const column of lidarParams.columns) {
        if (column.name === 'x' || column.name === 'y' || column.name === 'z') column.type = 'float64'
      }
      authored.sources.blindAuthoredLidarFrames = authored.sources.lidarFrames
      delete authored.sources.lidarFrames
      for (const pipeline of Object.values(authored.pipelines)) {
        for (const node of pipeline.nodes) {
          for (const [name, value] of Object.entries(node.inputs ?? {})) {
            if (typeof value === 'string' && value.startsWith('lidarFrames.')) {
              node.inputs[name] = `blindAuthoredLidarFrames.${value.slice('lidarFrames.'.length)}`
            }
          }
        }
      }
      const compiled = compileRecipeV1(authored as never, bundledPhase2OperatorRegistry)
      workerInitPayloads.length = 0

      await actions().loadFromFiles(createSyntheticAV2Segments(), compiled)
      expect(state()).toMatchObject({ status: 'ready', currentSegment: 'av2-log', totalFrames: 1 })
      expect(getManifest().name).toBe('Fresh Phase 9 Argoverse 2 recipe')
      expect(workerInitPayloads.find((payload) => 'readerParams' in payload)?.readerParams)
        .toEqual(authored.sources.blindAuthoredLidarFrames.params)
      const conformance = await createActiveConformanceScene()
      expect(conformance.manifest.name).toBe('Fresh Phase 9 Argoverse 2 recipe')
      conformance.dispose()

      await actions().selectSegment('av2-log')
      expect(getManifest().name).toBe('Fresh Phase 9 Argoverse 2 recipe')
      expect(getActiveConformanceDescriptor()).toMatchObject({ datasetId: 'argoverse2', frameCount: 1 })
    }, 15000)
  })

  describe('classic URL source', () => {
    it('discovers and loads scenes through the same cached raw-source graph', async () => {
      const files = createSyntheticNuScenesSegments().get('__nuscenes__')!
      const baseUrl = 'https://example.test/nuscenes'
      const calls = installClassicRemoteFetch(files, baseUrl)
      vi.stubGlobal('window', {
        location: { search: '', pathname: '/', origin: 'https://app.example.test' },
        history: { pushState: vi.fn(), replaceState: vi.fn() },
      })
      vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
      })

      await actions().loadFromUrl('nuscenes', baseUrl)

      expect(state()).toMatchObject({
        status: 'ready', currentSegment: 'scene-0001', availableSegments: ['scene-0001', 'scene-0002'],
      })
      expect(calls.filter((call) => call === `GET ${baseUrl}/v1.0-mini/sample.json`)).toHaveLength(1)
    }, 10000)
  })
})
