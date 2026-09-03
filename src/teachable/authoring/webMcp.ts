import { declaredSensorSummaryV1 } from './sensorConfiguration'
import type { TeachableAuthoringSessionV1 } from './AuthoringSession'
import type { SourceInspectionModeV1 } from './inspection'

interface WebMcpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations?: { readonly readOnlyHint?: boolean }
  readonly execute: (input: Record<string, unknown>) => unknown | Promise<unknown>
}

interface WebMcpModelContext {
  registerTool(definition: WebMcpToolDefinition): void | Promise<void>
  /** Present on the browser's native implementation; absent on the counted broker's shim. */
  executeTool?: unknown
}

type WebMcpDocument = Document & { readonly modelContext?: WebMcpModelContext }

const documentRegistrations = new WeakMap<Document, Promise<boolean>>()

function stateForTool(session: TeachableAuthoringSessionV1): Readonly<Record<string, unknown>> {
  const state = session.getState()
  return {
    phase: state.phase,
    agentEngaged: state.agentEngaged,
    inventory: state.inventory ? {
      sessionId: state.inventory.sessionId,
      entryCount: state.inventory.entries.length,
      truncated: state.inventory.truncated,
      revoked: state.inventory.revoked,
    } : null,
    sensorConfiguration: state.sensorConfiguration,
    declaredSensors: declaredSensorSummaryV1(state.currentArtifact),
    currentRecipe: state.currentArtifact ? {
      name: state.currentArtifact.identity.name,
      formatId: state.currentArtifact.scene.formatId,
      recipeHash: state.currentRecipeHash,
      artifactHash: state.currentArtifact.hashes?.artifactHash,
    } : null,
    diagnostics: state.diagnostics,
    semanticDiff: state.semanticDiff,
    latestHumanReview: state.reviews.at(-1) ? (({ note: _note, ...review }) => review)(state.reviews.at(-1)!) : null,
    validation: state.validation,
    observableEffect: state.observableEffect,
    exportReady: state.exportReady,
    nextStep: nextStepHint(state.phase, state.reviews.length > 0, state.exportReady),
  }
}

/** One sentence the agent can follow without a scripted prompt. */
function nextStepHint(phase: string, hasReview: boolean, exportReady: boolean): string {
  if (phase === 'idle') return 'Ask the user to drop a dataset folder onto the page and confirm the sensor layout; the tools work on that folder only.'
  if (phase === 'revoked') return 'The user revoked access to the folder; ask them to drop it again.'
  if (phase === 'finalized' || exportReady) return 'The recipe is sealed; the user can Export JSON or share it. Nothing more to submit.'
  if (phase === 'review') return hasReview
    ? 'Read latestHumanReview: fix every rejected capability (the issue names what looked wrong) and resubmit the complete recipe with parentRecipeHash set.'
    : 'A revision is validated and rendered. Summarize what each capability binds to and wait for the user to review the preview on the page; do not finalize.'
  return 'Inspect the inventory (egolens_teachable_inspect), read the contract (egolens_teachable_get_contract), then submit a complete recipe (egolens_teachable_apply_revision) that declares exactly the confirmed sensors.'
}

/** Register the five stable Site tools once in the top-level document. */
export async function registerTeachableWebMcpToolsV1(
  session: TeachableAuthoringSessionV1,
  target: Document = document,
): Promise<boolean> {
  const webDocument = target as WebMcpDocument
  if (target.defaultView && target.defaultView !== target.defaultView.top) return false
  if (typeof webDocument.modelContext?.registerTool !== 'function') return false
  const activeRegistration = documentRegistrations.get(target)
  if (activeRegistration) return await activeRegistration

  // The native document.modelContext (Chrome 146+ WebMCP, ChatGPT's in-app browser) calls
  // execute(params, { signal }) and expects a string result; the counted broker's shim passes
  // objects through to its HTTP bridge. Serialize only for the native implementation.
  const native = typeof webDocument.modelContext.executeTool === 'function'
  const engage = <T extends Record<string, unknown>>(handler: (input: T) => unknown | Promise<unknown>) =>
    async (input: Record<string, unknown>): Promise<unknown> => {
      session.markAgentEngaged()
      const result = await handler((input ?? {}) as T)
      return native ? JSON.stringify(result ?? null) : result
    }

  const tools: readonly WebMcpToolDefinition[] = [
    {
      name: 'egolens_teachable_inspect',
      description: 'Step 2 of teaching EgoLens a dataset: look at the files the user dropped, within strict byte and value limits (raw bytes never leave the browser). Modes: inventory (all paths), metadata (one file), text/json/json-sample (bounded), table-schema (Parquet, Arrow/feather, pandas .pkl/.pkl.gz: column names, types, samples, row count). Start with inventory, then table-schema or json on one example of every file kind.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { enum: ['inventory', 'metadata', 'bytes', 'text', 'json', 'json-sample', 'table-schema'] },
          path: { type: 'string', maxLength: 512 },
          maxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
          maxValues: { type: 'integer', minimum: 1, maximum: 512 },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: engage(async (input: { mode: SourceInspectionModeV1; path?: string; maxBytes?: number; maxValues?: number }) =>
        await session.inspect(input)),
    },
    {
      name: 'egolens_teachable_get_contract',
      description: 'Step 3: read the adapter recipe schema, the operator vocabulary with JSON-schema params, and the authoringGuide (rules and the expected order of steps). A recipe is declarative JSON that binds files through operators to outputs; it never contains code.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: engage(async () => session.getContract()),
    },
    {
      name: 'egolens_teachable_apply_revision',
      description: 'Step 4: submit one complete adapter recipe (declarative JSON per the contract). EgoLens compiles it, samples three frames, and returns diagnostics that name the failing input or the missing field; fix and resubmit the whole recipe. Set provenance.author to your agent name and, after an accepted revision, provenance.parentRecipeHash to the current recipe hash from get_state. Do not call finalize yourself: the user reviews the rendered preview on the page and their feedback appears in get_state.latestHumanReview.',
      inputSchema: {
        type: 'object',
        properties: { recipe: { type: 'object' } },
        required: ['recipe'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: engage(async (input: { recipe: unknown }) => await session.applyRevision(input.recipe)),
    },
    {
      name: 'egolens_teachable_get_state',
      description: 'Step 1 and after every revision: the teaching phase, the sensor layout the user confirmed (counts and ids the recipe must declare exactly), validation results with per-sensor sample counts, diagnostics, and the latest human review. The nextStep field says what to do next.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: engage(async () => stateForTool(session)),
    },
    {
      name: 'egolens_teachable_finalize',
      description: 'Last step, only when the user asks: seal the reviewed recipe with hashes so it can be exported and shared. Refused until the user has accepted every presented capability on the page.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: engage(async () => {
        const record = await session.finalize()
        return {
          ok: true,
          revisionId: record.recipeHash,
          phase: session.getState().phase,
          validationState: record.validationSummary,
          observableEffect: 'Finalized artifact cached locally and ready to export.',
        }
      }),
    },
  ]
  const registration = (async (): Promise<boolean> => {
    for (const tool of tools) await webDocument.modelContext!.registerTool(tool)
    return true
  })()
  documentRegistrations.set(target, registration)
  try {
    return await registration
  } catch (error) {
    documentRegistrations.delete(target)
    throw error
  }
}
