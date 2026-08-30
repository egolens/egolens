import type {
  DatasetAdapter,
  DatasetDetectionEvidence,
  PreparedRecipeDatasetAdapter,
} from '../../adapters/types'
import type { DatasetManifest } from '../../types/dataset'
import { OperatorRegistry } from '../operators/registry'
import { compileRecipeV1, type CompiledRecipeV1 } from '../recipe/compiler'
import type { EgoLensAdapterRecipeV1, MatchRuleV1 } from '../recipe/types'

function matchesPathRule(rule: MatchRuleV1, entryNames: ReadonlySet<string>): boolean | null {
  if (rule.kind !== 'path') return null
  const root = rule.glob.split('/')[0]
  const present = entryNames.has(root)
  const minimum = rule.minCount ?? 1
  return present && minimum <= 1
}

export class RecipeBackedDatasetAdapter implements DatasetAdapter<PreparedRecipeDatasetAdapter> {
  readonly kind = 'recipe' as const
  readonly compiledRecipe: CompiledRecipeV1
  readonly recipe: EgoLensAdapterRecipeV1
  readonly operators: OperatorRegistry

  constructor(
    recipe: EgoLensAdapterRecipeV1,
    operators: OperatorRegistry,
  ) {
    this.recipe = recipe
    this.operators = operators
    this.compiledRecipe = compileRecipeV1(recipe, operators)
  }

  get id(): string {
    return this.compiledRecipe.normalizedManifest.id
  }

  get manifest(): DatasetManifest {
    return this.compiledRecipe.compatibilityManifest
  }

  matches(evidence: DatasetDetectionEvidence): boolean {
    const entries = new Set(evidence.entryNames)
    const inventory = this.recipe.match.inventory.rootEntries
    if (!inventory.filter((entry) => entry.required).every((entry) => entries.has(entry.path))) return false
    const evaluate = (rule: MatchRuleV1): boolean => matchesPathRule(rule, entries) ?? false
    const all = this.recipe.match.all?.every(evaluate) ?? true
    const any = this.recipe.match.any?.some(evaluate) ?? true
    const none = this.recipe.match.none?.some(evaluate) ?? false
    return all && any && !none
  }

  prepare(): PreparedRecipeDatasetAdapter {
    return {
      kind: 'recipe',
      adapterId: this.id,
      manifest: this.manifest,
      compiledRecipe: this.compiledRecipe,
    }
  }
}
