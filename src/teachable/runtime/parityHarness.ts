import { canonicalizeJson } from '../recipe/canonicalize'
import type { JsonValue } from '../recipe/types'
import type { NormalizedFrameV1, NormalizedSceneV1 } from './normalizedScene'

export interface ParityHarnessOptions {
  readonly frameIndices?: readonly number[]
  readonly sampleValuesPerBuffer?: number
}

export interface ParityDifference {
  readonly path: string
  readonly legacy: JsonValue | undefined
  readonly recipe: JsonValue | undefined
}

export interface ParityReport {
  readonly equal: boolean
  readonly legacySummary: JsonValue
  readonly recipeSummary: JsonValue
  readonly differences: readonly ParityDifference[]
}

type NumericArray = Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int16Array

function sampleBuffer(values: NumericArray, limit: number): JsonValue {
  if (values.length === 0) return { type: values.constructor.name, length: 0, samples: [] }
  const count = Math.min(values.length, limit)
  const samples: number[] = []
  for (let index = 0; index < count; index += 1) {
    const sourceIndex = count === 1 ? 0 : Math.round(index * (values.length - 1) / (count - 1))
    samples.push(values[sourceIndex])
  }
  return { type: values.constructor.name, length: values.length, samples }
}

function summarizeFrame(frame: NormalizedFrameV1, sampleLimit: number): JsonValue {
  return {
    index: frame.index,
    timestampMicros: frame.timestampMicros.toString(),
    worldFromEgo: frame.worldFromEgo ? sampleBuffer(frame.worldFromEgo, 16) : null,
    pointClouds: frame.pointClouds.map((cloud) => ({
      sensorId: cloud.sensorId,
      frameId: cloud.frameId,
      pointCount: cloud.pointCount,
      stride: cloud.stride,
      attributes: [...cloud.attributes],
      values: sampleBuffer(cloud.values, sampleLimit),
      semanticLabels: cloud.semanticLabels ? sampleBuffer(cloud.semanticLabels, sampleLimit) : null,
      panopticLabels: cloud.panopticLabels ? sampleBuffer(cloud.panopticLabels, sampleLimit) : null,
      cameraProjection: cloud.cameraProjection ? sampleBuffer(cloud.cameraProjection, sampleLimit) : null,
    })),
    radarPointClouds: frame.radarPointClouds.map((cloud) => ({
      sensorId: cloud.sensorId,
      pointCount: cloud.pointCount,
      stride: cloud.stride,
      values: sampleBuffer(cloud.values, sampleLimit),
    })),
    cameraImages: frame.cameraImages.map((image) => ({
      sensorId: image.sensorId,
      timestampMicros: image.timestampMicros.toString(),
      byteLength: image.encodedBytes.byteLength,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      calibrationId: image.calibrationId,
    })),
    boxes3d: frame.boxes3d.map((box) => ({ ...box, center: [...box.center], dimensions: [...box.dimensions], orientation: [...box.orientation] })),
    boxes2d: frame.boxes2d.map((box) => ({ ...box, center: [...box.center], dimensions: [...box.dimensions] })),
    keypoints3d: frame.keypoints3d.map((set) => ({ ...set, points: set.points.map((point) => ({ ...point, position: [...point.position] })) })),
    keypoints2d: frame.keypoints2d.map((set) => ({ ...set, points: set.points.map((point) => ({ ...point, position: [...point.position] })) })),
    lidarSegmentation: frame.lidarSegmentation.map((segmentation) => ({
      sensorId: segmentation.sensorId,
      taxonomyId: segmentation.taxonomyId,
      divisor: segmentation.divisor ?? null,
      encoding: segmentation.encoding,
      labels: segmentation.labels instanceof ArrayBuffer
        ? { type: 'ArrayBuffer', length: segmentation.labels.byteLength }
        : sampleBuffer(segmentation.labels, sampleLimit),
    })),
    cameraSegmentation: frame.cameraSegmentation.map((segmentation) => ({
      sensorId: segmentation.sensorId,
      taxonomyId: segmentation.taxonomyId,
      divisor: segmentation.divisor ?? null,
      encoding: segmentation.encoding,
      labels: segmentation.labels instanceof ArrayBuffer
        ? { type: 'ArrayBuffer', length: segmentation.labels.byteLength }
        : sampleBuffer(segmentation.labels, sampleLimit),
    })),
  } as JsonValue
}

