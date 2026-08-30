import type { DatasetManifest, MetadataBundle } from '../../types/dataset'
import type { PointCloud } from '../../utils/rangeImage'
import type { ParquetRow } from '../../utils/merge'
import type { EgoLensAdapterRecipeV1, RecipeSourceFieldRoleV1 } from '../recipe/types'
import type {
  NormalizedBox2dV1,
  NormalizedBox3dV1,
  NormalizedFrameV1,
  NormalizedManifestV1,
  NormalizedSceneV1,
} from './normalizedScene'

export interface LegacyFrameBridgeV1 {
  readonly timestamp: bigint
  readonly sensorClouds: Map<number, PointCloud>
  readonly boxes: ParquetRow[]
  readonly cameraBoxes: ParquetRow[]
  readonly cameraImages: Map<number, ArrayBuffer>
  readonly vehiclePose: number[] | null
}

export interface LegacySceneBridgeV1 {
  readonly manifest: DatasetManifest
  readonly metadata: MetadataBundle
  loadFrame(index: number): Promise<LegacyFrameBridgeV1>
  dispose(): void
}

export interface DatasetManifestProjectionV1 {
  readonly knownComponents: readonly string[]
  readonly requiredComponents: readonly string[]
  readonly columnMap: DatasetManifest['columnMap']
}

const EMPTY_PROJECTION: DatasetManifestProjectionV1 = {
  knownComponents: [],
  requiredComponents: [],
  columnMap: {
    frameTimestamp: '',
    laserName: '',
    rangeImageShape: '',
    rangeImageValues: '',
    vehiclePose: '',
  },
}

const LEGACY_COLUMN_ROLES: Readonly<Record<RecipeSourceFieldRoleV1, keyof DatasetManifest['columnMap']>> = {
  timestamp: 'frameTimestamp',
  sensorId: 'laserName',
  rangeImageShape: 'rangeImageShape',
  rangeImageValues: 'rangeImageValues',
  egoPose: 'vehiclePose',
}

/** Raw field names remain in source bindings and are projected only at the legacy edge. */
export function recipeManifestProjection(recipe: EgoLensAdapterRecipeV1): DatasetManifestProjectionV1 {
  const rootEntries = recipe.match.inventory.rootEntries
  const columnMap = { ...EMPTY_PROJECTION.columnMap }
  for (const source of Object.values(recipe.sources)) {
    for (const [role, field] of Object.entries(source.bindings ?? {})) {
      columnMap[LEGACY_COLUMN_ROLES[role as RecipeSourceFieldRoleV1]] = field
    }
  }
  return {
    knownComponents: rootEntries.map((entry) => entry.path),
    requiredComponents: rootEntries.filter((entry) => entry.required).map((entry) => entry.path),
    columnMap,
  }
}

function taxonomyRendererIds(manifest: NormalizedManifestV1): Map<string, number> {
  return new Map(manifest.taxonomies.flatMap((taxonomy) =>
    taxonomy.classes.map((entry) => [entry.id, entry.rendererId] as const),
  ))
}

function cameraFlex(width: number, height: number, view: string): number {
  const isFront = view === 'front'
  if (width >= height) return isFront ? 1.3 : 1
  return isFront ? 1 : 0.8
}

