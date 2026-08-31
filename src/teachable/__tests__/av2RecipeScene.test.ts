import { tableFromArrays, tableToIPC } from '@uwdata/flechette'
import { describe, expect, it } from 'vitest'
import { argoverse2CompiledRecipe } from '../../adapters/recipes/bundled'
import { loadAV2LogMetadata, type AV2LogDatabase } from '../../adapters/argoverse2/metadata'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import { bindAV2RecipeSceneV1 } from '../runtime/AV2RecipeScene'
import { bindRecipeSceneV1, prepareFeatherTimelineRuntimeV1 } from '../runtime/bindRecipeScene'
import { MappedByteSourceV1 } from '../source/ByteSource'
import type { NormalizedFrameV1 } from '../runtime/normalizedScene'
import { compareNormalizedFramesV1 } from '../runtime/parity'

function lidarFeather(): ArrayBuffer {
  const table = tableFromArrays({
    x: new Float64Array([1, 2]),
    y: new Float64Array([3, 4]),
    z: new Float64Array([5, 6]),
    intensity: new Uint8Array([7, 8]),
  })
  const bytes = tableToIPC(table)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function fixture() {
  const timestamp = 1_000_000n
  const cameraExtrinsic = [
    0, 0, 1, 0,
    -1, 0, 0, 0,
    0, -1, 0, 0,
    0, 0, 0, 1,
  ]
  const database: AV2LogDatabase = {
    logId: 'av2-log',
    lidarTimestamps: [timestamp],
    cameraFilesByFrame: new Map([[0, [{ cameraId: 4, filename: 'sensors/cameras/ring_front_center/1000100.jpg' }]]]),
    annotationsByTimestamp: new Map([[timestamp, [{
      timestamp_ns: timestamp,
      category: 'REGULAR_VEHICLE',
      track_uuid: 'track',
      qw: 1, qx: 0, qy: 0, qz: 0,
      tx_m: 10, ty_m: 0, tz_m: 0,
      length_m: 4, width_m: 2, height_m: 2,
    }]]]),
    posesByTimestamp: new Map([[timestamp, { qw: 1, qx: 0, qy: 0, qz: 0, tx: 0, ty: 0, tz: 0 }]]),
    intrinsicsBySensor: new Map([['ring_front_center', {
      fx: 100, fy: 100, cx: 50, cy: 50, k1: 0, k2: 0, k3: 0, width: 100, height: 100,
    }]]),
    extrinsicsBySensor: new Map([['ring_front_center', cameraExtrinsic]]),
  }
  const recipe = structuredClone(argoverse2CompiledRecipe.recipe)
  const params = recipe.sources.lidarFrames.params as unknown as { columns: Array<{ name: string; type: string }> }
  for (const column of params.columns) {
    if (column.name === 'x' || column.name === 'y' || column.name === 'z') column.type = 'float64'
  }
  const compiledRecipe = compileRecipeV1(recipe, bundledPhase2OperatorRegistry)
  const files = new Map<string, File | string>([
    [`sensors/lidar/${timestamp}.feather`, new File([lidarFeather()], `${timestamp}.feather`)],
    ['sensors/cameras/ring_front_center/1000100.jpg', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], '1000100.jpg')],
  ])
  return { database, files, compiledRecipe }
}

