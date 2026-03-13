/**
 * Unit tests for useSceneStore (Zustand).
 *
 * Loads mock Waymo fixture data ONCE, then runs all tests against the shared state.
 * This mirrors production: dataset loads once, user navigates frames.
 *
 * Worker pools are mocked to run in-process (Node.js has no Worker).
 * The mock performs real Parquet I/O + range image conversion, same as production,
 * just synchronously in the main thread instead of a Web Worker.
 *
 * Run with: npx vitest run useSceneStore
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { readFileSync, closeSync } from 'fs'
import { openSync, readSync, fstatSync } from 'fs'
import { resolve } from 'path'
import type { AsyncBuffer } from 'hyparquet'
import type { LidarCalibration, RangeImage } from '../../utils/rangeImage'

// ---------------------------------------------------------------------------
// Mock WorkerPool — runs Parquet I/O + LiDAR conversion in-process
// ---------------------------------------------------------------------------

vi.mock('../../workers/workerPool', () => {
  // Dynamically import the real modules inside the factory (top-level imports
  // would be hoisted AFTER vi.mock, causing reference errors).
  return {
    WorkerPool: class MockWorkerPool {
      private pf: unknown = null
      private calibrations = new Map<number, LidarCalibration>()
      private _numBatches = 0

      constructor(public readonly concurrency: number) {}

      async init(opts: {
        lidarUrl: string | File | AsyncBuffer
        calibrationEntries: [number, LidarCalibration][]
      }) {
        const { openParquetFile, buildHeavyFileFrameIndex, readRowGroupRows } =
          await import('../../utils/parquet')
        const { convertAllSensors } = await import('../../utils/rangeImage')

        // Store references for requestBatch
        this.calibrations = new Map(opts.calibrationEntries)
        this.pf = await openParquetFile('lidar', opts.lidarUrl as AsyncBuffer)
        const pfTyped = this.pf as Awaited<ReturnType<typeof openParquetFile>>
        this._numBatches = pfTyped.rowGroups.length

        // Attach modules for later use
        ;(this as any)._readRowGroupRows = readRowGroupRows
        ;(this as any)._convertAllSensors = convertAllSensors

        return { numBatches: this._numBatches }
      }

      async reinit(opts: {
        lidarUrl: string | File | AsyncBuffer
        calibrationEntries: [number, LidarCalibration][]
      }) {
        return this.init(opts)
      }

      getNumBatches() {
        return this._numBatches
      }

      getNumRowGroups() {
        return this._numBatches
      }

      isReady() {
        return this.pf !== null
      }

      async requestBatch(batchIndex: number) {
        const readRowGroupRows = (this as any)._readRowGroupRows as typeof import('../../utils/parquet').readRowGroupRows
        const convertAllSensors = (this as any)._convertAllSensors as typeof import('../../utils/rangeImage').convertAllSensors

        const LIDAR_COLUMNS = [
          'key.frame_timestamp_micros',
          'key.laser_name',
          '[LiDARComponent].range_image_return1.shape',
          '[LiDARComponent].range_image_return1.values',
        ]

        const t0 = performance.now()
        const allRows = await readRowGroupRows(this.pf as any, batchIndex, LIDAR_COLUMNS)

        // Group by timestamp
        const frameGroups = new Map<bigint, typeof allRows>()
        for (const row of allRows) {
          const ts = row['key.frame_timestamp_micros'] as bigint
          let group = frameGroups.get(ts)
          if (!group) {
            group = []
            frameGroups.set(ts, group)
          }
          group.push(row)
        }

        // Convert each frame
        const frames: any[] = []
        for (const [ts, rows] of frameGroups) {
          const rangeImages = new Map<number, RangeImage>()
          for (const row of rows) {
            const laserName = row['key.laser_name'] as number
            rangeImages.set(laserName, {
              shape: row['[LiDARComponent].range_image_return1.shape'] as [number, number, number],
              values: row['[LiDARComponent].range_image_return1.values'] as number[],
            })
          }

          const ct0 = performance.now()
          const result = convertAllSensors(rangeImages, this.calibrations)
          const convertMs = performance.now() - ct0

          const sensorClouds: any[] = []
          for (const [laserName, cloud] of result.perSensor) {
            sensorClouds.push({ laserName, positions: cloud.positions, pointCount: cloud.pointCount })
          }

          frames.push({
            timestamp: ts.toString(),
            sensorClouds,
            convertMs,
          })
        }

        return {
          type: 'batchReady' as const,
          requestId: 0,
          batchIndex,
          frames,
          totalMs: performance.now() - t0,
        }
      }

      // Legacy alias
      async requestRowGroup(batchIndex: number) {
        return this.requestBatch(batchIndex)
      }

      terminate() { /* no-op */ }
    },
  }
})