export function normalizedManifestToDatasetManifest(
  manifest: NormalizedManifestV1,
  projection: DatasetManifestProjectionV1 = EMPTY_PROJECTION,
): DatasetManifest {
  const lidars = manifest.sensors.filter((sensor) => sensor.modality === 'lidar' || sensor.modality === 'radar')
  const cameras = manifest.sensors.filter((sensor) => sensor.modality === 'camera')
  const classes = manifest.taxonomies.find((taxonomy) => taxonomy.role === 'objects')?.classes ?? []
  const lidarTaxonomy = manifest.taxonomies.find((taxonomy) => taxonomy.role === 'lidar-semantics')
  const cameraTaxonomy = manifest.taxonomies.find((taxonomy) => taxonomy.role === 'camera-semantics')
  const cameraAliases = Object.fromEntries(cameras.flatMap((sensor) =>
    (sensor.image?.aliases ?? []).map((alias) => [alias, sensor.rendererId] as const),
  ))
  const intensityRange = manifest.pointAttributes.find((attribute) => attribute.id === 'intensity')?.range

  return {
    id: manifest.id,
    name: manifest.name,
    knownComponents: [...projection.knownComponents],
    requiredComponents: [...projection.requiredComponents],
    lidarSensors: lidars.map((sensor) => ({
      id: sensor.rendererId,
      label: sensor.label,
      color: sensor.color,
    })),
    cameraSensors: cameras.map((sensor) => ({
      id: sensor.rendererId,
      label: sensor.label,
      color: sensor.color,
      width: sensor.image?.width ?? 1,
      height: sensor.image?.height ?? 1,
      flex: cameraFlex(sensor.image?.width ?? 1, sensor.image?.height ?? 1, sensor.image?.view ?? ''),
    })),
    boxTypes: classes.map((entry) => ({
      id: entry.rendererId,
      label: entry.label,
      color: entry.color,
      ...(entry.modelHint ? { model: entry.modelHint } : {}),
    })),
    frameRate: manifest.nominalFrameRate,
    pointStride: manifest.pointLayout.interleavedAttributes.length,
    colormapModes: [...manifest.pointLayout.colorModes],
    ...(intensityRange ? { intensityRange: [...intensityRange] as [number, number] } : {}),
    cameraColors: Object.fromEntries(cameras.map((sensor) => [sensor.rendererId, sensor.color])),
    cameraPovLabels: Object.fromEntries(cameras.map((sensor) => [sensor.rendererId, sensor.image?.povLabel ?? sensor.label])),
    ...(Object.keys(cameraAliases).length > 0 ? { cameraAliases } : {}),
    overlayModes: [
      ...(manifest.capabilities.has('boxes2d') ? ['bbox2d' as const] : []),
      ...(manifest.capabilities.has('cameraSegmentation') ? ['segmentation' as const] : []),
      ...(manifest.capabilities.has('keypoints2d') ? ['keypoints2d' as const] : []),
      ...(manifest.capabilities.has('cameraImages') && manifest.capabilities.has('pointClouds') ? ['lidarProjection' as const] : []),
    ],
    annotationModes: [
      ...(manifest.capabilities.has('boxes3d') ? ['bbox3d' as const] : []),
      ...(manifest.capabilities.has('keypoints3d') ? ['keypoints3d' as const] : []),
    ],
    ...(lidarTaxonomy?.palette ? {
      semanticPalette: lidarTaxonomy.palette.map((color) => [...color] as [number, number, number]),
      semanticLabels: lidarTaxonomy.classes.map((entry) => entry.label),
    } : {}),
    ...(cameraTaxonomy?.palette ? {
      cameraSemanticPalette: cameraTaxonomy.palette.map((color) => [...color] as [number, number, number]),
      cameraSemanticLabels: cameraTaxonomy.classes.map((entry) => entry.label),
    } : {}),
    columnMap: { ...projection.columnMap },
  }
}

function bridgeBox3d(box: NormalizedBox3dV1, classIds: ReadonlyMap<string, number>): ParquetRow {
  return {
    'key.laser_object_id': box.objectId,
    '[LiDARBoxComponent].box.center.x': box.center[0],
    '[LiDARBoxComponent].box.center.y': box.center[1],
    '[LiDARBoxComponent].box.center.z': box.center[2],
    '[LiDARBoxComponent].box.size.x': box.dimensions[0],
    '[LiDARBoxComponent].box.size.y': box.dimensions[1],
    '[LiDARBoxComponent].box.size.z': box.dimensions[2],
    '[LiDARBoxComponent].box.heading': box.heading ?? 0,
    '[LiDARBoxComponent].type': classIds.get(box.classId) ?? 0,
  }
}

function bridgeBox2d(box: NormalizedBox2dV1, cameraIds: ReadonlyMap<string, number>, classIds: ReadonlyMap<string, number>): ParquetRow {
  return {
    'key.camera_object_id': box.objectId,
    'key.camera_name': cameraIds.get(box.cameraId) ?? 0,
    '[CameraBoxComponent].box.center.x': box.center[0],
    '[CameraBoxComponent].box.center.y': box.center[1],
    '[CameraBoxComponent].box.size.x': box.dimensions[0],
    '[CameraBoxComponent].box.size.y': box.dimensions[1],
    '[CameraBoxComponent].type': classIds.get(box.classId) ?? 0,
  }
}

