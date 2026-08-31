import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { ByteSourceV1 } from '../source/ByteSource'
import { scopedByteSourceV1 } from '../source/ByteSource'
import type { SourceInventoryV1 } from './SourceInventory'
import type { AuthoringRevisionEvaluatorV1, PreparedAuthoringRevisionV1 } from './AuthoringSession'
import { sourceSelectorMatchesV1 } from './sourceSelectors'

export interface AuthoringPreviewRuntimeV1 {
  preparePreview(
    compiledRecipe: CompiledRecipeV1,
    source: ByteSourceV1,
    inventory: SourceInventoryV1,
    signal?: AbortSignal,
  ): Promise<PreparedAuthoringRevisionV1>
}

function diagnostic(code: string, hint: string, jsonPointer?: string): AdapterDiagnostic {
  return { stage: 'bind', severity: 'error', code, hint, jsonPointer }
}

function selectFiles(compiled: CompiledRecipeV1, inventory: SourceInventoryV1): {
  readonly source: ByteSourceV1
  readonly diagnostics: readonly AdapterDiagnostic[]
} {
  const snapshot = inventory.snapshot()
  const diagnostics: AdapterDiagnostic[] = []
  if (snapshot.truncated) diagnostics.push(diagnostic('INVENTORY_TRUNCATED', 'The source tree exceeded the bounded inventory. Select a narrower dataset root.'))
  const paths = snapshot.entries.map((entry) => entry.path)
  for (const root of compiled.recipe.match.inventory.rootEntries.filter((entry) => entry.required)) {
    if (!paths.some((path) => path === root.path || path.startsWith(`${root.path}/`))) {
      diagnostics.push(diagnostic('INVENTORY_ROOT_MISSING', `Required inventory root ${root.path} is absent.`, '/match/inventory/rootEntries'))
    }
  }
  const selected = new Set<string>()
  for (const [sourceId, source] of Object.entries(compiled.recipe.sources)) {
    const matches = paths.filter((path) => sourceSelectorMatchesV1(compiled, source, path))
    const minimum = source.files.minCount ?? 1
    const maximum = source.files.maxCount ?? Number.POSITIVE_INFINITY
    if (matches.length < minimum || matches.length > maximum) {
      diagnostics.push(diagnostic(
        'SOURCE_FILE_COUNT_INVALID',
        `Source ${sourceId} matched ${matches.length} files; expected ${minimum}–${Number.isFinite(maximum) ? maximum : 'unbounded'}.`,
        `/sources/${sourceId}/files`,
      ))
      continue
    }
    for (const path of matches) selected.add(path)
  }
  return {
    source: scopedByteSourceV1(inventory.resolveAuthorizedSource(), selected),
    diagnostics,
  }
}

/** Binds selectors first, then delegates isolated sample/render preparation. */
export class InventoryBindingEvaluatorV1 implements AuthoringRevisionEvaluatorV1 {
  readonly #runtime?: AuthoringPreviewRuntimeV1

  constructor(runtime?: AuthoringPreviewRuntimeV1) {
    this.#runtime = runtime
  }

  async prepare(
    compiledRecipe: CompiledRecipeV1,
    inventory: SourceInventoryV1,
    signal?: AbortSignal,
  ): Promise<PreparedAuthoringRevisionV1> {
    if (signal?.aborted) throw new DOMException('Revision preparation was aborted.', 'AbortError')
    const binding = selectFiles(compiledRecipe, inventory)
    if (binding.diagnostics.length > 0) {
      return {
        diagnostics: binding.diagnostics,
        capabilities: new Set(),
        presentedFrames: new Map(),
        validationSummary: { passed: false, stage: 'bind' },
        observableEffect: 'No preview change.',
        commit() {},
        dispose() {},
      }
    }
    if (!this.#runtime) {
      return {
        diagnostics: [diagnostic(
          'CAPABILITY_GAP',
          'The recipe compiles and binds, but no registered preview runtime can execute this operator graph.',
        )],
        capabilities: new Set(),
        presentedFrames: new Map(),
        validationSummary: { passed: false, stage: 'sample' },
        observableEffect: 'Last good preview preserved.',
        commit() {},
        dispose() {},
      }
    }
    return await this.#runtime.preparePreview(compiledRecipe, binding.source, inventory, signal)
  }
}
