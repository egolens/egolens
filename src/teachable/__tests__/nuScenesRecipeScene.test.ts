import { describe, expect, it } from 'vitest'
import { nuScenesCompiledRecipe } from '../../adapters/recipes/bundled'
import { BrowserGraphPreviewRuntimeV1 } from '../authoring/BrowserGraphPreviewRuntime'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { authoringPreviewStoreV1 } from '../authoring/previewStore'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import { bindRecipeSceneV1 } from '../runtime/bindRecipeScene'
import { ExecutableGraphKernelV1 } from '../runtime/GraphKernel'
import { assembleGraphSceneV1 } from '../runtime/GraphSceneAssembler'
import { MappedByteSourceV1 } from '../source/ByteSource'

function lidarFile(points: readonly (readonly number[])[]): File {
  const buffer = new ArrayBuffer(points.length * 20)
  const view = new DataView(buffer)
  points.forEach((point, row) => point.forEach((value, column) => {
    view.setFloat32(row * 20 + column * 4, value, true)
  }))
  return new File([buffer], 'lidar.pcd.bin')
}

function radarFile(): File {
  const header = [
    'VERSION 0.7',
    'FIELDS x y z vx vy vx_comp vy_comp',
    'SIZE 4 4 4 4 4 4 4',
    'TYPE F F F F F F F',
    'COUNT 1 1 1 1 1 1 1',
    'WIDTH 1',
    'HEIGHT 1',
    'POINTS 1',
    'DATA binary',
    '',
  ].join('\n')
  const encoded = new TextEncoder().encode(header)
  const buffer = new ArrayBuffer(encoded.length + 28)
  new Uint8Array(buffer).set(encoded)
  const view = new DataView(buffer, encoded.length)
  ;[1, 2, 3, 4, 5, 6, 7].forEach((value, index) => view.setFloat32(index * 4, value, true))
  return new File([buffer], 'radar.pcd')
}

function fixture(options: { radar?: boolean; camera?: boolean; annotations?: boolean } = {}) {
  const radar = options.radar ?? true
  const camera = options.camera ?? true
  const annotations = options.annotations ?? true
  const tables: Record<string, unknown[]> = {
    'scene.json': [{
      token: 'scene', log_token: 'log', nbr_samples: 1, first_sample_token: 'sample',
      last_sample_token: 'sample', name: 'scene-0001', description: 'clear',
    }],
    'sample.json': [{ token: 'sample', timestamp: 1_000_000, prev: '', next: '', scene_token: 'scene' }],
    'sensor.json': [
      { token: 'lidar-sensor', channel: 'LIDAR_TOP', modality: 'lidar' },
      { token: 'radar-sensor', channel: 'RADAR_FRONT', modality: 'radar' },
      { token: 'camera-sensor', channel: 'CAM_FRONT', modality: 'camera' },
      { token: 'camera-left-sensor', channel: 'CAM_FRONT_LEFT', modality: 'camera' },
    ],
    'calibrated_sensor.json': [
      { token: 'lidar-cal', sensor_token: 'lidar-sensor', translation: [10, 20, 30], rotation: [1, 0, 0, 0], camera_intrinsic: [] },
      { token: 'radar-cal', sensor_token: 'radar-sensor', translation: [0, 0, 0], rotation: [1, 0, 0, 0], camera_intrinsic: [] },
      { token: 'camera-cal', sensor_token: 'camera-sensor', translation: [0, 0, 1], rotation: [0.5, -0.5, 0.5, -0.5], camera_intrinsic: [[100, 0, 800], [0, 100, 450], [0, 0, 1]] },
      { token: 'camera-left-cal', sensor_token: 'camera-left-sensor', translation: [0, 0, 1], rotation: [0.5, -0.5, 0.5, -0.5], camera_intrinsic: [[100, 0, 800], [0, 100, 450], [0, 0, 1]] },
    ],
    'ego_pose.json': [{ token: 'pose', timestamp: 1_000_000, translation: [0, 0, 0], rotation: [1, 0, 0, 0] }],
    'sample_data.json': [
      { token: 'lidar-data', sample_token: 'sample', ego_pose_token: 'pose', calibrated_sensor_token: 'lidar-cal', timestamp: 1_000_000, fileformat: 'pcd.bin', is_key_frame: true, height: 0, width: 0, filename: 'samples/LIDAR_TOP/one.pcd.bin', prev: '', next: '' },
      { token: 'radar-data', sample_token: 'sample', ego_pose_token: 'pose', calibrated_sensor_token: 'radar-cal', timestamp: 1_000_000, fileformat: 'pcd', is_key_frame: true, height: 0, width: 0, filename: 'samples/RADAR_FRONT/one.pcd', prev: '', next: '' },
      { token: 'camera-data', sample_token: 'sample', ego_pose_token: 'pose', calibrated_sensor_token: 'camera-cal', timestamp: 1_000_000, fileformat: 'jpg', is_key_frame: true, height: 900, width: 1600, filename: 'samples/CAM_FRONT/one.jpg', prev: '', next: '' },
    ],
    'category.json': [{ token: 'category', name: 'vehicle.car', description: 'car', index: 17 }],
    'instance.json': [{ token: 'instance', category_token: 'category', nbr_annotations: 1, first_annotation_token: 'annotation', last_annotation_token: 'annotation' }],
    'sample_annotation.json': annotations ? [{
      token: 'annotation', sample_token: 'sample', instance_token: 'instance', visibility_token: '4',
      attribute_tokens: [], translation: [10, 0, 1], size: [2, 4, 2], rotation: [1, 0, 0, 0],
      prev: '', next: '', num_lidar_pts: 2, num_radar_pts: 1,
    }] : [],
    'log.json': [{ token: 'log', logfile: 'n015-2018-07-24-11-22-45+0800', vehicle: 'car', date_captured: '2018-07-24', location: 'singapore-onenorth' }],
    'lidarseg.json': [{ token: 'seg', sample_data_token: 'lidar-data', filename: 'lidarseg/v1.0-mini/one.bin' }],
    'panoptic.json': [],
  }
  const files = new Map<string, File | string>()
  for (const [name, rows] of Object.entries(tables)) {
    const path = `v1.0-mini/${name}`
    files.set(path, new File([JSON.stringify(rows)], name, { type: 'application/json' }))
  }
  files.set('samples/LIDAR_TOP/one.pcd.bin', lidarFile([[1, 2, 3, 0.5, 9], [-1, -2, -3, 0.75, 10]]))
  if (radar) files.set('samples/RADAR_FRONT/one.pcd', radarFile())
  if (camera) files.set('samples/CAM_FRONT/one.jpg', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'one.jpg'))
  files.set('lidarseg/v1.0-mini/one.bin', new File([new Uint8Array([17, 24])], 'one.bin'))
  return {
    compiledRecipe: nuScenesCompiledRecipe,
    files,
    inventoryEntries: [...files].map(([path, value]) => ({
      path,
      size: typeof value === 'string' ? null : value.size,
    })),
  }
}

