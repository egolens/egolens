import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AsyncBuffer } from 'hyparquet'
import { describe, expect, it } from 'vitest'
import { loadWaymoMetadata } from '../../adapters/waymo/metadata'
import { waymoCompiledRecipe } from '../../adapters/recipes/bundled'
import { openParquetFile, readAllRows, type WaymoParquetFile } from '../../utils/parquet'
import { convertAllSensors, type RangeImage } from '../../utils/rangeImage'
import type { NormalizedFrameV1 } from '../runtime/normalizedScene'
import { compareNormalizedFramesV1 } from '../runtime/parity'
import { bindRecipeSceneV1, prepareParquetColumnsRuntimeV1 } from '../runtime/bindRecipeScene'
import { bindWaymoRecipeSceneV1 } from '../runtime/WaymoRecipeScene'
import { MappedByteSourceV1 } from '../source/ByteSource'

const fixtureRoot = resolve(__dirname, '../../__fixtures__/mock_segment_0000')
const components = ['vehicle_pose', 'lidar_calibration', 'camera_calibration', 'lidar_box', 'lidar'] as const

function nodeBuffer(component: string): AsyncBuffer {
  const bytes = readFileSync(resolve(fixtureRoot, `${component}.parquet`))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return { byteLength: buffer.byteLength, slice: (start, end) => Promise.resolve(buffer.slice(start, end)) }
}

async function fixture(): Promise<Map<string, WaymoParquetFile>> {
  return new Map(await Promise.all(components.map(async (component) => [
    component,
    await openParquetFile(component, nodeBuffer(component)),
  ] as const)))
}