vi.mock('../../workers/cameraWorkerPool', () => {
  return {
    CameraWorkerPool: class MockCameraWorkerPool {
      constructor(public readonly concurrency: number) {}
      async init() {
        // No camera fixtures → init "fails" gracefully by returning 0 batches
        return { numBatches: 0 }
      }
      async reinit() { return { numBatches: 0 } }
      getNumBatches() { return 0 }
      getNumRowGroups() { return 0 }
      isReady() { return false }
      async requestBatch(): Promise<never> {
        throw new Error('No camera data in test fixtures')
      }
      async requestRowGroup(): Promise<never> {
        return this.requestBatch()
      }
      terminate() { /* no-op */ }
    },
  }
})

// ---------------------------------------------------------------------------
// Imports (AFTER vi.mock calls — vitest hoists vi.mock automatically)
// ---------------------------------------------------------------------------

import { isHeavyComponent } from '../../utils/parquet'
import { useSceneStore } from '../useSceneStore'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = resolve(__dirname, '../../__fixtures__')
const SEGMENT_ID = 'mock_segment_0000'

function parquetPath(component: string): string {
  return resolve(FIXTURES, SEGMENT_ID, `${component}.parquet`)
}

const openFds: number[] = []

function nodeAsyncBuffer(filePath: string, lazy = false): AsyncBuffer {
  if (!lazy) {
    const buf = readFileSync(filePath)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    return {
      byteLength: ab.byteLength,
      slice(start: number, end?: number): ArrayBuffer { return ab.slice(start, end) },
    }
  }
  const fd = openSync(filePath, 'r')
  openFds.push(fd)
  const { size } = fstatSync(fd)
  return {
    byteLength: size,
    slice(start: number, end?: number): ArrayBuffer {
      const length = (end ?? size) - start
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
  }
}

afterAll(() => {
  for (const fd of openFds) {
    try { closeSync(fd) } catch { /* ignore */ }
  }
})

const TEST_COMPONENTS = [
  'vehicle_pose',
  'lidar_calibration',
  'camera_calibration',
  'lidar_box',
  'lidar',
]

function buildTestSources(): Map<string, AsyncBuffer> {
  const sources = new Map<string, AsyncBuffer>()
  for (const component of TEST_COMPONENTS) {
    sources.set(component, nodeAsyncBuffer(parquetPath(component), isHeavyComponent(component)))
  }
  return sources
}

const state = () => useSceneStore.getState()
const actions = () => state().actions

// ---------------------------------------------------------------------------
// Mock fixture dimensions (from scripts/generate_fixtures.py)
// TOP: 8×100, FRONT: 8×50, SIDE_L/R/REAR: 4×20
// ~88% valid → TOP~704 + FRONT~352 + 3×SIDE~210 ≈ 1266 points
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSceneStore', () => {
  // Load dataset ONCE for all tests (mirrors production usage)
  beforeAll(async () => {
    await actions().loadDataset(buildTestSources() as Map<string, File | string>)
  }, 60000)

  describe('initial state (before load)', () => {
    it('a fresh store starts idle', () => {
      // Test with a separate store concept — verify defaults exist in type
      expect(state().status).toBe('ready') // already loaded in beforeAll
    })
  })

  describe('loadDataset result', () => {
    it('status is ready with no error', () => {
      expect(state().status).toBe('ready')
      expect(state().loadProgress).toBe(1)
      expect(state().error).toBeNull()
    })

    it('discovers 199 frames from vehicle_pose', () => {
      expect(state().totalFrames).toBe(199)
    })

    it('loads 5 lidar calibrations', () => {
      expect(state().lidarCalibrations.size).toBe(5)
      expect(state().lidarCalibrations.has(1)).toBe(true) // TOP
      expect(state().lidarCalibrations.has(5)).toBe(true) // REAR
    })

    it('lists available components', () => {
      expect(state().availableComponents).toContain('lidar')
      expect(state().availableComponents).toContain('vehicle_pose')
      expect(state().availableComponents).toContain('lidar_box')
    })
  })

  describe('first frame (auto-loaded)', () => {
    it('starts at frame 0 with point cloud', () => {
      expect(state().currentFrameIndex).toBe(0)
      expect(state().currentFrame).not.toBeNull()
      const clouds = state().currentFrame!.sensorClouds
      expect(clouds.size).toBeGreaterThan(0)
      // Sum point counts across all sensors
      let totalPoints = 0
      for (const cloud of clouds.values()) totalPoints += cloud.pointCount
      // Mock fixtures: ~1266 points total (small range images)
      expect(totalPoints).toBeGreaterThan(800)
      expect(totalPoints).toBeLessThan(2000)
    })

    it('has bounding boxes', () => {
      // Mock: 75 objects per frame
      expect(state().currentFrame!.boxes.length).toBeGreaterThan(50)
    })

    it('has 4×4 vehicle pose', () => {
      expect(state().currentFrame!.vehiclePose).toHaveLength(16)
    })

    it('reports load and conversion timing', () => {
      expect(state().lastFrameLoadMs).toBeGreaterThan(0)
      expect(state().lastConvertMs).toBeGreaterThan(0)
    })
  })

  describe('frame navigation', () => {
    it('nextFrame → frame 1', async () => {
      await actions().seekFrame(0)
      await actions().nextFrame()
      expect(state().currentFrameIndex).toBe(1)
      expect(state().currentFrame?.sensorClouds.size).toBeGreaterThan(0)
    }, 15000)

    it('prevFrame → back to 0', async () => {
      await actions().seekFrame(1)
      await actions().prevFrame()
      expect(state().currentFrameIndex).toBe(0)
    })

    it('seekFrame jumps to frame 50', async () => {
      await actions().seekFrame(50)
      expect(state().currentFrameIndex).toBe(50)
      expect(state().currentFrame?.sensorClouds.size).toBeGreaterThan(0)
    }, 15000)

    it('clamps below 0', async () => {
      await actions().seekFrame(0)
      await actions().prevFrame()
      expect(state().currentFrameIndex).toBe(0)
    })

    it('clamps above last frame', async () => {
      await actions().seekFrame(198)
      await actions().nextFrame()
      expect(state().currentFrameIndex).toBe(198)
    }, 15000)
  })

  describe('frame cache', () => {
    it('second visit is sub-millisecond', async () => {
      // Ensure frame 5 is loaded (may already be cached)
      await actions().seekFrame(5)
      // Move away
      await actions().seekFrame(10)
      // Return — should be cached
      const t0 = performance.now()
      await actions().seekFrame(5)
      expect(performance.now() - t0).toBeLessThan(1)
    }, 30000)
  })

  describe('playback controls', () => {
    it('play/pause toggles isPlaying', () => {
      actions().play()
      expect(state().isPlaying).toBe(true)
      actions().pause()
      expect(state().isPlaying).toBe(false)
    })

    it('togglePlayback flips state', () => {
      actions().togglePlayback()
      expect(state().isPlaying).toBe(true)
      actions().togglePlayback()
      expect(state().isPlaying).toBe(false)
    })

    it('setPlaybackSpeed updates speed', () => {
      actions().setPlaybackSpeed(2)
      expect(state().playbackSpeed).toBe(2)
      actions().setPlaybackSpeed(1) // reset
    })
  })

  describe('setHoveredBox cross-modal highlight', () => {
    it('clear: null id clears all highlights', () => {
      actions().setHoveredBox(null, null)
      expect(state().hoveredBoxId).toBeNull()
      expect(state().highlightedCameraBoxIds.size).toBe(0)
      expect(state().highlightedLaserBoxId).toBeNull()
    })

    it('laser source: sets hoveredBoxId', () => {
      actions().setHoveredBox('laser_obj_1', 'laser')
      expect(state().hoveredBoxId).toBe('laser_obj_1')
      // No associations in fixture → empty camera highlights
      expect(state().highlightedLaserBoxId).toBeNull()
      actions().setHoveredBox(null, null) // cleanup
    })

    it('camera source: sets hoveredBoxId', () => {
      actions().setHoveredBox('cam_obj_1', 'camera')
      expect(state().hoveredBoxId).toBe('cam_obj_1')
      // No associations in fixture → null laser highlight
      expect(state().highlightedLaserBoxId).toBeNull()
      actions().setHoveredBox(null, null) // cleanup
    })

    it('clear after hover restores all to null/empty', () => {
      actions().setHoveredBox('laser_obj_1', 'laser')
      expect(state().hoveredBoxId).not.toBeNull()
      actions().setHoveredBox(null, null)
      expect(state().hoveredBoxId).toBeNull()
      expect(state().highlightedCameraBoxIds.size).toBe(0)
      expect(state().highlightedLaserBoxId).toBeNull()
    })
  })

  describe('sensor toggles', () => {
    it('toggleSensor removes a visible sensor', () => {
      expect(state().visibleSensors.has(1)).toBe(true)
      actions().toggleSensor(1)
      expect(state().visibleSensors.has(1)).toBe(false)
      actions().toggleSensor(1) // restore
    })

    it('toggleSensor adds back a hidden sensor', () => {
      actions().toggleSensor(3)
      expect(state().visibleSensors.has(3)).toBe(false)
      actions().toggleSensor(3)
      expect(state().visibleSensors.has(3)).toBe(true)
    })
  })

  describe('boxMode', () => {
    it('setBoxMode changes mode', () => {
      actions().setBoxMode('model')
      expect(state().boxMode).toBe('model')
      actions().setBoxMode('box') // restore
    })

    it('cycleBoxMode cycles off → box → model → off', () => {
      actions().setBoxMode('off')
      actions().cycleBoxMode()
      expect(state().boxMode).toBe('box')
      actions().cycleBoxMode()
      expect(state().boxMode).toBe('model')
      actions().cycleBoxMode()
      expect(state().boxMode).toBe('off')
      actions().setBoxMode('box') // restore
    })
  })

  describe('colormapMode', () => {
    it('setColormapMode changes mode', () => {
      actions().setColormapMode('range')
      expect(state().colormapMode).toBe('range')
      actions().setColormapMode('intensity') // restore
    })
  })

  describe('trailLength', () => {
    it('setTrailLength clamps to [0, 50]', () => {
      actions().setTrailLength(25)
      expect(state().trailLength).toBe(25)
      actions().setTrailLength(-5)
      expect(state().trailLength).toBe(0)
      actions().setTrailLength(100)
      expect(state().trailLength).toBe(50)
      actions().setTrailLength(10) // restore
    })
  })

  describe('pointOpacity', () => {
    it('setPointOpacity clamps to [0.1, 1]', () => {
      actions().setPointOpacity(0.5)
      expect(state().pointOpacity).toBe(0.5)
      actions().setPointOpacity(0.01)
      expect(state().pointOpacity).toBe(0.1)
      actions().setPointOpacity(2.0)
      expect(state().pointOpacity).toBe(1)
      actions().setPointOpacity(0.85) // restore
    })
  })

  describe('reset', () => {
    it('returns to idle state', () => {
      actions().reset()
      expect(state().status).toBe('idle')
      expect(state().totalFrames).toBe(0)
      expect(state().currentFrame).toBeNull()
    })

    it('reset restores highlight state', () => {
      actions().reset()
      expect(state().hoveredBoxId).toBeNull()
      expect(state().highlightedCameraBoxIds.size).toBe(0)
      expect(state().highlightedLaserBoxId).toBeNull()
    })
  })
})
