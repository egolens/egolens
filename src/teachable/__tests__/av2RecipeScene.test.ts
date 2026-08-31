import { tableFromArrays, tableToIPC } from '@uwdata/flechette'
import { describe, expect, it } from 'vitest'
import { argoverse2CompiledRecipe } from '../../adapters/recipes/bundled'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import { bindRecipeSceneV1, bindRemoteRecipeSceneV1 } from '../runtime/bindRecipeScene'
import { ExecutableGraphKernelV1 } from '../runtime/GraphKernel'
import { compareNormalizedFramesV1 } from '../runtime/parity'
import { MappedByteSourceV1 } from '../source/ByteSource'
import { remoteTransportFixtureV1 } from './remoteTransportFixture'
import { expectPortableShareRoundTripV1 } from './portableShareRoundTripFixture'

function feather(columns: Record<string, unknown>): ArrayBuffer {
  const bytes = tableToIPC(tableFromArrays(columns as never))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function fixture(options: { cameras?: boolean; annotations?: boolean } = {}) {
  const cameras = options.cameras ?? true
  const annotations = options.annotations ?? true
  const timestamp = 1_000_000n
  const recipe = structuredClone(argoverse2CompiledRecipe.recipe)
  const lidarParams = recipe.sources.lidarFrames.params as unknown as { columns: Array<{ name: string; type: string }> }
  for (const column of lidarParams.columns) {
    if (column.name === 'x' || column.name === 'y' || column.name === 'z') column.type = 'float64'
  }
  const files = new Map<string, File | string>([
    [`sensors/lidar/${timestamp}.feather`, new File([feather({
      x: new Float64Array([1, 2]), y: new Float64Array([3, 4]), z: new Float64Array([5, 6]), intensity: new Uint8Array([7, 8]),
    })], `${timestamp}.feather`)],
    ['city_SE3_egovehicle.feather', new File([feather({
      timestamp_ns: new BigInt64Array([timestamp]), qw: new Float64Array([1]), qx: new Float64Array([0]), qy: new Float64Array([0]), qz: new Float64Array([0]),
      tx_m: new Float64Array([0]), ty_m: new Float64Array([0]), tz_m: new Float64Array([0]),
    })], 'city_SE3_egovehicle.feather')],
    ['calibration/egovehicle_SE3_sensor.feather', new File([feather({
      sensor_name: ['ring_front_center'], qw: new Float64Array([0.5]), qx: new Float64Array([-0.5]), qy: new Float64Array([0.5]), qz: new Float64Array([-0.5]),
      tx_m: new Float64Array([0]), ty_m: new Float64Array([0]), tz_m: new Float64Array([0]),
    })], 'egovehicle_SE3_sensor.feather')],
    ['calibration/intrinsics.feather', new File([feather({
      sensor_name: ['ring_front_center'], fx_px: new Float64Array([100]), fy_px: new Float64Array([100]), cx_px: new Float64Array([50]), cy_px: new Float64Array([50]),
      k1: new Float64Array([0]), k2: new Float64Array([0]), k3: new Float64Array([0]), height_px: new Uint16Array([100]), width_px: new Uint16Array([100]),
    })], 'intrinsics.feather')],
  ])
  if (cameras) files.set('sensors/cameras/ring_front_center/1000100.jpg', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], '1000100.jpg'))
  if (annotations) files.set('annotations.feather', new File([feather({
    timestamp_ns: new BigInt64Array([timestamp]), category: ['REGULAR_VEHICLE'], track_uuid: ['track'],
    qw: new Float64Array([1]), qx: new Float64Array([0]), qy: new Float64Array([0]), qz: new Float64Array([0]),
    tx_m: new Float64Array([10]), ty_m: new Float64Array([0]), tz_m: new Float64Array([0]),
    length_m: new Float64Array([4]), width_m: new Float64Array([2]), height_m: new Float64Array([2]),
  })], 'annotations.feather'))
  return {
    compiledRecipe: compileRecipeV1(recipe, bundledPhase2OperatorRegistry),
    files,
    inventoryEntries: [...files].map(([path, value]) => ({ path, size: typeof value === 'string' ? null : value.size })),
  }
}

