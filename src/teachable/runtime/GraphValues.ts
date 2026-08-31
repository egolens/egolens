import type { FeatherColumnsParamsV1, DecodedFeatherColumnsV1 } from '../operators/featherColumns'
import type {
  DecodedNumericRecordsV1,
  InterleavedRecordsParamsV1,
  NpzUint16ParamsV1,
  PcdRecordsParamsV1,
} from '../operators/binaryReaders'
import type { ByteSourceV1 } from '../source/ByteSource'
import type {
  NormalizedBox3dV1,
  NormalizedCameraCalibrationV1,
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
    this.#allocationBytes += bytes
    this.#peakAllocationBytes = Math.max(this.#peakAllocationBytes, this.#allocationBytes)
    if (this.#allocationBytes > this.#limits.maxAllocationBytes) throw new Error('GRAPH_ALLOCATION_BUDGET_EXCEEDED')
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
}

export interface GraphTableCollectionV1 {
  readonly kind: 'table-collection'
  readonly files: readonly GraphSourceFileV1[]
  readonly params: FeatherColumnsParamsV1
  readonly context: CoreOperatorExecutionContextV1
  readonly cache: Map<string, Promise<DecodedFeatherColumnsV1>>
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

export interface GraphSegmentDescriptorV1 {
  readonly groupId: string
  readonly id: string
  readonly label?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
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
  | GraphJsonCollectionV1
  | GraphEncodedCollectionV1
  | GraphBinaryCollectionV1
  | GraphTimelineV1
  | GraphPoseTimelineV1
  | GraphPointCloudPlanV1
  | GraphBinaryPointCloudPlanV1
  | GraphCameraPlanV1
  | GraphBoxesV1
  | GraphProjectedBoxesV1
  | GraphTrajectoriesV1
  | GraphTrajectoryPlanV1
  | GraphSegmentationPlanV1
  | GraphSegmentIndexV1
  | GraphRecordsV1