describe('Argoverse 2 recipe-backed NormalizedSceneV1', () => {
  it('binds string sensor identities and capabilities from actual outputs', () => {
    const { database, files, compiledRecipe } = fixture()
    const { scene, diagnostics } = bindAV2RecipeSceneV1({
      compiledRecipe,
      database,
      source: new MappedByteSourceV1(files),
    })
    expect(diagnostics).toEqual([])
    expect(scene.manifest.capabilities).toEqual(compiledRecipe.capabilities)
    expect(scene.relations.cameraCalibrations.get('ring_front_center')).toMatchObject({
      distortionModel: 'brown-conrady',
      distortion: [0, 0, 0, 0, 0],
    })
    expect(scene.relations.cameraCalibrations.has('lidar')).toBe(false)
    expect(scene.relations.staticTransforms.map((transform) => transform.childFrameId)).toContain('lidar-frame')
  })

  it('matches compatibility metadata structurally and numerically in a headless frame', async () => {
    const { database, files, compiledRecipe } = fixture()
    const legacy = loadAV2LogMetadata(database)
    const { scene, executionProfile } = await bindRecipeSceneV1({
      compiledRecipe,
      source: new MappedByteSourceV1(files),
      preparation: prepareFeatherTimelineRuntimeV1(database),
    })
    expect(executionProfile).toBe('core/feather-timeline@1')
    const actual = await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })
    const legacyBox = legacy.lidarBoxByFrame.get(database.lidarTimestamps[0])![0]
    const expected: NormalizedFrameV1 = {
      ...actual,
      timestampMicros: legacy.timestamps[0] / 1_000n,
      worldFromEgo: new Float64Array(legacy.poseByFrameIndex.get(0)!),
      pointClouds: [{
        ...actual.pointClouds[0],
        sensorId: 'lidar',
        frameId: 'ego',
        values: new Float32Array([1, 3, 5, 7, 2, 4, 6, 8]),
        pointCount: 2,
        stride: 4,
        attributes: ['x', 'y', 'z', 'intensity'],
      }],
      boxes3d: [{
        ...actual.boxes3d[0],
        id: String(legacyBox['key.laser_object_id']),
        center: [
          legacyBox['[LiDARBoxComponent].box.center.x'] as number,
          legacyBox['[LiDARBoxComponent].box.center.y'] as number,
          legacyBox['[LiDARBoxComponent].box.center.z'] as number,
        ],
        dimensions: [
          legacyBox['[LiDARBoxComponent].box.size.x'] as number,
          legacyBox['[LiDARBoxComponent].box.size.y'] as number,
          legacyBox['[LiDARBoxComponent].box.size.z'] as number,
        ],
      }],
    }
    expect(compareNormalizedFramesV1(expected, actual)).toEqual([])
    expect(actual.cameraImages).toMatchObject([{ sensorId: 'ring_front_center', timestampMicros: 1_000n }])
    expect(actual.boxes3d).toMatchObject([{
      id: 'track', classId: 'REGULAR_VEHICLE', center: [10, 0, 0], dimensions: [4, 2, 2],
    }])
    expect(actual.boxes2d).toMatchObject([{
      cameraId: 'ring_front_center', center: [50, 50], dimensions: [25, 25],
    }])
    expect(scene.relations.box2dToBox3d.get(actual.boxes2d[0].id)).toBe('track')
    expect(scene.relations.trajectories.get('track')?.[0].classId).toBe('REGULAR_VEHICLE')
  })

  it('removes optional camera and annotation outputs when their evidence is absent', () => {
    const { database, files, compiledRecipe } = fixture()
    database.cameraFilesByFrame.clear()
    database.annotationsByTimestamp.clear()
    const { scene, diagnostics } = bindAV2RecipeSceneV1({
      compiledRecipe,
      database,
      source: new MappedByteSourceV1(files),
    })
    for (const capability of ['cameraImages', 'boxes3d', 'boxes2d', 'trajectories'] as const) {
      expect(scene.manifest.capabilities.has(capability)).toBe(false)
      expect(diagnostics).toContainEqual(expect.objectContaining({ jsonPointer: `/outputs/${capability}` }))
    }
  })

  it('binds a learned recipe identity through the same operator-profile execution path', async () => {
    const { database, files, compiledRecipe } = fixture()
    const learnedRecipe = structuredClone(compiledRecipe.recipe)
    Object.assign(learnedRecipe.scene, { formatId: 'learned-av2-compatible' })
    const learnedCompiled = compileRecipeV1(learnedRecipe, bundledPhase2OperatorRegistry)

    const { scene } = await bindRecipeSceneV1({
      compiledRecipe: learnedCompiled,
      source: new MappedByteSourceV1(files),
      preparation: prepareFeatherTimelineRuntimeV1(database),
    })

    expect(scene.manifest.id).toBe('learned-av2-compatible')
    await expect(scene.loadFrame(0, { capabilities: scene.manifest.capabilities }))
      .resolves.toMatchObject({ index: 0, timestampMicros: 1000n })
  })
})
