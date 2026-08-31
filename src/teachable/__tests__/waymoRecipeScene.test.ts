import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AsyncBuffer } from 'hyparquet'
import { describe, expect, it } from 'vitest'
import { waymoCompiledRecipe } from '../../adapters/recipes/bundled'
import { openParquetFile, readAllRows, type WaymoParquetFile } from '../../utils/parquet'
import { invertRowMajor4x4, multiplyRowMajor4x4 } from '../../utils/matrix'
import { convertAllSensors, parseLidarCalibration, type RangeImage } from '../../utils/rangeImage'
import { BrowserGraphPreviewRuntimeV1 } from '../authoring/BrowserGraphPreviewRuntime'
import { authoringPreviewStoreV1 } from '../authoring/previewStore'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import { bindRecipeSceneV1 } from '../runtime/bindRecipeScene'
import { ExecutableGraphKernelV1 } from '../runtime/GraphKernel'
import { assembleGraphSceneV1 } from '../runtime/GraphSceneAssembler'
import type { NormalizedFrameV1 } from '../runtime/normalizedScene'
import { compareNormalizedFramesV1 } from '../runtime/parity'
import { MappedByteSourceV1 } from '../source/ByteSource'

const fixtureRoot = resolve(__dirname, '../../__fixtures__/mock_segment_0000')
const components = ['vehicle_pose', 'lidar_calibration', 'camera_calibration', 'lidar_box', 'lidar'] as const

function nodeBuffer(component: string): AsyncBuffer {
  const bytes = readFileSync(resolve(fixtureRoot, `${component}.parquet`))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return { byteLength: buffer.byteLength, slice: (start, end) => Promise.resolve(buffer.slice(start, end)) }
}

function sourceFixture() {
  const entries = components.map((component) => [`${component}/fixture.parquet`, nodeBuffer(component)] as const)
  return {
    source: new MappedByteSourceV1(entries),
    inventoryEntries: entries.map(([path, buffer]) => ({ path, size: buffer.byteLength })),
  }
}

async function parquetFixture(): Promise<Map<string, WaymoParquetFile>> {
  return new Map(await Promise.all(components.map(async (component) => [
    component,
    await openParquetFile(component, nodeBuffer(component)),
  ] as const)))
}

async function bindFixture(compiledRecipe = waymoCompiledRecipe) {
  const fixture = sourceFixture()
  return await bindRecipeSceneV1({ compiledRecipe, ...fixture })
}