describe('nuScenes executable recipe graph', () => {
  it('accounts for relational metadata eagerly and binary frame payloads lazily', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
      compiledRecipe, source: new MappedByteSourceV1(files), inventory: inventoryEntries,
    })
    expect(graph.resources.nodesExecuted).toBe(27)
    expect(graph.resources.sourceBytesRead).toBeGreaterThan(0)
    const beforeFrameRead = graph.resources.sourceBytesRead
    const { scene } = assembleGraphSceneV1({ compiledRecipe, graph, sceneId: 'scene-0001' })
    await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })
    expect(graph.resources.sourceBytesRead).toBeGreaterThan(beforeFrameRead)
    expect(graph.resources.allocationBytes).toBeGreaterThan(0)
    scene.dispose()
    scene.dispose()
    expect(graph.abortController.signal.aborted).toBe(true)
    expect(graph.resources.allocationBytes).toBe(0)
  })

  it('executes the full normalized capability surface without prepared provider state', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const { scene, diagnostics, metadata, availableSegments } = await bindRecipeSceneV1({
      compiledRecipe, source: new MappedByteSourceV1(files), inventoryEntries, sceneId: 'scene-0001',
    })
    expect(diagnostics).toEqual([])
    expect(scene.manifest.capabilities).toEqual(compiledRecipe.capabilities)
    expect(availableSegments).toEqual([expect.objectContaining({ groupId: 'scene', id: 'scene-0001' })])
    expect(scene.index.segments[0]).toMatchObject({ id: 'scene-0001', frameCount: 1 })
    expect(scene.relations.staticTransforms.map((relation) => relation.childFrameId)).toContain('LIDAR_TOP-frame')
    expect(scene.relations.cameraCalibrations.has('CAM_FRONT_LEFT')).toBe(true)
    expect(scene.relations.cameraCalibrations.has('LIDAR_TOP')).toBe(false)
    expect(metadata.timestamps).toEqual([1_000_000n])
    expect(metadata.segmentMeta).toMatchObject({
      segmentId: 'scene-0001', location: 'Singapore Onenorth', timeOfDay: 'Day', weather: 'clear', objectCounts: { 1: 1 },
    })

    const frame = await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })
    expect(frame.timestampMicros).toBe(1_000_000n)
    expect(frame.worldFromEgo).toEqual(new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
    expect(frame.pointClouds[0]).toMatchObject({
      sensorId: 'LIDAR_TOP', frameId: 'ego', pointCount: 2, stride: 4,
      attributes: ['x', 'y', 'z', 'intensity'],
    })
    expect(frame.pointClouds[0].values).toEqual(new Float32Array([11, 22, 33, 0.5, 9, 18, 27, 0.75]))
    expect(frame.pointClouds[0].semanticLabels).toEqual(new Uint8Array([17, 24]))
    expect(frame.radarPointClouds[0].values).toEqual(new Float32Array([1, 2, 3, 4, 5, 6, 7]))
    expect(frame.cameraImages).toMatchObject([{ sensorId: 'CAM_FRONT', timestampMicros: 1_000_000n }])
    expect(frame.boxes3d).toMatchObject([{ id: 'instance', classId: 'car', center: [10, 0, 1], dimensions: [4, 2, 2] }])
    expect(frame.boxes2d.length).toBeGreaterThan(0)
    expect(frame.lidarSegmentation).toMatchObject([{ sensorId: 'LIDAR_TOP', taxonomyId: 'nuscenes-lidar-semantics' }])
    expect(scene.relations.trajectories.get('instance')).toHaveLength(1)
  })

  it('derives optional capabilities from selected graph evidence', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture({ radar: false, annotations: false })
    const { scene, diagnostics } = await bindRecipeSceneV1({
      compiledRecipe, source: new MappedByteSourceV1(files), inventoryEntries, sceneId: 'scene-0001',
    })
    for (const capability of ['radarPointClouds', 'boxes3d', 'boxes2d', 'trajectories'] as const) {
      expect(scene.manifest.capabilities.has(capability)).toBe(false)
      expect(diagnostics).toContainEqual(expect.objectContaining({ jsonPointer: `/outputs/${capability}` }))
    }

    const withoutCamera = fixture({ camera: false })
    const cameraBinding = await bindRecipeSceneV1({
      compiledRecipe: withoutCamera.compiledRecipe,
      source: new MappedByteSourceV1(withoutCamera.files),
      inventoryEntries: withoutCamera.inventoryEntries,
      sceneId: 'scene-0001',
    })
    expect(cameraBinding.scene.manifest.capabilities.has('boxes3d')).toBe(true)
    for (const capability of ['cameraImages', 'boxes2d'] as const) {
      expect(cameraBinding.scene.manifest.capabilities.has(capability)).toBe(false)
      expect(cameraBinding.diagnostics).toContainEqual(expect.objectContaining({ jsonPointer: `/outputs/${capability}` }))
    }
  })

  it('fails closed with the bound path when required relational input is missing or malformed', async () => {
    const missing = fixture()
    missing.files.delete('v1.0-mini/ego_pose.json')
    await expect(bindRecipeSceneV1({
      compiledRecipe: missing.compiledRecipe,
      source: new MappedByteSourceV1(missing.files),
      inventoryEntries: [...missing.files].map(([path, value]) => ({
        path, size: typeof value === 'string' ? null : value.size,
      })),
    })).rejects.toThrow(/egoPoses matched 0/u)

    const malformed = fixture()
    malformed.files.set('v1.0-mini/scene.json', new File(['{ invalid'], 'scene.json'))
    await expect(bindRecipeSceneV1({
      compiledRecipe: malformed.compiledRecipe,
      source: new MappedByteSourceV1(malformed.files),
      inventoryEntries: malformed.inventoryEntries,
    })).rejects.toThrow(/GRAPH_JSON_DECODE_FAILED: v1\.0-mini\/scene\.json/u)
  })

  it('binds learned identities through the same relational graph profile', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const learned = structuredClone(compiledRecipe.recipe)
    learned.scene.formatId = 'learned-nuscenes-compatible'
    const { scene } = await bindRecipeSceneV1({
      compiledRecipe: compileRecipeV1(learned, bundledPhase2OperatorRegistry),
      source: new MappedByteSourceV1(files), inventoryEntries, sceneId: 'scene-0001',
    })
    expect(scene.manifest.id).toBe('learned-nuscenes-compatible')
    await expect(scene.loadFrame(0, { capabilities: scene.manifest.capabilities })).resolves.toMatchObject({
      index: 0, timestampMicros: 1_000_000n,
    })
  })

  it('runs browser authoring preview through the same graph and assembler', async () => {
    authoringPreviewStoreV1.clear()
    const { compiledRecipe, files } = fixture()
    const inventory = new SourceInventoryV1(
      [...files].map(([path, value]) => [path, value] as [string, File]),
      { sessionId: 'nuscenes-graph-preview' },
    )
    const prepared = await new BrowserGraphPreviewRuntimeV1().preparePreview(
      compiledRecipe,
      inventory.resolveAuthorizedSource(),
      inventory,
    )
    expect(prepared.validationSummary).toMatchObject({ passed: true, frameCount: 1, sampleFrames: [0] })
    expect(prepared.capabilities).toEqual(compiledRecipe.capabilities)
    prepared.commit()
    expect(authoringPreviewStoreV1.getSnapshot()).toMatchObject({
      formatId: 'nuscenes', frameCount: 1, sampledFrames: [0],
      capabilitySamples: { pointClouds: [2], cameraImages: [1], boxes3d: [1], lidarSegmentation: [1] },
    })
    prepared.dispose()
  })

  it('cancels graph-backed reads and disposes idempotently', async () => {
    const { compiledRecipe, files, inventoryEntries } = fixture()
    const { scene } = await bindRecipeSceneV1({
      compiledRecipe, source: new MappedByteSourceV1(files), inventoryEntries, sceneId: 'scene-0001',
    })
    const controller = new AbortController()
    controller.abort()
    await expect(scene.loadFrame(0, {
      capabilities: scene.manifest.capabilities, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    scene.dispose()
    scene.dispose()
    await expect(scene.loadFrame(0, { capabilities: scene.manifest.capabilities })).rejects.toThrow(/disposed/u)
  })
})
