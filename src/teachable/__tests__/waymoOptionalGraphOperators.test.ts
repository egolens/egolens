import { describe, expect, it } from 'vitest'
import { waymoCompiledRecipe } from '../../adapters/recipes/bundled'
import type { ParquetRow } from '../../utils/merge'
import type { ParquetColumnsParamsV1 } from '../operators/parquetColumns'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'
import {
  GraphResourceAccountV1,
  type CoreOperatorExecutionContextV1,
  type GraphBoxes2dV1,
  type GraphBoxesV1,
  type GraphCameraSegmentationV1,
  type GraphKeypointsV1,
  type GraphParquetCameraPlanV1,
  type GraphParquetCollectionV1,
  type GraphRangeImagePointCloudPlanV1,
  type GraphRangeImageSegmentationPlanV1,
  type GraphSegmentIndexV1,
} from '../runtime/GraphValues'

const controller = new AbortController()
const resources = new GraphResourceAccountV1({
  maxNodes: 1_000, maxSourceBytes: 1_000_000, maxAllocationBytes: 1_000_000,
})
const context: CoreOperatorExecutionContextV1 = {
  signal: controller.signal,
  source: {} as CoreOperatorExecutionContextV1['source'],
  resources,
  throwIfAborted() {},
  async read() { throw new Error('unexpected source read') },
  async asyncBuffer() { throw new Error('unexpected source read') },
}

function collection(sourceId: keyof typeof waymoCompiledRecipe.recipe.sources, rows: readonly ParquetRow[]) {
  const path = `${sourceId}.parquet`
  const params = waymoCompiledRecipe.recipe.sources[sourceId].params as unknown as ParquetColumnsParamsV1
  return {
    kind: 'parquet-collection', files: [{ path, size: 1 }], params, context,
    fileCache: new Map(), cache: new Map([[path, Promise.resolve(rows)]]), projectionCache: new Map(),
    frameIndexCache: new Map(), frameRowsCache: new Map(), retainedReleases: new Map(),
  } satisfies GraphParquetCollectionV1
}

function params(pipelineId: string) {
  return waymoCompiledRecipe.pipelines.get(pipelineId)!.nodes[0].params ?? {}
}