describe('Argoverse 2 executable recipe graph', () => {
  it('accounts for deterministic source/node execution before lazy frame reads', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
      compiledRecipe, source: new MappedByteSourceV1(files), inventory: inventoryEntries,
    })
    expect(graph.resources.nodesExecuted).toBe(14)
    expect(graph.resources.allocationBytes).toBeGreaterThan(0)
    expect(graph.resources.sourceBytesRead).toBeGreaterThan(0)
    expect([...graph.outputs.keys()]).toEqual([
      'timeline', 'egoPoses', 'pointClouds', 'cameraImages', 'boxes3d', 'boxes2d', 'trajectories', 'segmentMetadata',
    ])
    graph.dispose()
    graph.dispose()
    expect(graph.abortController.signal.aborted).toBe(true)
    expect(graph.resources.allocationBytes).toBe(0)
  })

  it('executes declared sources and nodes into the full normalized capability surface', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const { scene, diagnostics, metadata } = await bindRecipeSceneV1({
      compiledRecipe, source: new MappedByteSourceV1(files), inventoryEntries, sceneId: 'av2-log',
    })
    expect(diagnostics).toEqual([])
    expect(scene.manifest.capabilities).toEqual(compiledRecipe.capabilities)
    expect(scene.index.segments[0]).toMatchObject({ id: 'av2-log', frameCount: 1 })
    expect(scene.relations.cameraCalibrations.get('ring_front_center')).toMatchObject({
      distortionModel: 'brown-conrady', distortion: [0, 0, 0, 0, 0],
    })
    expect(metadata.timestamps).toEqual([1_000_000n])
    expect(metadata.worldOriginInverse?.map((value) => Math.abs(value))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(metadata.segmentMeta?.objectCounts).toEqual({ 1: 1 })

    const frame = await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })
    expect(frame.timestampMicros).toBe(1_000n)
    expect(frame.worldFromEgo).toEqual(new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
    expect(frame.pointClouds[0]).toMatchObject({ sensorId: 'lidar', frameId: 'ego', pointCount: 2, stride: 4, attributes: ['x', 'y', 'z', 'intensity'] })
    expect(frame.pointClouds[0].values).toEqual(new Float32Array([1, 3, 5, 7, 2, 4, 6, 8]))
    expect(frame.cameraImages).toMatchObject([{ sensorId: 'ring_front_center', timestampMicros: 1_000n }])
    expect(frame.boxes3d).toMatchObject([{ id: 'track', classId: 'REGULAR_VEHICLE', center: [10, 0, 0], dimensions: [4, 2, 2] }])
    expect(frame.boxes2d).toMatchObject([{ cameraId: 'ring_front_center', center: [50, 50], dimensions: [25, 25] }])
    expect(scene.relations.box2dToBox3d.get(frame.boxes2d[0].id)).toBe('track')
    expect(scene.relations.trajectories.get('track')?.[0].classId).toBe('REGULAR_VEHICLE')
  })

  it('derives optional capabilities from graph evidence', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture({ cameras: false, annotations: false })
    const { scene, diagnostics } = await bindRecipeSceneV1({ compiledRecipe, source: new MappedByteSourceV1(files), inventoryEntries })
    for (const capability of ['cameraImages', 'boxes3d', 'boxes2d', 'trajectories'] as const) {
      expect(scene.manifest.capabilities.has(capability)).toBe(false)
      expect(diagnostics).toContainEqual(expect.objectContaining({ jsonPointer: `/outputs/${capability}` }))
    }
  })

  it('binds learned identities without a provider-specific prepared database', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const learned = structuredClone(compiledRecipe.recipe)
    learned.scene.formatId = 'learned-av2-compatible'
    const { scene } = await bindRecipeSceneV1({
      compiledRecipe: compileRecipeV1(learned, bundledPhase2OperatorRegistry), source: new MappedByteSourceV1(files), inventoryEntries,
    })
    expect(scene.manifest.id).toBe('learned-av2-compatible')
    await expect(scene.loadFrame(0, { capabilities: scene.manifest.capabilities })).resolves.toMatchObject({ index: 0, timestampMicros: 1_000n })
  })

  it('cancels graph-backed reads and disposes idempotently', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const { scene } = await bindRecipeSceneV1({ compiledRecipe, source: new MappedByteSourceV1(files), inventoryEntries })
    const controller = new AbortController()
    controller.abort()
    await expect(scene.loadFrame(0, { capabilities: scene.manifest.capabilities, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    scene.dispose()
    scene.dispose()
    await expect(scene.loadFrame(0, { capabilities: scene.manifest.capabilities })).rejects.toThrow(/disposed/u)
  })

  it('binds byte-identical local and catalog-backed remote bytes without graph changes', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const local = await bindRecipeSceneV1({
      compiledRecipe, source: new MappedByteSourceV1(files), inventoryEntries, sceneId: 'av2-log',
    })
    const hosted = await remoteTransportFixtureV1(files)
    const remote = await bindRemoteRecipeSceneV1({
      compiledRecipe, remote: hosted.remote, sceneId: 'av2-log',
    })
    expect(remote.sourceManifestHash).toBe(hosted.sourceManifestHash)
    expect(remote.scene.manifest).toEqual(local.scene.manifest)
    expect(remote.metadata).toEqual(local.metadata)
    const capabilities = local.scene.manifest.capabilities
    const [localFrame, remoteFrame] = await Promise.all([
      local.scene.loadFrame(0, { capabilities }),
      remote.scene.loadFrame(0, { capabilities }),
    ])
    expect(compareNormalizedFramesV1(localFrame, remoteFrame)).toEqual([])
    expect(hosted.requests.length).toBeGreaterThan(0)
    local.scene.dispose()
    remote.scene.dispose()
    await expect(remote.source.read('city_SE3_egovehicle.feather'))
      .rejects.toMatchObject({ code: 'REMOTE_SOURCE_DISPOSED' })
    await hosted.dispose()
  })

  it('does not fall back to local or bundled discovery after a remote transport failure', async () => {
    const { compiledRecipe, files } = fixture()
    const hosted = await remoteTransportFixtureV1(files)
    const missingRoot = hosted.remote.rootUrl.replace('/original-source/', '/missing-source/')
    await expect(bindRemoteRecipeSceneV1({
      compiledRecipe,
      remote: { ...hosted.remote, rootUrl: missingRoot },
      sceneId: 'av2-log',
    })).rejects.toMatchObject({ code: 'REMOTE_SOURCE_NOT_FOUND' })
    await hosted.dispose()
  })

  it('restores a counted portable share in an empty profile through the ordinary store path', async () => {
    const { compiledRecipe, files } = fixture()
    await expectPortableShareRoundTripV1({ entries: files, compiledRecipe, sceneId: 'av2-log' })
  })
})