describe('Waymo recipe-backed NormalizedSceneV1', () => {
  it('binds five LiDARs, optical camera calibrations, and only evidenced capabilities', async () => {
    const parquetFiles = await fixture()
    const { scene, diagnostics } = await bindWaymoRecipeSceneV1({ compiledRecipe: waymoCompiledRecipe, parquetFiles })
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
    const parquetFiles = await fixture()
    const legacy = await loadWaymoMetadata(parquetFiles)
    const source = new MappedByteSourceV1([...parquetFiles].map(([component, file]) =>
      [`${component}/fixture.parquet`, file.buffer] as const))
    const { scene, executionProfile } = await bindRecipeSceneV1({
      compiledRecipe: waymoCompiledRecipe,
      source,
      preparation: prepareParquetColumnsRuntimeV1(parquetFiles),
      metadataBundle: legacy,
    })
    expect(executionProfile).toBe('core/parquet-range-image@1')
    const actual = await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })

    const lidarRows = await readAllRows(parquetFiles.get('lidar')!, [
      'key.frame_timestamp_micros',
      'key.laser_name',
      '[LiDARComponent].range_image_return1.shape',
      '[LiDARComponent].range_image_return1.values',
    ])
    const rangeImages = new Map<number, RangeImage>()
    for (const row of lidarRows.filter((row) => row['key.frame_timestamp_micros'] === legacy.timestamps[0])) {
      rangeImages.set(row['key.laser_name'] as number, {
        shape: row['[LiDARComponent].range_image_return1.shape'] as [number, number, number],
        values: row['[LiDARComponent].range_image_return1.values'] as number[],
      })
    }
    const oracle = convertAllSensors(rangeImages, legacy.lidarCalibrations)
    const expected: NormalizedFrameV1 = {
      ...actual,
      timestampMicros: legacy.timestamps[0],
      worldFromEgo: new Float64Array(legacy.poseByFrameIndex.get(0)!),
      pointClouds: [...oracle.perSensor].map(([rendererId, cloud]) => ({
        sensorId: waymoCompiledRecipe.recipe.scene.sensors.find((sensor) => sensor.modality === 'lidar' && sensor.rendererId === rendererId)!.id,
        frameId: 'ego',
        values: cloud.positions,
        pointCount: cloud.pointCount,
        stride: 6,
        attributes: ['x', 'y', 'z', 'intensity', 'range', 'elongation'],
        sourceIndices: cloud.validIndices,
      })),
      boxes3d: actual.boxes3d.map((box, index) => {
        const row = legacy.lidarBoxByFrame.get(legacy.timestamps[0])![index]
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
    const parquetFiles = await fixture()
    const { scene } = await bindWaymoRecipeSceneV1({ compiledRecipe: waymoCompiledRecipe, parquetFiles })
    const frame = await scene.loadFrame(0, {
      capabilities: new Set(['pointClouds']),
      sensorIds: new Set(['lidar-top']),
    })
    expect(frame.pointClouds.map((cloud) => cloud.sensorId)).toEqual(['lidar-top'])
    expect(frame.boxes3d).toEqual([])
    await expect(scene.loadFrame(199, { capabilities: new Set(['pointClouds']) })).rejects.toThrow('out of range')
    const controller = new AbortController()
    controller.abort()
    await expect(scene.loadFrame(0, { capabilities: new Set(['pointClouds']), signal: controller.signal })).rejects.toThrow('aborted')
    scene.dispose()
    await expect(scene.loadFrame(0, { capabilities: new Set(['pointClouds']) })).rejects.toThrow('disposed')
  })

  it('normalizes optional labels, associations, masks, and keypoints when their tables bind', async () => {
    const parquetFiles = await fixture()
    const bundle = await loadWaymoMetadata(parquetFiles)
    const timestamp = bundle.timestamps[0]
    const firstLidarRow = (await readAllRows(parquetFiles.get('lidar')!, undefined))[0]
    const shape = firstLidarRow['[LiDARComponent].range_image_return1.shape'] as [number, number, number]
    const segValues = new Array(shape[0] * shape[1] * 2).fill(0)
    for (let index = 0; index < segValues.length; index += 2) {
      segValues[index] = 42
      segValues[index + 1] = 7
    }
    bundle.hasSegmentation = true
    bundle.segLabelFrames = new Set([0])
    bundle.lidarSegmentationByFrame = new Map([[timestamp, [{
      'key.frame_timestamp_micros': timestamp,
      'key.laser_name': 1,
      '[LiDARSegmentationLabelComponent].range_image_return1.shape': [shape[0], shape[1], 2],
      '[LiDARSegmentationLabelComponent].range_image_return1.values': segValues,
    }]]])
    bundle.cameraBoxByFrame.set(timestamp, [{
      'key.frame_timestamp_micros': timestamp,
      'key.camera_name': 1,
      'key.camera_object_id': 'camera-object',
      '[CameraBoxComponent].type': 2,
      '[CameraBoxComponent].box.center.x': 100,
      '[CameraBoxComponent].box.center.y': 200,
      '[CameraBoxComponent].box.size.x': 30,
      '[CameraBoxComponent].box.size.y': 40,
    }])
    const laserObjectId = String(bundle.lidarBoxByFrame.get(timestamp)![0]['key.laser_object_id'])
    bundle.assocCamToLaser.set('camera-object', laserObjectId)
    bundle.assocLaserToCams.set(laserObjectId, new Set(['camera-object']))
    bundle.hasKeypoints = true
    bundle.keypointsByFrame = new Map([[timestamp, [{
      'key.frame_timestamp_micros': timestamp,
      'key.laser_object_id': laserObjectId,
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].type': [1],
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.x': [1],
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.y': [2],
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.z': [3],
    }]]])
    bundle.cameraKeypointsByFrame = new Map([[timestamp, [{
      'key.frame_timestamp_micros': timestamp,
      'key.camera_name': 1,
      'key.camera_object_id': 'camera-object',
      '[CameraHumanKeypointsComponent].camera_keypoints[*].type': [1],
      '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.x': [10],
      '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.y': [20],
      '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.visibility.is_occluded': [true],
    }]]])
    bundle.hasCameraSegmentation = true
    bundle.cameraSeg = new Map([[timestamp, new Map([[1, { panopticLabel: new Uint8Array([1, 2, 3]).buffer, divisor: 1000 }]])]])
    bundle.segmentMeta = { segmentId: 'mock', timeOfDay: 'Day', location: 'test', weather: 'sunny', objectCounts: {} }

    const { scene } = await bindWaymoRecipeSceneV1({ compiledRecipe: waymoCompiledRecipe, parquetFiles, metadataBundle: bundle })
    expect(scene.manifest.capabilities.has('cameraImages')).toBe(false)
    for (const capability of ['boxes2d', 'boxAssociations', 'lidarSegmentation', 'cameraSegmentation', 'keypoints3d', 'keypoints2d', 'segmentMetadata'] as const) {
      expect(scene.manifest.capabilities.has(capability)).toBe(true)
    }
    const frame = await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })
    expect(frame.boxes2d).toMatchObject([{ id: 'camera-object', cameraId: 'camera-front', classId: 'pedestrian' }])
    expect(scene.relations.box2dToBox3d.get('camera-object')).toBe(laserObjectId)
    expect(frame.pointClouds.find((cloud) => cloud.sensorId === 'lidar-top')?.semanticLabels?.[0]).toBe(7)
    expect(frame.pointClouds.find((cloud) => cloud.sensorId === 'lidar-top')?.panopticLabels).toBeInstanceOf(Uint16Array)
    expect((frame.lidarSegmentation[0].labels as Uint16Array)[0]).toBe(7042)
    expect(frame.cameraSegmentation).toMatchObject([{ sensorId: 'camera-front', divisor: 1000, encoding: 'png-uint16' }])
    expect(frame.keypoints3d).toMatchObject([{ objectId: laserObjectId, points: [{ name: 'Nose', position: [1, 2, 3] }] }])
    expect(frame.keypoints2d).toMatchObject([{ objectId: 'camera-object', cameraId: 'camera-front', points: [{ visibility: 'occluded' }] }])
  })
})