describe('Waymo recipe-backed NormalizedSceneV1', () => {
  it('binds five LiDARs, optical camera calibrations, and only evidenced capabilities through the graph', async () => {
    const { scene, diagnostics } = await bindFixture()
    expect(scene.index.timestampsMicros).toHaveLength(199)
    expect(scene.manifest.capabilities).toEqual(new Set(['timeline', 'egoPoses', 'pointClouds', 'boxes3d', 'trajectories']))
    expect(scene.relations.staticTransforms).toHaveLength(10)
    expect(scene.relations.cameraCalibrations).toHaveLength(5)
    expect(scene.relations.cameraCalibrations.get('camera-front')?.egoFromCamera).toEqual(new Float64Array([
      0, 0, 1, 0,
      -1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, 0, 1,
    ]))
    expect(diagnostics).toContainEqual(expect.objectContaining({ jsonPointer: '/outputs/cameraImages' }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ jsonPointer: '/outputs/lidarSegmentation' }))
  })

  it('matches the compatibility Parquet/range-image oracle structurally and numerically', async () => {
    const parquetFiles = await parquetFixture()
    const poseRows = await readAllRows(parquetFiles.get('vehicle_pose')!, undefined)
    const timestamps = [...new Set(poseRows.map((row) => row['key.frame_timestamp_micros'] as bigint))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const timestamp = timestamps[0]
    const firstPose = poseRows.find((row) => row['key.frame_timestamp_micros'] === timestamp)![
      '[VehiclePoseComponent].world_from_vehicle.transform'
    ] as number[]
    const relativeFirstPose = multiplyRowMajor4x4(invertRowMajor4x4(firstPose), firstPose)
    const lidarCalibrations = new Map((await readAllRows(parquetFiles.get('lidar_calibration')!, undefined)).map((row) => {
      const calibration = parseLidarCalibration(row)
      return [calibration.laserName, calibration] as const
    }))
    const firstBoxes = (await readAllRows(parquetFiles.get('lidar_box')!, undefined))
      .filter((row) => row['key.frame_timestamp_micros'] === timestamp)
    const { scene } = await bindFixture()
    const actual = await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })

    const lidarRows = await readAllRows(parquetFiles.get('lidar')!, [
      'key.frame_timestamp_micros',
      'key.laser_name',
      '[LiDARComponent].range_image_return1.shape',
      '[LiDARComponent].range_image_return1.values',
    ])
    const rangeImages = new Map<number, RangeImage>()
    for (const row of lidarRows.filter((row) => row['key.frame_timestamp_micros'] === timestamp)) {
      rangeImages.set(row['key.laser_name'] as number, {
        shape: row['[LiDARComponent].range_image_return1.shape'] as [number, number, number],
        values: row['[LiDARComponent].range_image_return1.values'] as number[],
      })
    }
    const oracle = convertAllSensors(rangeImages, lidarCalibrations)
    const expected: NormalizedFrameV1 = {
      ...actual,
      timestampMicros: timestamp,
      worldFromEgo: new Float64Array(relativeFirstPose),
      pointClouds: [...oracle.perSensor].map(([rendererId, cloud]) => ({
        sensorId: waymoCompiledRecipe.recipe.scene.sensors.find((sensor) => sensor.modality === 'lidar' && sensor.rendererId === rendererId)!.id,
        frameId: 'ego', values: cloud.positions, pointCount: cloud.pointCount, stride: 6,
        attributes: ['x', 'y', 'z', 'intensity', 'range', 'elongation'], sourceIndices: cloud.validIndices,
      })),
      boxes3d: actual.boxes3d.map((box, index) => {
        const row = firstBoxes[index]
        return {
          ...box,
          id: String(row['key.laser_object_id']),
          center: [
            row['[LiDARBoxComponent].box.center.x'] as number,
            row['[LiDARBoxComponent].box.center.y'] as number,
            row['[LiDARBoxComponent].box.center.z'] as number,
          ],
          dimensions: [
            row['[LiDARBoxComponent].box.size.x'] as number,
            row['[LiDARBoxComponent].box.size.y'] as number,
            row['[LiDARBoxComponent].box.size.z'] as number,
          ],
        }
      }),
    }
    expect(compareNormalizedFramesV1(expected, actual)).toEqual([])
    expect(actual.pointClouds.map((cloud) => cloud.sensorId)).toEqual([
      'lidar-top', 'lidar-front', 'lidar-side-left', 'lidar-side-right', 'lidar-rear',
    ])
    expect(actual.pointClouds.reduce((total, cloud) => total + cloud.pointCount, 0)).toBeGreaterThan(500)
    expect(actual.boxes3d).toHaveLength(75)
  })

  it('honors capability, sensor, range, cancellation, and disposal boundaries', async () => {
    const { scene } = await bindFixture()
    const frame = await scene.loadFrame(0, {
      capabilities: new Set(['pointClouds']), sensorIds: new Set(['lidar-top']),
    })
    expect(frame.pointClouds.map((cloud) => cloud.sensorId)).toEqual(['lidar-top'])
    expect(frame.boxes3d).toEqual([])
    await expect(scene.loadFrame(199, { capabilities: new Set(['pointClouds']) })).rejects.toThrow('out of range')
    const controller = new AbortController()
    controller.abort()
    await expect(scene.loadFrame(0, { capabilities: new Set(['pointClouds']), signal: controller.signal })).rejects.toThrow('aborted')
    scene.dispose()
    scene.dispose()
    await expect(scene.loadFrame(0, { capabilities: new Set(['pointClouds']) })).rejects.toThrow('disposed')
  })

  it('releases eager and lazy Parquet allocations on idempotent graph disposal', async () => {
    const fixture = sourceFixture()
    const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
      compiledRecipe: waymoCompiledRecipe,
      source: fixture.source,
      inventory: fixture.inventoryEntries,
    })
    const eagerAllocation = graph.resources.allocationBytes
    expect(eagerAllocation).toBeGreaterThan(0)
    const { scene } = assembleGraphSceneV1({ compiledRecipe: waymoCompiledRecipe, graph })
    await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })
    expect(graph.resources.allocationBytes).toBeGreaterThan(eagerAllocation)
    scene.dispose()
    scene.dispose()
    expect(graph.abortController.signal.aborted).toBe(true)
    expect(graph.resources.allocationBytes).toBe(0)
  })

  it('does not dispatch on the learned recipe identity', async () => {
    const learned = structuredClone(waymoCompiledRecipe.recipe)
    learned.scene.formatId = 'learned-waymo-compatible'
    const { scene } = await bindFixture(compileRecipeV1(learned, bundledPhase2OperatorRegistry))
    expect(scene.manifest.id).toBe('learned-waymo-compatible')
    await expect(scene.loadFrame(0, { capabilities: scene.manifest.capabilities })).resolves.toMatchObject({ index: 0 })
  })

  it('runs authoring preview through the same complete graph', async () => {
    authoringPreviewStoreV1.clear()
    const inventory = new SourceInventoryV1(components.map((component) => {
      const bytes = readFileSync(resolve(fixtureRoot, `${component}.parquet`))
      return [`${component}/fixture.parquet`, new File([bytes], `${component}.parquet`)] as const
    }), { sessionId: 'waymo-graph-preview' })
    const prepared = await new BrowserGraphPreviewRuntimeV1().preparePreview(
      waymoCompiledRecipe,
      inventory.resolveAuthorizedSource(),
      inventory,
    )
    expect(prepared.validationSummary).toMatchObject({
      passed: true, frameCount: 199, sampleFrames: [0, 99, 198],
    })
    prepared.commit()
    expect(authoringPreviewStoreV1.getSnapshot()).toMatchObject({
      formatId: 'waymo', frameCount: 199, sampledFrames: [0, 99, 198],
    })
    prepared.dispose()
  })
})
