import { canonicalizeJson } from '../recipe/canonicalize'
import type { EgoLensAdapterRecipeV1, JsonValue } from '../recipe/types'

export type SemanticDiffGroupV1 =
  | 'source-discovery'
  | 'timeline-synchronization'
  | 'coordinate-frames-units'
  | 'sensors-calibrations'
  | 'geometry-annotations'
  | 'taxonomy-labels'
  | 'validation-assertions'

export interface SemanticDiffEntryV1 {
  readonly group: SemanticDiffGroupV1
  readonly changed: boolean
  readonly changedKeys: readonly string[]
  readonly summary: string
}

export interface SemanticDiffV1 {
  readonly changed: boolean
  readonly entries: readonly SemanticDiffEntryV1[]
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function topLevelChangedKeys(before: unknown, after: unknown): string[] {
  const left = before && typeof before === 'object' ? before as Record<string, unknown> : {}
  const right = after && typeof after === 'object' ? after as Record<string, unknown> : {}
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => canonicalizeJson(json(left[key] ?? null)) !== canonicalizeJson(json(right[key] ?? null)))
    .sort()
}

function projection(recipe: EgoLensAdapterRecipeV1, group: SemanticDiffGroupV1): unknown {
  switch (group) {
    case 'source-discovery':
      return { match: recipe.match, sources: recipe.sources, requiredOperators: recipe.engine.requiredOperators }
    case 'timeline-synchronization':
      return { timeline: recipe.scene.timeline, pipeline: recipe.pipelines.timeline, output: recipe.outputs.timeline }
    case 'coordinate-frames-units':
      return { coordinateFrames: recipe.scene.coordinateFrames, pointAttributes: recipe.scene.pointAttributes }
    case 'sensors-calibrations':
      return { sensors: recipe.scene.sensors }
    case 'geometry-annotations':
      return {
        pointLayout: recipe.scene.pointLayout,
        pipelines: Object.fromEntries(Object.entries(recipe.pipelines).filter(([key]) => key !== 'timeline')),
        outputs: Object.fromEntries(Object.entries(recipe.outputs).filter(([key]) => key !== 'timeline')),
      }
    case 'taxonomy-labels':
      return { taxonomies: recipe.scene.taxonomies }
    case 'validation-assertions':
      return { validation: recipe.validation }
  }
}

const groups: readonly SemanticDiffGroupV1[] = [
  'source-discovery',
  'timeline-synchronization',
  'coordinate-frames-units',
  'sensors-calibrations',
  'geometry-annotations',
  'taxonomy-labels',
  'validation-assertions',
]

export function semanticDiffV1(
  before: EgoLensAdapterRecipeV1 | null,
  after: EgoLensAdapterRecipeV1,
): SemanticDiffV1 {
  const entries = groups.map((group): SemanticDiffEntryV1 => {
    const previous = before ? projection(before, group) : {}
    const next = projection(after, group)
    const changed = canonicalizeJson(json(previous)) !== canonicalizeJson(json(next))
    const changedKeys = changed ? topLevelChangedKeys(previous, next) : []
    return {
      group,
      changed,
      changedKeys,
      summary: changed
        ? `${group}: ${changedKeys.length > 0 ? changedKeys.join(', ') : 'semantic values'} changed.`
        : `${group}: unchanged.`,
    }
  })
  return { changed: entries.some((entry) => entry.changed), entries }
}
