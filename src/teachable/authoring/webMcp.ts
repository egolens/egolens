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
  }
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

  const engage = <T extends Record<string, unknown>>(handler: (input: T) => unknown | Promise<unknown>) =>
    async (input: Record<string, unknown>): Promise<unknown> => {
      session.markAgentEngaged()
      return await handler(input as T)
    }

  const tools: readonly WebMcpToolDefinition[] = [
    {
      name: 'egolens_teachable_inspect',
      description: 'Inspect only the active user-authorized source inventory with strict byte and value limits.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { enum: ['inventory', 'metadata', 'bytes', 'text', 'json', 'table-schema'] },
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
      description: 'Read the EgoLens adapter schema, normalized outputs, registered operators, limits, and diagnostics.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: engage(async () => session.getContract()),
    },
    {
      name: 'egolens_teachable_apply_revision',
      description: 'Validate and transactionally apply one complete adapter recipe. The current parent recipe hash is required for revisions.',
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
      description: 'Read the current teaching phase, recipe identity, diagnostics, semantic diff, validation, and latest review without private notes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: engage(async () => stateForTool(session)),
    },
    {
      name: 'egolens_teachable_finalize',
      description: 'Finalize and cache the current engine-validated recipe only after every presented capability has accepted human review.',
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