export function bridgeNormalizedFrame(frame: NormalizedFrameV1, manifest: NormalizedManifestV1): LegacyFrameBridgeV1 {
  const sensorIds = new Map(manifest.sensors.map((sensor) => [sensor.id, sensor.rendererId]))
  const classIds = taxonomyRendererIds(manifest)
  const sensorClouds = new Map<number, PointCloud>()
  for (const cloud of [...frame.pointClouds, ...frame.radarPointClouds]) {
    const rendererId = sensorIds.get(cloud.sensorId)
    if (rendererId === undefined) continue
    sensorClouds.set(rendererId, {
      positions: cloud.values,
      pointCount: cloud.pointCount,
      segLabels: cloud.semanticLabels instanceof Uint8Array ? cloud.semanticLabels : undefined,
      panopticLabels: cloud.panopticLabels instanceof Uint16Array ? cloud.panopticLabels : undefined,
      cameraProjection: cloud.cameraProjection,
      cameraRgb: cloud.cameraRgb,
      validIndices: cloud.sourceIndices,
    })
  }

  return {
    timestamp: frame.timestampMicros,
    sensorClouds,
    boxes: frame.boxes3d.map((box) => bridgeBox3d(box, classIds)),
    cameraBoxes: frame.boxes2d.map((box) => bridgeBox2d(box, sensorIds, classIds)),
    cameraImages: new Map(frame.cameraImages.flatMap((camera) => {
      const rendererId = sensorIds.get(camera.sensorId)
      return rendererId === undefined ? [] : [[rendererId, camera.encodedBytes] as const]
    })),
    vehiclePose: frame.worldFromEgo ? Array.from(frame.worldFromEgo) : null,
  }
}

/**
 * Temporary bridge used while renderers still consume MetadataBundle/FrameData.
 * It is intentionally one-way so legacy field names cannot leak into recipes.
 */
export function bridgeNormalizedScene(scene: NormalizedSceneV1): LegacySceneBridgeV1 {
  const timestamps = [...scene.index.timestampsMicros]
  const timestampToFrame = new Map(timestamps.map((timestamp, index) => [timestamp, index]))
  const poseByFrameIndex = new Map<number, number[]>()
  const objectTrajectories = new Map([...scene.relations.trajectories].map(([objectId, points]) => [
    objectId,
    points.map((point) => ({
      frameIndex: point.frameIndex,
      x: point.position[0],
      y: point.position[1],
      z: point.position[2],
      type: taxonomyRendererIds(scene.manifest).get(point.classId) ?? 0,
    })),
  ]))
  const assocCamToLaser = new Map(scene.relations.box2dToBox3d)
  const assocLaserToCams = new Map<string, Set<string>>()
  for (const [cameraId, lidarId] of assocCamToLaser) {
    const ids = assocLaserToCams.get(lidarId) ?? new Set<string>()
    ids.add(cameraId)
    assocLaserToCams.set(lidarId, ids)
  }

  return {
    manifest: normalizedManifestToDatasetManifest(scene.manifest),
    metadata: {
      timestamps,
      timestampToFrame,
      vehiclePoseByFrame: new Map(),
      worldOriginInverse: null,
      poseByFrameIndex,
      lidarCalibrations: new Map(),
      cameraCalibrations: [],
      lidarBoxByFrame: new Map(),
      cameraBoxByFrame: new Map(),
      objectTrajectories,
      assocCamToLaser,
      assocLaserToCams,
      hasBoxData: scene.manifest.capabilities.has('boxes3d'),
      segmentMeta: null,
      hasSegmentation: scene.manifest.capabilities.has('lidarSegmentation'),
      hasKeypoints: scene.manifest.capabilities.has('keypoints3d') || scene.manifest.capabilities.has('keypoints2d'),
      hasCameraSegmentation: scene.manifest.capabilities.has('cameraSegmentation'),
    },
    loadFrame: async (index) => bridgeNormalizedFrame(await scene.loadFrame(index, {
      capabilities: scene.manifest.capabilities,
    }), scene.manifest),
    dispose: () => scene.dispose(),
  }
}
