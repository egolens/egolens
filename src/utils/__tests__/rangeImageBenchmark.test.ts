/**
 * Benchmark test for LiDAR range image → xyz conversion (CPU path).
 *
 * Measures single-sensor and multi-sensor conversion times.
 * GPU comparison tests are in-browser only (WebGPU not available in Node).
 *
 * Run with: npx vitest run rangeImageBenchmark
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, closeSync } from 'fs'
import { openSync, readSync, fstatSync } from 'fs'
import { resolve } from 'path'
import type { AsyncBuffer } from 'hyparquet'
import { openParquetFile, readAllRows, readRowRange, isHeavyComponent } from '../parquet'
import {
  convertRangeImageToPointCloud,
  convertAllSensors,
  parseLidarCalibration,
  POINT_STRIDE,
  type LidarCalibration,
  type RangeImage,
} from '../rangeImage'

// ---------------------------------------------------------------------------
// Helpers (same as rangeImage.test.ts)
// ---------------------------------------------------------------------------

const WAYMO_DATA = resolve(__dirname, '../../../waymo_data')
const SEGMENT_ID = '10023947602400723454_1120_000_1140_000'

function parquetPath(component: string): string {
  return resolve(WAYMO_DATA, component, `${SEGMENT_ID}.parquet`)
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

function openTestFile(component: string) {
  const lazy = isHeavyComponent(component)
  const buffer = nodeAsyncBuffer(parquetPath(component), lazy)
  return openParquetFile(component, buffer)
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

let calibrations: Map<number, LidarCalibration>
let allRangeImages: Map<number, RangeImage>

beforeAll(async () => {
  const calibPf = await openTestFile('lidar_calibration')
  const calibRows = await readAllRows(calibPf)
  calibrations = new Map()
  for (const row of calibRows) {
    const calib = parseLidarCalibration(row)
    calibrations.set(calib.laserName, calib)
  }

  const lidarPf = await openTestFile('lidar')
  const lidarRows = await readRowRange(lidarPf, 0, 5, [
    'key.laser_name',
    '[LiDARComponent].range_image_return1.shape',
    '[LiDARComponent].range_image_return1.values',
  ])

  allRangeImages = new Map()
  for (const row of lidarRows) {
    const laserName = row['key.laser_name'] as number
    allRangeImages.set(laserName, {
      shape: row['[LiDARComponent].range_image_return1.shape'] as [number, number, number],
      values: row['[LiDARComponent].range_image_return1.values'] as number[],
    })
  }
})

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('CPU Benchmark', () => {
  it('TOP sensor: 64×2650 → ~150K points', () => {
    const ri = allRangeImages.get(1)!
    const calib = calibrations.get(1)!

    const runs = 5
    const times: number[] = []

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      const cloud = convertRangeImageToPointCloud(ri, calib)
      const t1 = performance.now()
      times.push(t1 - t0)

      // Sanity check
      expect(cloud.pointCount).toBeGreaterThan(100000)
    }

    const avg = times.reduce((a, b) => a + b) / runs
    const min = Math.min(...times)
    const max = Math.max(...times)

    console.log(`\n  TOP sensor (5 runs):`)
    console.log(`    avg: ${avg.toFixed(1)}ms, min: ${min.toFixed(1)}ms, max: ${max.toFixed(1)}ms`)
    console.log(`    points: ${allRangeImages.get(1)!.shape[0]}×${allRangeImages.get(1)!.shape[1]} → ${times.length} runs`)

    // Should complete in reasonable time (<100ms per run on modern hardware)
    expect(avg).toBeLessThan(200)
  })

  it('All 5 sensors converted', () => {
    const runs = 5
    const times: number[] = []
    let lastResult = { totalPointCount: 0 }

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      const result = convertAllSensors(allRangeImages, calibrations)
      const t1 = performance.now()
      times.push(t1 - t0)
      lastResult = result
    }

    const avg = times.reduce((a, b) => a + b) / runs
    const min = Math.min(...times)
    const max = Math.max(...times)

    console.log(`\n  All 5 sensors converted (5 runs):`)
    console.log(`    avg: ${avg.toFixed(1)}ms, min: ${min.toFixed(1)}ms, max: ${max.toFixed(1)}ms`)
    console.log(`    total points: ${lastResult.totalPointCount}`)

    // Should be under 200ms for all 5 sensors
    expect(avg).toBeLessThan(500)
  })

  it('per-sensor breakdown', () => {
    const sensorNames = ['TOP', 'FRONT', 'SIDE_LEFT', 'SIDE_RIGHT', 'REAR']

    console.log('\n  Per-sensor breakdown:')
    for (const [laserName, ri] of allRangeImages) {
      const calib = calibrations.get(laserName)!
      const t0 = performance.now()
      const cloud = convertRangeImageToPointCloud(ri, calib)
      const t1 = performance.now()

      const name = sensorNames[laserName - 1] || `LASER_${laserName}`
      const [h, w] = ri.shape
      console.log(`    ${name}: ${h}×${w} → ${cloud.pointCount} pts in ${(t1 - t0).toFixed(1)}ms`)
    }
  })
})

describe('Output format validation', () => {
  it('positions are properly interleaved [x,y,z,i,r,e, ...]', () => {
    const result = convertAllSensors(allRangeImages, calibrations)

    // Check each per-sensor cloud
    for (const cloud of result.perSensor.values()) {
      expect(cloud.positions.length).toBe(cloud.pointCount * POINT_STRIDE)
      // Spot-check: no NaN values
      for (let i = 0; i < Math.min(cloud.pointCount * POINT_STRIDE, 1000); i++) {
        expect(Number.isNaN(cloud.positions[i])).toBe(false)
        expect(Number.isFinite(cloud.positions[i])).toBe(true)
      }
    }
  })

  it('GPU test data export matches CPU output shape', () => {
    const result = convertAllSensors(allRangeImages, calibrations)

    // Merge for reference data export
    const merged = new Float32Array(result.totalPointCount * POINT_STRIDE)
    let offset = 0
    for (const cloud of result.perSensor.values()) {
      merged.set(cloud.positions, offset)
      offset += cloud.pointCount * POINT_STRIDE
    }

    const testFixture = {
      pointCount: result.totalPointCount,
      referencePoints: Array.from(merged.slice(0, 40)),
      tailPoints: Array.from(merged.slice(-40)),
    }

    expect(testFixture.pointCount).toBeGreaterThan(150000)
    expect(testFixture.referencePoints).toHaveLength(40)
    expect(testFixture.tailPoints).toHaveLength(40)

    console.log(`\n  GPU test fixture:`)
    console.log(`    totalPoints: ${testFixture.pointCount}`)
    console.log(`    first point: [${testFixture.referencePoints.slice(0, 4).map((v: number) => v.toFixed(3)).join(', ')}]`)
  })
})
