import { canonicalizeJson } from '../recipe/canonicalize'
import type { JsonValue } from '../recipe/types'
import type {
  NormalizedCapabilityV1,
  NormalizedFrameV1,
  NormalizedPointCloudV1,
  NormalizedSceneV1,
  NormalizedSegmentationV1,
} from '../runtime/normalizedScene'

type NumericView = Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int16Array

export interface PerceptualReferenceV1 {
  readonly id: string
  readonly sha256: string
  readonly width: number
  readonly height: number
}

export interface SceneConformanceArtifactV1 {
  readonly kind: 'egolens-scene-conformance'
  readonly schemaVersion: 1
  readonly target: {
    readonly datasetId: string
    readonly caseId: string
  }
  readonly coverage: {
    readonly requiredCapabilities: readonly NormalizedCapabilityV1[]
    readonly frameIndices: readonly number[]
    readonly completeTimeline: boolean
    readonly perceptualReferenceIds: readonly string[]
  }
  readonly structural: JsonValue
  readonly numeric: JsonValue
  readonly perceptual: readonly PerceptualReferenceV1[]
  readonly summaryHash: string
  readonly artifactHash: string
}

export interface OracleBundleV1 {
  readonly kind: 'egolens-hidden-oracle'
  readonly schemaVersion: 1
  readonly provenance: {
    readonly generatorCommit: string
    readonly legacyRuntimeId: string
    readonly sourceFingerprint: string
    readonly generatedAt: string
  }
  readonly artifact: SceneConformanceArtifactV1
  readonly bundleHash: string
}

export interface ConformanceCaptureOptionsV1 {
  readonly datasetId: string
  readonly caseId: string
  readonly frameIndices?: readonly number[]
  readonly requiredCapabilities?: readonly NormalizedCapabilityV1[]
  readonly sampleValuesPerBuffer?: number
  readonly perceptualReferences?: readonly PerceptualReferenceV1[]
}