async function captureScene(
  createScene: () => Promise<NormalizedSceneV1>,
  options: Required<ParityHarnessOptions>,
): Promise<JsonValue> {
  const scene = await createScene()
  try {
    const last = Math.max(0, scene.index.timestampsMicros.length - 1)
    const requested = options.frameIndices.length > 0 ? options.frameIndices : [0, Math.floor(last / 2), last]
    const frameIndices = [...new Set(requested)].filter((index) => index >= 0 && index <= last).sort((a, b) => a - b)
    const frames: JsonValue[] = []
    for (const index of frameIndices) {
      const frame = await scene.loadFrame(index, { capabilities: scene.manifest.capabilities })
      frames.push(summarizeFrame(frame, options.sampleValuesPerBuffer))
    }
    return {
      manifest: {
        id: scene.manifest.id,
        name: scene.manifest.name,
        nominalFrameRate: scene.manifest.nominalFrameRate,
        sensors: scene.manifest.sensors,
        taxonomies: scene.manifest.taxonomies,
        pointAttributes: scene.manifest.pointAttributes,
        pointLayout: scene.manifest.pointLayout,
        capabilities: [...scene.manifest.capabilities].sort(),
      },
      index: {
        timestampsMicros: scene.index.timestampsMicros.map((timestamp) => timestamp.toString()),
        segments: scene.index.segments,
      },
      relations: {
        staticTransforms: scene.relations.staticTransforms.map((transform) => ({
          parentFrameId: transform.parentFrameId,
          childFrameId: transform.childFrameId,
          parentFromChild: sampleBuffer(transform.parentFromChild, 16),
        })),
        cameraCalibrationIds: [...scene.relations.cameraCalibrations.keys()].sort(),
        trajectoryIds: [...scene.relations.trajectories.keys()].sort(),
        boxAssociations: [...scene.relations.box2dToBox3d].sort(([left], [right]) => left.localeCompare(right)),
      },
      frames,
    } as unknown as JsonValue
  } finally {
    scene.dispose()
  }
}

function firstDifference(left: JsonValue | undefined, right: JsonValue | undefined, path = ''): ParityDifference[] {
  if (left === undefined || right === undefined) return [{ path: path || '/', legacy: left, recipe: right }]
  if (canonicalizeJson(left) === canonicalizeJson(right)) return []
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}/${index}`)
      if (difference.length > 0) return difference
    }
  } else if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftObject = left as Record<string, JsonValue>
    const rightObject = right as Record<string, JsonValue>
    for (const key of [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort()) {
      const difference = firstDifference(leftObject[key], rightObject[key], `${path}/${key}`)
      if (difference.length > 0) return difference
    }
  }
  return [{ path: path || '/', legacy: left, recipe: right }]
}

/**
 * Opens and disposes the oracle before opening the recipe scene. This avoids
 * the current global manifest, worker pools, and caches contaminating parity.
 */
export async function compareNormalizedScenes(
  createLegacyScene: () => Promise<NormalizedSceneV1>,
  createRecipeScene: () => Promise<NormalizedSceneV1>,
  options: ParityHarnessOptions = {},
): Promise<ParityReport> {
  const resolvedOptions: Required<ParityHarnessOptions> = {
    frameIndices: options.frameIndices ?? [],
    sampleValuesPerBuffer: options.sampleValuesPerBuffer ?? 64,
  }
  const legacySummary = await captureScene(createLegacyScene, resolvedOptions)
  const recipeSummary = await captureScene(createRecipeScene, resolvedOptions)
  const differences = firstDifference(legacySummary, recipeSummary)
  return { equal: differences.length === 0, legacySummary, recipeSummary, differences }
}
