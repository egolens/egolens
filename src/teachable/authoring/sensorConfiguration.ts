import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { EgoLensAdapterRecipeV1, RecipeSensorV1 } from '../recipe/types'
import type { SourceInventorySnapshotV1 } from './SourceInventory'

export type SensorModalityV1 = RecipeSensorV1['modality']
export const SENSOR_MODALITIES_V1: readonly SensorModalityV1[] = Object.freeze(['lidar', 'radar', 'camera'])

/**
 * The sensor layout the human confirms before authoring starts: how many
 * sensors of each modality the recipe must declare. A recipe that collapses
 * five cameras into one still validates every capability, so the counts are
 * the only public statement of the expected layout.
 */
export interface SensorConfigurationV1 {
  readonly lidar: number
  readonly radar: number
  readonly camera: number
  /** Optional stream names per modality; when present, declared sensor ids must be exactly this set. */
  readonly names?: Readonly<Partial<Record<SensorModalityV1, readonly string[]>>>
}

export interface DeclaredSensorSummaryV1 {
  readonly modality: SensorModalityV1
  readonly ids: readonly string[]
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png'])
const POINT_EXTENSIONS = new Set(['.bin', '.pcd', '.feather', '.npz', '.ply', '.pkl', '.pickle', '.gz'])

function assertCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 64) {
    throw new Error(`Sensor configuration ${name} must be an integer between 0 and 64.`)
  }
  return value
}

export function assertValidSensorConfigurationV1(value: unknown): SensorConfigurationV1 {
  if (typeof value !== 'object' || value === null) throw new Error('Sensor configuration must be an object.')
  const input = value as Record<string, unknown>
  const configuration: { lidar: number; radar: number; camera: number; names?: Partial<Record<SensorModalityV1, readonly string[]>> } = {
    lidar: assertCount(input.lidar, 'lidar'), radar: assertCount(input.radar, 'radar'), camera: assertCount(input.camera, 'camera'),
  }
  if (configuration.lidar + configuration.radar + configuration.camera === 0) {
    throw new Error('Sensor configuration must expect at least one sensor.')
  }
  if (input.names !== undefined) {
    if (typeof input.names !== 'object' || input.names === null) throw new Error('Sensor configuration names must be an object.')
    const names: Partial<Record<SensorModalityV1, readonly string[]>> = {}
    for (const modality of SENSOR_MODALITIES_V1) {
      const list = (input.names as Record<string, unknown>)[modality]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u.test(name))) {
        throw new Error(`Sensor configuration names.${modality} must list valid sensor ids.`)
      }
      if (new Set(list).size !== list.length) throw new Error(`Sensor configuration names.${modality} must be unique.`)
      if (list.length !== configuration[modality]) throw new Error(`Sensor configuration names.${modality} lists ${list.length} ids but ${configuration[modality]} sensors are expected.`)
      names[modality] = [...list]
    }
    if (Object.keys(names).length > 0) configuration.names = names
  }
  return configuration
}

/**
 * A best-effort default from the inventory layout alone: one sensor per
 * directory that holds image files (camera) or point files whose path names a
 * lidar or radar stream. Single-table layouts (Waymo Parquet) yield 0 and rely
 * on the human's confirmation.
 */
export function inferSensorConfigurationV1(snapshot: SourceInventorySnapshotV1): SensorConfigurationV1 {
  const cameraDirectories = new Set<string>()
  const lidarDirectories = new Set<string>()
  const radarDirectories = new Set<string>()
  for (const entry of snapshot.entries) {
    const segments = entry.path.split('/')
    if (segments.length < 2) continue
    const directory = segments.slice(0, -1).join('/')
    const lowered = directory.toLowerCase()
    if (IMAGE_EXTENSIONS.has(entry.extension)) {
      cameraDirectories.add(directory)
      continue
    }
    if (!POINT_EXTENSIONS.has(entry.extension)) continue
    if (/(^|\/)radar/u.test(lowered)) radarDirectories.add(directory)
    else if (/(^|\/)(lidar|velodyne|points?)/u.test(lowered)) lidarDirectories.add(directory)
  }
  // A generic leaf folder (image_02/data, velodyne_points/data) names nothing;
  // the parent folder is the stream identity.
  const GENERIC = new Set(['data', 'images', 'image', 'frames', 'files', 'raw', 'bin', 'png', 'jpg'])
  const nameOf = (directory: string) => {
    const segments = directory.split('/')
    let leaf = segments.at(-1)!
    if (GENERIC.has(leaf.toLowerCase()) && segments.length > 1) leaf = segments.at(-2)!
    return leaf.replace(/[^A-Za-z0-9_.:-]/gu, '_').replace(/^[^A-Za-z]+/u, '') || 'stream'
  }
  const unique = (directories: Set<string>) => {
    const seen = new Map<string, number>()
    return [...directories].sort().map((directory) => {
      const base = nameOf(directory)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      return count === 0 ? base : `${base}_${count + 1}`
    })
  }
  const names = {
    ...(lidarDirectories.size > 0 ? { lidar: unique(lidarDirectories) } : {}),
    ...(radarDirectories.size > 0 ? { radar: unique(radarDirectories) } : {}),
    ...(cameraDirectories.size > 0 ? { camera: unique(cameraDirectories) } : {}),
  }
  return { lidar: lidarDirectories.size, radar: radarDirectories.size, camera: cameraDirectories.size, ...(Object.keys(names).length > 0 ? { names } : {}) }
}

export function declaredSensorSummaryV1(recipe: Pick<EgoLensAdapterRecipeV1, 'scene'> | null): readonly DeclaredSensorSummaryV1[] {
  const sensors = recipe?.scene.sensors ?? []
  return SENSOR_MODALITIES_V1.map((modality) => ({
    modality,
    ids: sensors.filter((sensor) => sensor.modality === modality).map((sensor) => sensor.id),
  }))
}

/** Compile-stage diagnostics when the declared sensors disagree with the confirmed layout. */
export function sensorConfigurationDiagnosticsV1(
  recipe: Pick<EgoLensAdapterRecipeV1, 'scene'>,
  configuration: SensorConfigurationV1 | null,
): readonly AdapterDiagnostic[] {
  if (!configuration) return []
  return declaredSensorSummaryV1(recipe).flatMap(({ modality, ids }) => {
    const expected = configuration[modality]
    const declared = ids.length === 0 ? 'none' : ids.join(', ')
    if (ids.length !== expected) {
      return [{
        stage: 'compile' as const,
        severity: 'error' as const,
        code: 'SENSOR_CONFIGURATION_UNMET',
        jsonPointer: '/scene/sensors',
        hint: `The confirmed sensor configuration expects ${expected} ${modality} sensor${expected === 1 ? '' : 's'}; the recipe declares ${ids.length} (${declared}). Declare one scene sensor per physical ${modality} stream and bind each of them.`,
      }]
    }
    const expectedNames = configuration.names?.[modality]
    if (!expectedNames) return []
    const missing = expectedNames.filter((name) => !ids.includes(name))
    const extra = ids.filter((id) => !expectedNames.includes(id))
    if (missing.length === 0 && extra.length === 0) return []
    return [{
      stage: 'compile' as const,
      severity: 'error' as const,
      code: 'SENSOR_CONFIGURATION_UNMET',
      jsonPointer: '/scene/sensors',
      hint: `The confirmed ${modality} sensor ids are ${expectedNames.join(', ')}; the recipe declares ${declared}${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''}${extra.length > 0 ? ` (unexpected: ${extra.join(', ')})` : ''}. Use exactly the confirmed ids as scene sensor ids.`,
    }]
  })
}
