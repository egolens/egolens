import type { FeatherColumnsParamsV1, DecodedFeatherColumnsV1 } from '../operators/featherColumns'
import type { ParquetColumnsParamsV1 } from '../operators/parquetColumns'
import type {
  DecodedNumericRecordsV1,
  InterleavedRecordsParamsV1,
  NpzUint16ParamsV1,
  PcdRecordsParamsV1,
} from '../operators/binaryReaders'
import type { ParquetRow } from '../../utils/merge'
import type { LidarCalibration } from '../../utils/rangeImage'
import type { WaymoParquetFile } from '../../utils/parquet'
import type { AsyncBuffer } from 'hyparquet'
import type { ByteSourceV1 } from '../source/ByteSource'
import type {
  NormalizedBox2dV1,
  NormalizedBox3dV1,
  NormalizedCameraCalibrationV1,
  NormalizedKeypointSetV1,
  NormalizedSegmentationV1,
  NormalizedTrackPointV1,
} from './normalizedScene'

export interface GraphSourceFileV1 {
  readonly path: string
  readonly size: number | null
}

export interface GraphExecutionLimitsV1 {
  readonly maxNodes: number
  readonly maxSourceBytes: number
  readonly maxAllocationBytes: number
}

export interface GraphResourceSnapshotV1 {
  readonly nodesExecuted: number
  readonly sourceBytesRead: number
  readonly allocationBytes: number
  readonly peakAllocationBytes: number
}

export class GraphResourceAccountV1 {
  readonly #limits: GraphExecutionLimitsV1
  #nodesExecuted = 0
  #sourceBytesRead = 0
  #allocationBytes = 0
  #peakAllocationBytes = 0

  constructor(limits: GraphExecutionLimitsV1) {
    this.#limits = limits
  }

