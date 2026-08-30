export type NormalizedCapabilityV1 =
  | 'timeline'
  | 'egoPoses'
  | 'pointClouds'
  | 'radarPointClouds'
  | 'cameraImages'
  | 'boxes3d'
  | 'boxes2d'
  | 'boxAssociations'
  | 'trajectories'
  | 'lidarSegmentation'
  | 'cameraSegmentation'
  | 'keypoints3d'
  | 'keypoints2d'
  | 'segmentMetadata'

export type NormalizedSensorModalityV1 = 'lidar' | 'radar' | 'camera'

export interface NormalizedSensorV1 {
  readonly id: string
  readonly rendererId: number
  readonly label: string
  readonly modality: NormalizedSensorModalityV1
  readonly frameId: string
  readonly color: string
  readonly image?: {
    readonly width: number
    readonly height: number
    readonly model: 'pinhole' | 'fisheye'
    readonly view: 'front' | 'front-left' | 'front-right' | 'side-left' | 'side-right' | 'rear' | 'rear-left' | 'rear-right'
    readonly povLabel?: string
    readonly aliases?: readonly string[]
  }
}

export interface NormalizedTaxonomyClassV1 {
  readonly id: string
  readonly rendererId: number
  readonly label: string
  readonly color: string
  readonly modelHint?: 'vehicle' | 'pedestrian' | 'cyclist' | 'motorcycle' | 'bicycle' | 'sign' | 'cone' | 'barrier' | 'box'
}

export interface NormalizedTaxonomyV1 {
  readonly id: string
  readonly role: 'objects' | 'lidar-semantics' | 'camera-semantics'
  readonly classes: readonly NormalizedTaxonomyClassV1[]
  readonly palette?: readonly (readonly [number, number, number])[]
}

export interface NormalizedPointAttributeV1 {
  readonly id: string
  readonly storage: 'float32' | 'uint8' | 'uint16' | 'uint32' | 'int16'
  readonly unit?: string
  readonly range?: readonly [number, number]
}

export interface NormalizedManifestV1 {
  readonly id: string
  readonly name: string
  readonly nominalFrameRate: number
  readonly sensors: readonly NormalizedSensorV1[]
  readonly taxonomies: readonly NormalizedTaxonomyV1[]
  readonly pointAttributes: readonly NormalizedPointAttributeV1[]
  readonly pointLayout: {
    readonly interleavedAttributes: readonly string[]
    readonly colorModes: readonly ('distance' | 'intensity' | 'range' | 'elongation' | 'segment' | 'panoptic' | 'camera')[]
  }
  readonly capabilities: ReadonlySet<NormalizedCapabilityV1>
}

export interface NormalizedSegmentV1 {
  readonly id: string
  readonly label?: string
  readonly firstFrame: number
  readonly frameCount: number
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
}

export interface NormalizedSceneIndexV1 {
  readonly timestampsMicros: readonly bigint[]
  readonly segments: readonly NormalizedSegmentV1[]
}

export interface NormalizedTransformV1 {
  readonly parentFrameId: string
  readonly childFrameId: string
  readonly parentFromChild: Float64Array
}

export interface NormalizedCameraCalibrationV1 {
  readonly sensorId: string
  readonly frameId: string
  readonly width: number
  readonly height: number
  readonly intrinsics: readonly [number, number, number, number]
  readonly distortionModel: 'none' | 'brown-conrady' | 'fisheye'
  readonly distortion: readonly number[]
  readonly egoFromCamera: Float64Array
}

export interface NormalizedTrackPointV1 {
  readonly frameIndex: number
  readonly position: readonly [number, number, number]
  readonly classId: string
}

export interface NormalizedRelationsV1 {
  readonly staticTransforms: readonly NormalizedTransformV1[]
  readonly cameraCalibrations: ReadonlyMap<string, NormalizedCameraCalibrationV1>
  readonly trajectories: ReadonlyMap<string, readonly NormalizedTrackPointV1[]>
  readonly box2dToBox3d: ReadonlyMap<string, string>
}

export interface NormalizedPointCloudV1 {
  readonly sensorId: string
  readonly frameId: string
  /** Interleaved attributes. The first three components are normalized x/y/z metres. */
  readonly values: Float32Array
  readonly pointCount: number
  readonly stride: number
  readonly attributes: readonly string[]
  readonly semanticLabels?: Uint8Array | Uint16Array
  readonly panopticLabels?: Uint16Array | Uint32Array
  readonly cameraProjection?: Int16Array
  readonly cameraRgb?: Uint8Array
  readonly sourceIndices?: Uint32Array
}

export interface NormalizedCameraImageV1 {
  readonly sensorId: string
  readonly timestampMicros: bigint
  readonly encodedBytes: ArrayBuffer
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  readonly width: number
  readonly height: number
  readonly calibrationId: string
}

export interface NormalizedBox3dV1 {
  readonly id: string
  readonly objectId: string
  readonly classId: string
  readonly frameId: string
  readonly center: readonly [number, number, number]
  readonly dimensions: readonly [number, number, number]
  readonly orientation: readonly [number, number, number, number]
  readonly heading?: number
}

export interface NormalizedBox2dV1 {
  readonly id: string
  readonly objectId: string
  readonly classId: string
  readonly cameraId: string
  readonly center: readonly [number, number]
  readonly dimensions: readonly [number, number]
}

export interface NormalizedKeypointV1 {
  readonly name: string
  readonly position: readonly [number, number] | readonly [number, number, number]
  readonly visibility: 'visible' | 'occluded' | 'unknown'
}

export interface NormalizedKeypointSetV1 {
  readonly objectId: string
  readonly schemaId: string
  readonly frameId: string
  readonly cameraId?: string
  readonly points: readonly NormalizedKeypointV1[]
}

export interface NormalizedSegmentationV1 {
  readonly sensorId: string
  readonly taxonomyId: string
  readonly labels: Uint8Array | Uint16Array | Uint32Array | ArrayBuffer
  readonly divisor?: number
  readonly encoding: 'point-index' | 'png-uint16' | 'raw'
}

export interface NormalizedFrameV1 {
  readonly index: number
  readonly timestampMicros: bigint
  readonly worldFromEgo: Float64Array | null
  readonly pointClouds: readonly NormalizedPointCloudV1[]
  readonly radarPointClouds: readonly NormalizedPointCloudV1[]
  readonly cameraImages: readonly NormalizedCameraImageV1[]
  readonly boxes3d: readonly NormalizedBox3dV1[]
  readonly boxes2d: readonly NormalizedBox2dV1[]
  readonly keypoints3d: readonly NormalizedKeypointSetV1[]
  readonly keypoints2d: readonly NormalizedKeypointSetV1[]
  readonly lidarSegmentation: readonly NormalizedSegmentationV1[]
  readonly cameraSegmentation: readonly NormalizedSegmentationV1[]
}

export interface FrameCapabilityRequest {
  readonly capabilities: ReadonlySet<NormalizedCapabilityV1>
  readonly sensorIds?: ReadonlySet<string>
  readonly signal?: AbortSignal
}

/** Dataset-neutral scene boundary consumed by every recipe runtime path. */
export interface NormalizedSceneV1 {
  readonly manifest: NormalizedManifestV1
  readonly index: NormalizedSceneIndexV1
  readonly relations: NormalizedRelationsV1
  loadFrame(index: number, request: FrameCapabilityRequest): Promise<NormalizedFrameV1>
  dispose(): void
}
