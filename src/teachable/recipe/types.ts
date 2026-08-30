import type { NormalizedCapabilityV1 } from '../runtime/normalizedScene'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface CoreOperatorDependencyV1 {
  readonly major: number
  readonly provider: 'core'
}

export interface ExtensionOperatorDependencyV1 {
  readonly major: number
  readonly provider: 'extension'
  readonly package: {
    readonly id: string
    readonly version: string
    readonly integrity: string
  }
}

export type OperatorDependencyV1 = CoreOperatorDependencyV1 | ExtensionOperatorDependencyV1

export type MatchRuleV1 =
  | { readonly kind: 'path'; readonly glob: string; readonly minCount?: number; readonly maxCount?: number }
  | { readonly kind: 'extension'; readonly extension: string; readonly minCount?: number }
  | { readonly kind: 'size'; readonly glob: string; readonly minimum?: number; readonly maximum?: number; readonly divisibleBy?: number }
  | { readonly kind: 'magic-bytes'; readonly glob: string; readonly offset?: number; readonly hex: string }
  | { readonly kind: 'json-keys'; readonly source: string; readonly requiredKeys: readonly string[] }
  | { readonly kind: 'table-schema'; readonly source: string; readonly requiredFields: readonly string[] }

export interface RecipeMatchV1 {
  readonly inventory: {
    readonly rootEntries: readonly {
      readonly path: string
      readonly required: boolean
    }[]
  }
  readonly all?: readonly MatchRuleV1[]
  readonly any?: readonly MatchRuleV1[]
  readonly none?: readonly MatchRuleV1[]
}

export interface RecipeFileSelectorV1 {
  readonly exact?: string
  readonly glob?: string
  readonly order?: 'lexical-path' | 'numeric-path' | 'none'
  readonly minCount?: number
  readonly maxCount?: number
}

export interface RecipeSourceV1 {
  readonly reader: string
  readonly files: RecipeFileSelectorV1
  readonly columns?: readonly string[]
  /** Raw source fields bound to dataset-neutral roles for migration compatibility. */
  readonly bindings?: Partial<Record<RecipeSourceFieldRoleV1, string>>
  readonly params?: JsonObject
}

export type RecipeSourceFieldRoleV1 =
  | 'timestamp'
  | 'sensorId'
  | 'rangeImageShape'
  | 'rangeImageValues'
  | 'egoPose'

export interface RecipeCoordinateFrameV1 {
  readonly id: string
  readonly parent?: string
  readonly convention: {
    readonly x: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'
    readonly y: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'
    readonly z: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down'
    readonly handedness: 'right' | 'left'
    readonly lengthUnit: 'm' | 'cm' | 'mm'
  }
}

export interface RecipeSensorV1 {
  readonly id: string
  readonly rendererId: number
  readonly label: string
  readonly modality: 'lidar' | 'radar' | 'camera'
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

export interface RecipeTaxonomyV1 {
  readonly id: string
  readonly role: 'objects' | 'lidar-semantics' | 'camera-semantics'
  readonly classes: readonly {
    readonly id: string
    readonly rendererId: number
    readonly label: string
    readonly color: string
    readonly modelHint?: 'vehicle' | 'pedestrian' | 'cyclist' | 'motorcycle' | 'bicycle' | 'sign' | 'cone' | 'barrier' | 'box'
  }[]
  readonly palette?: readonly (readonly [number, number, number])[]
}

export interface RecipeSceneV1 {
  /** Stable executable format identity. It is not derived from display metadata. */
  readonly formatId: string
  readonly timeline: {
    readonly timestampUnit: 'ns' | 'us' | 'ms' | 's'
    readonly nominalFrameRate: number
  }
  readonly coordinateFrames: readonly RecipeCoordinateFrameV1[]
  readonly sensors: readonly RecipeSensorV1[]
  readonly taxonomies: readonly RecipeTaxonomyV1[]
  readonly pointAttributes: readonly {
    readonly id: string
    readonly storage: 'float32' | 'uint8' | 'uint16' | 'uint32' | 'int16'
    readonly unit?: string
    readonly range?: readonly [number, number]
  }[]
  readonly pointLayout: {
    readonly interleavedAttributes: readonly string[]
    readonly colorModes: readonly ('distance' | 'intensity' | 'range' | 'elongation' | 'segment' | 'panoptic' | 'camera')[]
  }
}

export interface RecipePipelineNodeV1 {
  readonly id: string
  readonly op: string
  readonly version: number
  readonly inputs?: Readonly<Record<string, string>>
  readonly params?: JsonObject
}

export interface RecipePipelineV1 {
  readonly nodes: readonly RecipePipelineNodeV1[]
  readonly result: string
}

export type RecipeOutputNameV1 = NormalizedCapabilityV1

export interface RecipeValidationAssertionV1 {
  readonly kind: string
  readonly output: RecipeOutputNameV1
  readonly minimum?: number
  readonly maximum?: number
  readonly value?: number
  readonly params?: JsonObject
}

export interface RecipeValidationV1 {
  readonly sampleFrames: readonly (number | 'first' | 'middle' | 'last')[]
  readonly assertions: readonly RecipeValidationAssertionV1[]
  readonly humanReview: readonly string[]
}

export interface RecipeHashesV1 {
  readonly artifactHash?: string
  readonly recipeHash?: string
  readonly formatFingerprint?: string
  readonly operatorSetFingerprint?: string
}

export interface RecipeProvenanceV1 {
  readonly author: 'codex' | 'imported' | 'registry'
  readonly createdAt: string
  readonly parentRecipeHash?: string
  readonly summary?: string
  readonly assumptions?: readonly string[]
  readonly datasetFingerprint?: string
  readonly validatorVersion?: string
  readonly validationSummary?: JsonObject
  readonly humanReviewReceipt?: JsonObject
}

export interface EgoLensAdapterRecipeV1 {
  readonly kind: 'egolens-adapter'
  readonly schemaVersion: 1
  readonly engine: {
    readonly minimumVersion: string
    readonly requiredOperators: Readonly<Record<string, OperatorDependencyV1>>
  }
  readonly identity: {
    readonly name: string
    readonly description?: string
  }
  readonly match: RecipeMatchV1
  readonly sources: Readonly<Record<string, RecipeSourceV1>>
  readonly scene: RecipeSceneV1
  readonly pipelines: Readonly<Record<string, RecipePipelineV1>>
  readonly outputs: Partial<Record<RecipeOutputNameV1, string>> & { readonly timeline: string }
  readonly validation: RecipeValidationV1
  readonly hashes?: RecipeHashesV1
  readonly provenance?: RecipeProvenanceV1
}