  node(): void {
    this.#nodesExecuted += 1
    if (this.#nodesExecuted > this.#limits.maxNodes) throw new Error('GRAPH_NODE_BUDGET_EXCEEDED')
  }

  sourceBytes(bytes: number): void {
    this.#sourceBytesRead += bytes
    if (this.#sourceBytesRead > this.#limits.maxSourceBytes) throw new Error('GRAPH_SOURCE_BYTE_BUDGET_EXCEEDED')
  }

  allocate(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('GRAPH_ALLOCATION_INVALID')
    const nextAllocationBytes = this.#allocationBytes + bytes
    if (!Number.isSafeInteger(nextAllocationBytes) || nextAllocationBytes > this.#limits.maxAllocationBytes) {
      throw new Error('GRAPH_ALLOCATION_BUDGET_EXCEEDED')
    }
    this.#allocationBytes = nextAllocationBytes
    this.#peakAllocationBytes = Math.max(this.#peakAllocationBytes, this.#allocationBytes)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#allocationBytes -= bytes
    }
  }

  snapshot(): GraphResourceSnapshotV1 {
    return {
      nodesExecuted: this.#nodesExecuted,
      sourceBytesRead: this.#sourceBytesRead,
      allocationBytes: this.#allocationBytes,
      peakAllocationBytes: this.#peakAllocationBytes,
    }
  }
}

export interface CoreOperatorExecutionContextV1 {
  readonly signal: AbortSignal
  readonly source: ByteSourceV1
  readonly resources: GraphResourceAccountV1
  throwIfAborted(): void
  read(path: string, signal?: AbortSignal): Promise<ArrayBuffer>
  asyncBuffer(path: string, signal?: AbortSignal): Promise<AsyncBuffer>
}

export interface GraphTableCollectionV1 {
  readonly kind: 'table-collection'
  readonly files: readonly GraphSourceFileV1[]
  readonly params: FeatherColumnsParamsV1
  readonly context: CoreOperatorExecutionContextV1
  readonly cache: Map<string, Promise<DecodedFeatherColumnsV1>>
  readonly retainedReleases: Map<string, () => void>
}

/** Lazy Parquet projection over the transport-neutral ByteSource. */
export interface GraphParquetCollectionV1 {
  readonly kind: 'parquet-collection'
  readonly files: readonly GraphSourceFileV1[]
  readonly params: ParquetColumnsParamsV1
  readonly context: CoreOperatorExecutionContextV1
  readonly fileCache: Map<string, Promise<WaymoParquetFile>>
  readonly cache: Map<string, Promise<readonly ParquetRow[]>>
  readonly projectionCache: Map<string, Promise<readonly ParquetRow[]>>
  readonly frameIndexCache: Map<string, Promise<ReadonlyMap<bigint, { readonly rowStart: number; readonly rowEnd: number }>>>
  readonly frameRowsCache: Map<string, Promise<readonly ParquetRow[]>>
  readonly retainedReleases: Map<string, () => void>
}

export interface GraphJsonCollectionV1 {
  readonly kind: 'json-collection'
  readonly files: readonly GraphSourceFileV1[]
  readonly context: CoreOperatorExecutionContextV1
}

export type GraphBinaryDecoderV1 =
  | { readonly kind: 'interleaved'; readonly params: InterleavedRecordsParamsV1 }
  | { readonly kind: 'pcd'; readonly params: PcdRecordsParamsV1 }
  | { readonly kind: 'npz-uint16'; readonly params: NpzUint16ParamsV1 }

export type GraphDecodedBinaryV1 = DecodedNumericRecordsV1 | Uint16Array

/** Lazy, bounded source collection. Files are decoded only for requested frames. */
export interface GraphBinaryCollectionV1 {
  readonly kind: 'binary-collection'
  readonly files: readonly GraphSourceFileV1[]
  readonly decoder: GraphBinaryDecoderV1
  readonly context: CoreOperatorExecutionContextV1
  readonly cache: Map<string, Promise<GraphDecodedBinaryV1>>
  readonly retainedReleases: Map<string, () => void>
}

export interface GraphEncodedCollectionV1 {
  readonly kind: 'encoded-collection'
  readonly files: readonly GraphSourceFileV1[]
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  readonly context: CoreOperatorExecutionContextV1
}

export interface GraphTimelineFrameV1 {
  readonly timestamp: bigint
  readonly path?: string
  readonly key?: string
  readonly group?: string
}

export interface GraphTimelineV1 {
  readonly kind: 'timeline'
  readonly unit: 'ns' | 'us' | 'ms' | 's'
  readonly frames: readonly GraphTimelineFrameV1[]
}

export interface GraphPoseTimelineV1 {
  readonly kind: 'pose-timeline'
  readonly worldOriginInverse: Float64Array | null
  readonly worldFromEgoByTimestamp: ReadonlyMap<bigint, Float64Array>
  /** Absolute poses keyed by the recipe-declared frame identity. The assembler
   * chooses a scene-local origin only after selecting a segment. */
  readonly absoluteWorldFromEgoByFrameKey?: ReadonlyMap<string, Float64Array>
}

export interface GraphPointCloudPlanV1 {
  readonly kind: 'point-cloud-plan'
  readonly tables: GraphTableCollectionV1
  readonly fields: readonly string[]
  readonly frameId: string
}

export interface GraphRangeImagePointCloudPlanV1 {
  readonly kind: 'range-image-point-cloud-plan'
  readonly rows: GraphParquetCollectionV1
  readonly calibrations: ReadonlyMap<number, LidarCalibration>
  readonly timestampField: string
  readonly sensorField: string
  readonly shapeField: string
  readonly valuesField: string
  readonly frameId: string
}

export interface GraphBinaryPointCloudBindingV1 {
  readonly frameKey: string
  readonly recordKey: string
  readonly timestamp: bigint
  readonly path: string
  readonly sensorId: string
  readonly frameId: string
  readonly egoFromSensor: Float64Array | null
}

export interface GraphBinaryPointCloudPlanV1 {
  readonly kind: 'binary-point-cloud-plan'
  readonly records: GraphBinaryCollectionV1
  readonly bindings: readonly GraphBinaryPointCloudBindingV1[]
}

export interface GraphCameraBindingV1 {
  readonly frameKey: string
  readonly timestamp: bigint
  readonly path: string
  readonly sensorId: string
}

export interface GraphCameraPlanV1 {
  readonly kind: 'camera-plan'
  readonly encoded: GraphEncodedCollectionV1
  readonly calibrations: ReadonlyMap<string, NormalizedCameraCalibrationV1>
  readonly maxDelta: bigint
  readonly bindings?: readonly GraphCameraBindingV1[]
}

export interface GraphParquetCameraPlanV1 {
  readonly kind: 'parquet-camera-plan'
  readonly rows: GraphParquetCollectionV1
  readonly calibrations: ReadonlyMap<string, NormalizedCameraCalibrationV1>
  readonly timestampField: string
  readonly sensorField: string
  readonly imageField: string
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export interface GraphBoxesV1 {
  readonly kind: 'boxes3d'
  readonly byTimestamp: ReadonlyMap<bigint, readonly NormalizedBox3dV1[]>
  readonly byFrameKey?: ReadonlyMap<string, readonly NormalizedBox3dV1[]>
}

export interface GraphProjectedBoxesV1 {
  readonly kind: 'projected-boxes2d'
  readonly boxes: GraphBoxesV1
  readonly cameras: GraphCameraPlanV1
}

export interface GraphBoxes2dV1 {
  readonly kind: 'boxes2d'
  readonly byTimestamp: ReadonlyMap<bigint, readonly NormalizedBox2dV1[]>
}

export interface GraphBoxRelationsV1 {
  readonly kind: 'box-relations'
  readonly box2dToBox3d: ReadonlyMap<string, string>
}

export interface GraphTrajectoriesV1 {
  readonly kind: 'trajectories'
  readonly tracks: ReadonlyMap<string, readonly NormalizedTrackPointV1[]>
}

export interface GraphTrajectoryPlanV1 {
  readonly kind: 'trajectory-plan'
  readonly boxes: GraphBoxesV1
}

export interface GraphSegmentationPlanV1 {
  readonly kind: 'segmentation-plan'
  readonly pointClouds: GraphBinaryPointCloudPlanV1
  readonly semantic?: GraphBinaryCollectionV1
  readonly panoptic?: GraphBinaryCollectionV1
  readonly semanticPathByRecordKey: ReadonlyMap<string, string>
  readonly panopticPathByRecordKey: ReadonlyMap<string, string>
  readonly taxonomyId: string
  readonly panopticDivisor: number
}

export interface GraphRangeImageSegmentationPlanV1 {
  readonly kind: 'range-image-segmentation-plan'
  readonly pointClouds: GraphRangeImagePointCloudPlanV1
  readonly labels: GraphParquetCollectionV1
  readonly timestampField: string
  readonly sensorField: string
  readonly shapeField: string
  readonly valuesField: string
  readonly taxonomyId: string
  readonly panopticDivisor: number
  readonly availableTimestamps: ReadonlySet<bigint>
}

export interface GraphCameraSegmentationV1 {
  readonly kind: 'camera-segmentation'
  readonly byTimestamp: ReadonlyMap<bigint, readonly NormalizedSegmentationV1[]>
}

export interface GraphKeypointsV1 {
  readonly kind: 'keypoints'
  readonly dimensions: 2 | 3
  readonly byTimestamp: ReadonlyMap<bigint, readonly NormalizedKeypointSetV1[]>
  readonly sourceRowsByTimestamp: ReadonlyMap<bigint, readonly ParquetRow[]>
}

export interface GraphSegmentDescriptorV1 {
  readonly groupId: string
  readonly id: string
  readonly label?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
  readonly objectCounts?: Readonly<Record<number, number>>
}

export interface GraphSegmentIndexV1 {
  readonly kind: 'segment-index'
  readonly segments: readonly GraphSegmentDescriptorV1[]
}

export interface GraphRecordsV1 {
  readonly kind: 'records'
  readonly rows: readonly Readonly<Record<string, unknown>>[]
}

export type GraphTypedValueV1 =
  | GraphTableCollectionV1
  | GraphParquetCollectionV1
  | GraphJsonCollectionV1
  | GraphEncodedCollectionV1
  | GraphBinaryCollectionV1
  | GraphTimelineV1
  | GraphPoseTimelineV1
  | GraphPointCloudPlanV1
  | GraphRangeImagePointCloudPlanV1
  | GraphBinaryPointCloudPlanV1
  | GraphCameraPlanV1
  | GraphParquetCameraPlanV1
  | GraphBoxesV1
  | GraphProjectedBoxesV1
  | GraphBoxes2dV1
  | GraphBoxRelationsV1
  | GraphTrajectoriesV1
  | GraphTrajectoryPlanV1
  | GraphSegmentationPlanV1
  | GraphRangeImageSegmentationPlanV1
  | GraphCameraSegmentationV1
  | GraphKeypointsV1
  | GraphSegmentIndexV1
  | GraphRecordsV1
