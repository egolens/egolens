import type { DatasetManifest } from '../../types/dataset'
import type { PointCloud } from '../../utils/rangeImage'
import type { ParquetRow } from '../../utils/merge'
import type { EgoLensAdapterRecipeV1, RecipeSourceFieldRoleV1 } from '../recipe/types'
import type {
  NormalizedBox2dV1,
  NormalizedBox3dV1,
  NormalizedFrameV1,
  NormalizedManifestV1,
  NormalizedPointCloudV1,
} from './normalizedScene'

/** Renderer-facing frame shape while the R3F components migrate independently. */
export interface RendererFrameV1 {
  readonly timestamp: bigint
  readonly sensorClouds: Map<number, PointCloud>
  readonly boxes: ParquetRow[]
  readonly cameraBoxes: ParquetRow[]
  readonly cameraImages: Map<number, ArrayBuffer>
  readonly vehiclePose: number[] | null
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

interface ManifestBridgeCacheV1 {
  readonly sensorIds: ReadonlyMap<string, number>
  readonly classIds: ReadonlyMap<string, number>
  readonly lidarPointClouds: WeakMap<NormalizedPointCloudV1, PointCloud>
  readonly radarPointClouds: WeakMap<NormalizedPointCloudV1, PointCloud>
  readonly sensorCloudMaps: WeakMap<
    NormalizedFrameV1['pointClouds'],
    WeakMap<NormalizedFrameV1['radarPointClouds'], Map<number, PointCloud>>
  >
  readonly boxes3d: WeakMap<readonly NormalizedBox3dV1[], ParquetRow[]>
  readonly boxes2d: WeakMap<readonly NormalizedBox2dV1[], ParquetRow[]>
  readonly cameraImages: WeakMap<NormalizedFrameV1['cameraImages'], Map<number, ArrayBuffer>>
}

/**
 * Renderer projections are derived views of normalized cache entries. Weak
 * keys keep those views tied to the authoritative scene cache instead of
 * introducing a second cache owner or retaining evicted frame buffers.
 */
const manifestBridgeCaches = new WeakMap<NormalizedManifestV1, ManifestBridgeCacheV1>()

function manifestBridgeCache(manifest: NormalizedManifestV1): ManifestBridgeCacheV1 {
  const cached = manifestBridgeCaches.get(manifest)
  if (cached) return cached
  const created: ManifestBridgeCacheV1 = {
    sensorIds: new Map(manifest.sensors.map((sensor) => [sensor.id, sensor.rendererId])),
    classIds: taxonomyRendererIds(manifest),
    lidarPointClouds: new WeakMap(),
    radarPointClouds: new WeakMap(),
    sensorCloudMaps: new WeakMap(),
    boxes3d: new WeakMap(),
    boxes2d: new WeakMap(),
    cameraImages: new WeakMap(),
  }
  manifestBridgeCaches.set(manifest, created)
  return created
}

const LEGACY_COLUMN_ROLES: Readonly<Record<RecipeSourceFieldRoleV1, keyof DatasetManifest['columnMap']>> = {
  timestamp: 'frameTimestamp',
  sensorId: 'laserName',
  rangeImageShape: 'rangeImageShape',
  rangeImageValues: 'rangeImageValues',
  egoPose: 'vehiclePose',
}

/** Raw field names remain in source bindings and are projected only at the renderer edge. */
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

/**
 * The legacy renderer has a fixed five-float radar layout even though the
 * normalized contract preserves the source velocity components. Keep that
 * lossy projection at the renderer boundary so recipes and oracle artifacts
 * retain the richer, dataset-neutral representation.
 */
function bridgeRadarValues(cloud: NormalizedPointCloudV1): Float32Array {
  const attributeIndex = new Map(cloud.attributes.map((attribute, index) => [attribute, index]))
  const speedComp = attributeIndex.get('speedComp')
  const speedRaw = attributeIndex.get('speedRaw')
  const vxComp = attributeIndex.get('vx_comp')
  const vyComp = attributeIndex.get('vy_comp')
  const vx = attributeIndex.get('vx')
  const vy = attributeIndex.get('vy')
  const values = new Float32Array(cloud.pointCount * 5)

  for (let pointIndex = 0; pointIndex < cloud.pointCount; pointIndex += 1) {
    const source = pointIndex * cloud.stride
    const target = pointIndex * 5
    values[target] = cloud.values[source]
    values[target + 1] = cloud.values[source + 1]
    values[target + 2] = cloud.values[source + 2]
    values[target + 3] = speedComp !== undefined
      ? cloud.values[source + speedComp]
      : vxComp !== undefined && vyComp !== undefined
        ? Math.hypot(cloud.values[source + vxComp], cloud.values[source + vyComp])
        : 0
    values[target + 4] = speedRaw !== undefined
      ? cloud.values[source + speedRaw]
      : vx !== undefined && vy !== undefined
        ? Math.hypot(cloud.values[source + vx], cloud.values[source + vy])
        : 0
  }
  return values
}

function bridgePointCloud(
  cloud: NormalizedPointCloudV1,
  radar: boolean,
  cache: ManifestBridgeCacheV1,
): PointCloud {
  const cloudCache = radar ? cache.radarPointClouds : cache.lidarPointClouds
  const cached = cloudCache.get(cloud)
  if (cached) return cached
  const bridged: PointCloud = {
    positions: radar ? bridgeRadarValues(cloud) : cloud.values,
    pointCount: cloud.pointCount,
    segLabels: cloud.semanticLabels instanceof Uint8Array ? cloud.semanticLabels : undefined,
    panopticLabels: cloud.panopticLabels,
    cameraProjection: cloud.cameraProjection,
    cameraRgb: cloud.cameraRgb,
    validIndices: cloud.sourceIndices,
  }
  cloudCache.set(cloud, bridged)
  return bridged
}

function bridgeBoxes3d(
  boxes: readonly NormalizedBox3dV1[],
  cache: ManifestBridgeCacheV1,
): ParquetRow[] {
  const cached = cache.boxes3d.get(boxes)
  if (cached) return cached
  const bridged = boxes.map((box) => bridgeBox3d(box, cache.classIds))
  cache.boxes3d.set(boxes, bridged)
  return bridged
}

function bridgeBoxes2d(
  boxes: readonly NormalizedBox2dV1[],
  cache: ManifestBridgeCacheV1,
): ParquetRow[] {
  const cached = cache.boxes2d.get(boxes)
  if (cached) return cached
  // Projected cuboids are observations of the camera projection, not native
  // 2D rectangles. Preserve the already-shipped BoxProjectionOverlay path.
  const bridged = boxes
    .filter((box) => box.presentation !== 'projected-cuboid')
    .map((box) => bridgeBox2d(box, cache.sensorIds, cache.classIds))
  cache.boxes2d.set(boxes, bridged)
  return bridged
}

function bridgeCameraImages(
  images: NormalizedFrameV1['cameraImages'],
  cache: ManifestBridgeCacheV1,
): Map<number, ArrayBuffer> {
  const cached = cache.cameraImages.get(images)
  if (cached) return cached
  const bridged = new Map(images.flatMap((camera) => {
    const rendererId = cache.sensorIds.get(camera.sensorId)
    return rendererId === undefined ? [] : [[rendererId, camera.encodedBytes] as const]
  }))
  cache.cameraImages.set(images, bridged)
  return bridged
}

function bridgeSensorClouds(
  frame: NormalizedFrameV1,
  cache: ManifestBridgeCacheV1,
): Map<number, PointCloud> {
  let radarMaps = cache.sensorCloudMaps.get(frame.pointClouds)
  if (!radarMaps) {
    radarMaps = new WeakMap()
    cache.sensorCloudMaps.set(frame.pointClouds, radarMaps)
  }
  const cached = radarMaps.get(frame.radarPointClouds)
  if (cached) return cached
  const bridged = new Map<number, PointCloud>()
  for (const cloud of frame.pointClouds) {
    const rendererId = cache.sensorIds.get(cloud.sensorId)
    if (rendererId !== undefined) bridged.set(rendererId, bridgePointCloud(cloud, false, cache))
  }
  for (const cloud of frame.radarPointClouds) {
    const rendererId = cache.sensorIds.get(cloud.sensorId)
    if (rendererId !== undefined) bridged.set(rendererId, bridgePointCloud(cloud, true, cache))
  }
  radarMaps.set(frame.radarPointClouds, bridged)
  return bridged
}

export function bridgeNormalizedFrame(
  frame: NormalizedFrameV1,
  manifest: NormalizedManifestV1,
  rendererTimestamp: bigint = frame.timestampMicros,
): RendererFrameV1 {
  const cache = manifestBridgeCache(manifest)

  return {
    timestamp: rendererTimestamp,
    sensorClouds: bridgeSensorClouds(frame, cache),
    boxes: bridgeBoxes3d(frame.boxes3d, cache),
    cameraBoxes: bridgeBoxes2d(frame.boxes2d, cache),
    cameraImages: bridgeCameraImages(frame.cameraImages, cache),
    vehiclePose: frame.worldFromEgo ? Array.from(frame.worldFromEgo) : null,
  }
}