async function execute(name: keyof typeof coreGraphOperatorImplementationsV1, inputs: Record<string, unknown>, operatorParams: Readonly<Record<string, unknown>>) {
  return await coreGraphOperatorImplementationsV1[name](inputs, operatorParams, context)
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('Waymo optional graph operators', () => {
  it('binds Parquet camera bytes and optical-frame calibration declaratively', async () => {
    const images = collection('cameraImageRows', [])
    const calibrations = collection('cameraCalibrationRows', [{
      'key.camera_name': 1,
      '[CameraCalibrationComponent].extrinsic.transform': identity,
      '[CameraCalibrationComponent].width': 1920,
      '[CameraCalibrationComponent].height': 1280,
      '[CameraCalibrationComponent].intrinsic.f_u': 1000,
      '[CameraCalibrationComponent].intrinsic.f_v': 1001,
      '[CameraCalibrationComponent].intrinsic.c_u': 960,
      '[CameraCalibrationComponent].intrinsic.c_v': 640,
      '[CameraCalibrationComponent].intrinsic.k1': 0,
      '[CameraCalibrationComponent].intrinsic.k2': 0,
      '[CameraCalibrationComponent].intrinsic.p1': 0,
      '[CameraCalibrationComponent].intrinsic.p2': 0,
      '[CameraCalibrationComponent].intrinsic.k3': 0,
    }])
    const result = await execute('image.bind_camera_frame', { rows: images, calibration: calibrations }, params('cameraImages'))
    const plan = result.images as GraphParquetCameraPlanV1
    expect(plan.kind).toBe('parquet-camera-plan')
    expect(plan.calibrations.get('1')).toMatchObject({ width: 1920, height: 1280, intrinsics: [1000, 1001, 960, 640] })
    expect(plan.calibrations.get('1')?.egoFromCamera).toEqual(new Float64Array([
      0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1,
    ]))
  })

  it('normalizes 2D boxes and only joins associations evidenced by both box outputs', async () => {
    const box2dResult = await execute('geometry.normalize_boxes2d', { rows: collection('box2dRows', [{
      'key.frame_timestamp_micros': 10n, 'key.camera_name': 1, 'key.camera_object_id': 'camera-1',
      '[CameraBoxComponent].type': 2,
      '[CameraBoxComponent].box.center.x': 100, '[CameraBoxComponent].box.center.y': 200,
      '[CameraBoxComponent].box.size.x': 30, '[CameraBoxComponent].box.size.y': 40,
    }]) }, params('boxes2d'))
    const boxes2d = box2dResult.boxes as GraphBoxes2dV1
    expect(boxes2d.byTimestamp.get(10n)).toMatchObject([{
      objectId: 'camera-1', cameraId: '1', classId: 'pedestrian', center: [100, 200], dimensions: [30, 40],
    }])

    const boxes3d: GraphBoxesV1 = { kind: 'boxes3d', byTimestamp: new Map([[10n, [{
      id: 'lidar-1', objectId: 'lidar-1', classId: 'pedestrian', frameId: 'ego',
      center: [1, 2, 3], dimensions: [1, 1, 2], orientation: [1, 0, 0, 0], heading: 0,
    }]]]) }
    const associations = collection('associationRows', [
      { 'key.camera_object_id': 'camera-1', 'key.laser_object_id': 'lidar-1' },
      { 'key.camera_object_id': 'missing-camera', 'key.laser_object_id': 'lidar-1' },
    ])
    const joined = await execute(
      'relations.composite_key_join', { boxes2d, boxes3d, associations }, params('boxAssociations'),
    )
    expect((joined.relations as { box2dToBox3d: Map<string, string> }).box2dToBox3d).toEqual(new Map([['camera-1', 'lidar-1']]))
  })

  it('normalizes 2D/3D keypoints, camera masks, and segment stats', async () => {
    const keypoints3d = (await execute('geometry.normalize_keypoints', { rows: collection('keypoints3dRows', [{
      'key.frame_timestamp_micros': 10n, 'key.laser_object_id': 'lidar-1',
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].type': [1],
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.x': [1],
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.y': [2],
      '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.z': [3],
    }]) }, params('keypoints3d'))).keypoints as GraphKeypointsV1
    expect(keypoints3d.byTimestamp.get(10n)).toMatchObject([{
      objectId: 'lidar-1', points: [{ name: 'Nose', position: [1, 2, 3], visibility: 'unknown' }],
    }])

    const keypoints2d = (await execute('geometry.normalize_keypoints', { rows: collection('keypoints2dRows', [{
      'key.frame_timestamp_micros': 10n, 'key.camera_name': 1, 'key.camera_object_id': 'camera-1',
      '[CameraHumanKeypointsComponent].camera_keypoints[*].type': [1],
      '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.x': [10],
      '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.y': [20],
      '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.visibility.is_occluded': [true],
    }]) }, params('keypoints2d'))).keypoints as GraphKeypointsV1
    expect(keypoints2d.byTimestamp.get(10n)).toMatchObject([{
      objectId: 'camera-1', cameraId: '1', points: [{ name: 'Nose', position: [10, 20], visibility: 'occluded' }],
    }])

    const cameraSegmentation = (await execute('labels.decode_camera_mask', { rows: collection('cameraSegmentationRows', [{
      'key.frame_timestamp_micros': 10n, 'key.camera_name': 1,
      '[CameraSegmentationLabelComponent].panoptic_label': new Uint8Array([1, 2, 3]),
      '[CameraSegmentationLabelComponent].panoptic_label_divisor': 1000,
    }]) }, params('cameraSegmentation'))).segmentation as GraphCameraSegmentationV1
    expect(cameraSegmentation.byTimestamp.get(10n)).toMatchObject([{
      sensorId: '1', divisor: 1000, encoding: 'png-uint16',
    }])

    const segment = (await execute('records.select', { rows: collection('statsRows', [{
      'key.segment_context_name': 'segment', '[StatsComponent].location': 'location',
      '[StatsComponent].time_of_day': 'Day', '[StatsComponent].weather': 'sunny',
      '[StatsComponent].lidar_object_counts.types': [1, 2],
      '[StatsComponent].lidar_object_counts.counts': [4, 3],
    }]) }, params('segmentMetadata'))).segments as GraphSegmentIndexV1
    expect(segment.segments).toEqual([expect.objectContaining({
      id: 'segment', objectCounts: { 1: 4, 2: 3 }, metadata: { location: 'location', timeOfDay: 'Day', weather: 'sunny' },
    })])
  })

  it('indexes range-image segmentation availability without decoding label payloads', async () => {
    const labels = collection('lidarSegmentationRows', [{
      'key.frame_timestamp_micros': 10n,
      'key.laser_name': 1,
      '[LiDARSegmentationLabelComponent].range_image_return1.shape': [1, 1, 2],
      '[LiDARSegmentationLabelComponent].range_image_return1.values': [42, 7],
    }])
    const path = labels.files[0].path
    const timestampField = 'key.frame_timestamp_micros'
    labels.projectionCache.set(`${path}\u0000${timestampField}`, Promise.resolve([{ [timestampField]: 10n }]))
    const pointClouds: GraphRangeImagePointCloudPlanV1 = {
      kind: 'range-image-point-cloud-plan', rows: collection('lidarRows', []), calibrations: new Map(),
      timestampField, sensorField: 'key.laser_name',
      shapeField: '[LiDARComponent].range_image_return1.shape', valuesField: '[LiDARComponent].range_image_return1.values', frameId: 'ego',
    }
    const plan = (await execute(
      'labels.attach_by_point_index', { pointClouds, labels }, params('lidarSegmentation'),
    )).segmentation as GraphRangeImageSegmentationPlanV1
    expect(plan.availableTimestamps).toEqual(new Set([10n]))
    expect(labels.cache.get(path)).toBeDefined()
  })
})