export type OracleBundleProvenanceV1 = OracleBundleV1['provenance']

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function bytesOf(value: NumericView | ArrayBuffer): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return Uint8Array.from(source)
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input.buffer)
  return `sha256-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export async function sha256CanonicalJsonV1(value: JsonValue): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(canonicalizeJson(value)))
}

function sampleNumber(value: number): JsonValue {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  if (Object.is(value, -0)) return '-0'
  return value
}

async function numericObservation(value: NumericView, sampleLimit: number): Promise<JsonValue> {
  const samples: JsonValue[] = []
  const count = Math.min(value.length, sampleLimit)
  for (let index = 0; index < count; index += 1) {
    const source = count === 1 ? 0 : Math.round(index * (value.length - 1) / (count - 1))
    samples.push(sampleNumber(value[source]))
  }
  let finiteCount = 0
  let nonFiniteCount = 0
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  let sum = 0
  for (const entry of value) {
    if (!Number.isFinite(entry)) {
      nonFiniteCount += 1
      continue
    }
    finiteCount += 1
    minimum = Math.min(minimum, entry)
    maximum = Math.max(maximum, entry)
    sum += entry
  }
  return {
    type: value.constructor.name,
    length: value.length,
    byteLength: value.byteLength,
    sha256: await sha256Bytes(bytesOf(value)),
    finiteCount,
    nonFiniteCount,
    minimum: finiteCount > 0 ? sampleNumber(minimum) : null,
    maximum: finiteCount > 0 ? sampleNumber(maximum) : null,
    mean: finiteCount > 0 ? sampleNumber(sum / finiteCount) : null,
    samples,
  }
}

async function bufferObservation(value: ArrayBuffer): Promise<JsonValue> {
  return {
    type: 'ArrayBuffer',
    byteLength: value.byteLength,
    sha256: await sha256Bytes(bytesOf(value)),
  }
}

async function jsonObservation(value: JsonValue): Promise<{ readonly count: number; readonly sha256: string }> {
  const canonical = canonicalizeJson(value)
  return {
    count: Array.isArray(value) ? value.length : 1,
    sha256: await sha256Bytes(new TextEncoder().encode(canonical)),
  }
}

function stableBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareText(key(left), key(right)))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function pointObservation(cloud: NormalizedPointCloudV1, sampleLimit: number): Promise<JsonValue> {
  return {
    sensorId: cloud.sensorId,
    frameId: cloud.frameId,
    pointCount: cloud.pointCount,
    stride: cloud.stride,
    attributes: [...cloud.attributes],
    values: await numericObservation(cloud.values, sampleLimit),
    semanticLabels: cloud.semanticLabels ? await numericObservation(cloud.semanticLabels, sampleLimit) : null,
    panopticLabels: cloud.panopticLabels ? await numericObservation(cloud.panopticLabels, sampleLimit) : null,
    cameraProjection: cloud.cameraProjection ? await numericObservation(cloud.cameraProjection, sampleLimit) : null,
    cameraRgb: cloud.cameraRgb ? await numericObservation(cloud.cameraRgb, sampleLimit) : null,
    sourceIndices: cloud.sourceIndices ? await numericObservation(cloud.sourceIndices, sampleLimit) : null,
  }
}

async function segmentationObservation(
  segmentation: NormalizedSegmentationV1,
  sampleLimit: number,
): Promise<JsonValue> {
  return {
    sensorId: segmentation.sensorId,
    taxonomyId: segmentation.taxonomyId,
    divisor: segmentation.divisor ?? null,
    encoding: segmentation.encoding,
    labels: segmentation.labels instanceof ArrayBuffer
      ? await bufferObservation(segmentation.labels)
      : await numericObservation(segmentation.labels, sampleLimit),
  }
}

async function frameNumericObservation(frame: NormalizedFrameV1, sampleLimit: number): Promise<JsonValue> {
  const pointClouds = stableBy(frame.pointClouds, (cloud) => cloud.sensorId)
  const radarPointClouds = stableBy(frame.radarPointClouds, (cloud) => cloud.sensorId)
  const cameraImages = stableBy(frame.cameraImages, (image) => image.sensorId)
  const lidarSegmentation = stableBy(frame.lidarSegmentation, (entry) => `${entry.sensorId}:${entry.taxonomyId}`)
  const cameraSegmentation = stableBy(frame.cameraSegmentation, (entry) => `${entry.sensorId}:${entry.taxonomyId}`)
  return {
    index: frame.index,
    timestampMicros: frame.timestampMicros.toString(),
    worldFromEgo: frame.worldFromEgo ? await numericObservation(frame.worldFromEgo, 16) : null,
    pointClouds: await Promise.all(pointClouds.map((cloud) => pointObservation(cloud, sampleLimit))),
    radarPointClouds: await Promise.all(radarPointClouds.map((cloud) => pointObservation(cloud, sampleLimit))),
    cameraImages: await Promise.all(cameraImages.map(async (image) => ({
      sensorId: image.sensorId,
      timestampMicros: image.timestampMicros.toString(),
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      calibrationId: image.calibrationId,
      encodedBytes: await bufferObservation(image.encodedBytes),
    }))),
    boxes3d: asJson(stableBy(frame.boxes3d, (box) => box.id)),
    boxes2d: asJson(stableBy(frame.boxes2d, (box) => `${box.cameraId}:${box.id}`)),
    keypoints3d: asJson(stableBy(frame.keypoints3d, (entry) => `${entry.objectId}:${entry.schemaId}`)),
    keypoints2d: asJson(stableBy(frame.keypoints2d, (entry) => `${entry.cameraId ?? ''}:${entry.objectId}:${entry.schemaId}`)),
    lidarSegmentation: await Promise.all(lidarSegmentation.map((entry) => segmentationObservation(entry, sampleLimit))),
    cameraSegmentation: await Promise.all(cameraSegmentation.map((entry) => segmentationObservation(entry, sampleLimit))),
  }
}

function frameStructuralObservation(frame: NormalizedFrameV1): JsonValue {
  return {
    index: frame.index,
    timestampMicros: frame.timestampMicros.toString(),
    pointSensors: frame.pointClouds.map((cloud) => cloud.sensorId).sort(),
    radarSensors: frame.radarPointClouds.map((cloud) => cloud.sensorId).sort(),
    cameraSensors: frame.cameraImages.map((image) => image.sensorId).sort(),
    box3dCount: frame.boxes3d.length,
    box2dCount: frame.boxes2d.length,
    keypoint3dCount: frame.keypoints3d.length,
    keypoint2dCount: frame.keypoints2d.length,
    lidarSegmentationCount: frame.lidarSegmentation.length,
    cameraSegmentationCount: frame.cameraSegmentation.length,
  }
}

function defaultFrameIndices(frameCount: number): number[] {
  if (frameCount <= 0) return []
  return [...new Set([0, Math.floor((frameCount - 1) / 2), frameCount - 1])]
}

function validatePerceptualReferences(references: readonly PerceptualReferenceV1[]): PerceptualReferenceV1[] {
  const ids = new Set<string>()
  return stableBy(references, (reference) => reference.id).map((reference) => {
    if (!reference.id || ids.has(reference.id)) throw new Error(`Duplicate or empty perceptual reference: ${reference.id}`)
    if (!/^sha256-[0-9a-f]{64}$/u.test(reference.sha256)) throw new Error(`Invalid perceptual SHA-256: ${reference.id}`)
    if (!Number.isSafeInteger(reference.width) || reference.width <= 0
      || !Number.isSafeInteger(reference.height) || reference.height <= 0) {
      throw new Error(`Invalid perceptual dimensions: ${reference.id}`)
    }
    ids.add(reference.id)
    return { ...reference }
  })
}

function artifactPayload(artifact: Omit<SceneConformanceArtifactV1, 'artifactHash'>): JsonValue {
  return asJson(artifact)
}

export async function verifySceneConformanceArtifactV1(artifact: SceneConformanceArtifactV1): Promise<boolean> {
  if (artifact.kind !== 'egolens-scene-conformance' || artifact.schemaVersion !== 1) return false
  const { artifactHash: _artifactHash, ...payload } = artifact
  const summaryHash = await sha256CanonicalJsonV1({
    structural: artifact.structural,
    numeric: artifact.numeric,
    perceptual: asJson(artifact.perceptual),
  })
  return summaryHash === artifact.summaryHash
    && await sha256CanonicalJsonV1(artifactPayload(payload)) === artifact.artifactHash
}

/**
 * Capture a candidate or legacy-oracle observation through NormalizedSceneV1.
 * The factory boundary and finally block keep capture independent of Zustand
 * and guarantee that the scene cannot survive the conformance run.
 */
export async function captureSceneConformanceArtifactV1(
  createScene: () => Promise<NormalizedSceneV1>,
  options: ConformanceCaptureOptionsV1,
): Promise<SceneConformanceArtifactV1> {
  if (!options.datasetId || !options.caseId) throw new Error('Conformance target requires datasetId and caseId.')
  const scene = await createScene()
  try {
    const frameCount = scene.index.timestampsMicros.length
    if (frameCount === 0) throw new Error('Conformance capture requires a non-empty scene.')
    const frameIndices = [...new Set(options.frameIndices ?? defaultFrameIndices(frameCount))]
      .sort((left, right) => left - right)
    if (frameIndices.length === 0 || frameIndices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= frameCount)) {
      throw new Error('Conformance frame indices are empty or out of range.')
    }
    const requiredCapabilities = [...new Set(options.requiredCapabilities ?? scene.manifest.capabilities)]
      .sort() as NormalizedCapabilityV1[]
    const missing = requiredCapabilities.filter((capability) => !scene.manifest.capabilities.has(capability))
    if (missing.length > 0) throw new Error(`Conformance scene is missing required capabilities: ${missing.join(', ')}`)
    const sampleLimit = options.sampleValuesPerBuffer ?? 64
    if (!Number.isSafeInteger(sampleLimit) || sampleLimit <= 0) throw new Error('sampleValuesPerBuffer must be positive.')
    const perceptual = validatePerceptualReferences(options.perceptualReferences ?? [])
    const frames: NormalizedFrameV1[] = []
    for (const index of frameIndices) {
      frames.push(await scene.loadFrame(index, { capabilities: new Set(requiredCapabilities) }))
    }

    const trajectoryEntries = [...scene.relations.trajectories].sort(([left], [right]) => compareText(left, right))
    const associationEntries = [...scene.relations.box2dToBox3d].sort(([left], [right]) => compareText(left, right))
    const structural: JsonValue = {
      manifest: {
        id: scene.manifest.id,
        name: scene.manifest.name,
        nominalFrameRate: scene.manifest.nominalFrameRate,
        sensors: asJson(scene.manifest.sensors),
        taxonomies: asJson(scene.manifest.taxonomies),
        pointAttributes: asJson(scene.manifest.pointAttributes),
        pointLayout: asJson(scene.manifest.pointLayout),
        capabilities: [...scene.manifest.capabilities].sort(),
      },
      index: {
        frameCount,
        segments: asJson(scene.index.segments.map((segment) => ({
          id: segment.id,
          label: segment.label ?? null,
          firstFrame: segment.firstFrame,
          frameCount: segment.frameCount,
          metadata: segment.metadata ?? null,
        }))),
      },
      relations: {
        staticTransformFrames: scene.relations.staticTransforms
          .map((entry) => `${entry.parentFrameId}:${entry.childFrameId}`).sort(),
        cameraCalibrationIds: [...scene.relations.cameraCalibrations.keys()].sort(),
        trajectoryIds: trajectoryEntries.map(([id]) => id),
        boxAssociationCount: associationEntries.length,
      },
      frames: frames.map(frameStructuralObservation),
    }

    const timelineStrings = scene.index.timestampsMicros.map((timestamp) => timestamp.toString())
    const numeric: JsonValue = {
      timeline: {
        first: timelineStrings[0],
        last: timelineStrings.at(-1)!,
        ...await jsonObservation(timelineStrings),
      },
      staticTransforms: await Promise.all(scene.relations.staticTransforms
        .map(async (transform) => ({
          parentFrameId: transform.parentFrameId,
          childFrameId: transform.childFrameId,
          parentFromChild: await numericObservation(transform.parentFromChild, 16),
        }))),
      cameraCalibrations: await Promise.all([...scene.relations.cameraCalibrations]
        .sort(([left], [right]) => compareText(left, right))
        .map(async ([id, calibration]) => ({
          id,
          sensorId: calibration.sensorId,
          frameId: calibration.frameId,
          width: calibration.width,
          height: calibration.height,
          intrinsics: [...calibration.intrinsics],
          distortionModel: calibration.distortionModel,
          distortion: [...calibration.distortion],
          egoFromCamera: await numericObservation(calibration.egoFromCamera, 16),
        }))),
      trajectories: await Promise.all(trajectoryEntries.map(async ([id, points]) => {
        const json = asJson(points)
        return { id, pointCount: points.length, ...await jsonObservation(json) }
      })),
      boxAssociations: await jsonObservation(asJson(associationEntries)),
      frames: await Promise.all(frames.map((frame) => frameNumericObservation(frame, sampleLimit))),
    }
    const coverage = {
      requiredCapabilities,
      frameIndices,
      completeTimeline: frameIndices.length === frameCount,
      perceptualReferenceIds: perceptual.map((reference) => reference.id),
    }
    const summaryHash = await sha256CanonicalJsonV1({ structural, numeric, perceptual: asJson(perceptual) })
    const withoutHash = {
      kind: 'egolens-scene-conformance' as const,
      schemaVersion: 1 as const,
      target: { datasetId: options.datasetId, caseId: options.caseId },
      coverage,
      structural,
      numeric,
      perceptual,
      summaryHash,
    }
    return {
      ...withoutHash,
      artifactHash: await sha256CanonicalJsonV1(artifactPayload(withoutHash)),
    }
  } finally {
    scene.dispose()
  }
}

export async function createOracleBundleV1(
  artifact: SceneConformanceArtifactV1,
  provenance: OracleBundleProvenanceV1,
): Promise<OracleBundleV1> {
  if (!await verifySceneConformanceArtifactV1(artifact)) throw new Error('Cannot promote a tampered conformance artifact.')
  if (!provenance.generatorCommit || !provenance.legacyRuntimeId
    || !/^sha256-[0-9a-f]{64}$/u.test(provenance.sourceFingerprint)
    || !Number.isFinite(Date.parse(provenance.generatedAt))) {
    throw new Error('Oracle bundle provenance is incomplete or invalid.')
  }
  const payload = {
    kind: 'egolens-hidden-oracle' as const,
    schemaVersion: 1 as const,
    provenance: { ...provenance },
    artifact,
  }
  return {
    ...payload,
    bundleHash: await sha256CanonicalJsonV1(asJson(payload)),
  }
}

export async function verifyOracleBundleV1(bundle: OracleBundleV1): Promise<boolean> {
  if (bundle.kind !== 'egolens-hidden-oracle' || bundle.schemaVersion !== 1) return false
  const { bundleHash: _bundleHash, ...payload } = bundle
  return await verifySceneConformanceArtifactV1(bundle.artifact)
    && await sha256CanonicalJsonV1(asJson(payload)) === bundle.bundleHash
}
