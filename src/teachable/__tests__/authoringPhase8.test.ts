import { describe, expect, it, vi } from 'vitest'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import {
  TeachableAuthoringSessionV1,
  type AuthoringRevisionEvaluatorV1,
  type PreparedAuthoringRevisionV1,
} from '../authoring/AuthoringSession'
import { InventoryBindingEvaluatorV1 } from '../authoring/InventoryBindingEvaluator'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { inspectSourceInventoryV1 } from '../authoring/inspection'
import { semanticDiffV1 } from '../authoring/semanticDiff'
import { registerTeachableWebMcpToolsV1 } from '../authoring/webMcp'
import { OperatorRegistry, type CoreOperatorDescriptor } from '../operators/registry'
import { BrowserTimelinePreviewRuntimeV1 } from '../authoring/BrowserTimelinePreviewRuntime'
import { authoringPreviewStoreV1 } from '../authoring/previewStore'
import { sourceSelectorMatchesV1 } from '../authoring/sourceSelectors'
import { nuScenesCompiledRecipe, waymoCompiledRecipe } from '../../adapters/recipes/bundled'
import minimalJson from '../__fixtures__/minimal.egolens-adapter.json'

function recipe(): EgoLensAdapterRecipeV1 {
  return assertValidRecipeV1(structuredClone(minimalJson))
}

function inventory(): SourceInventoryV1 {
  return new SourceInventoryV1([
    ['frames.json', new File(['[{"timestamp_us":1,"x":2},{"timestamp_us":2,"x":4}]'], 'frames.json', { type: 'application/json', lastModified: 1 })],
    ['points/000001.bin', new File([new Uint8Array([1, 2, 3, 4])], '000001.bin', { lastModified: 2 })],
  ], { sessionId: 'test-session' })
}

const testContract = { type: 'object' } as const
const testOperators: readonly CoreOperatorDescriptor[] = ['json.records', 'timeline.from_records'].map((name) => ({
  name,
  majorVersion: 1,
  provider: 'core',
  tier: 1,
  inputContract: testContract,
  paramsContract: testContract,
  outputContract: testContract,
  execution: 'worker',
  deterministic: true,
}))

function session(evaluator: AuthoringRevisionEvaluatorV1): TeachableAuthoringSessionV1 {
  return new TeachableAuthoringSessionV1(evaluator, undefined, new OperatorRegistry(testOperators))
}

function prepared(
  commit: () => void,
  diagnostics: readonly AdapterDiagnostic[] = [],
): PreparedAuthoringRevisionV1 {
  return {
    diagnostics,
    capabilities: new Set(['timeline']),
    presentedFrames: new Map([['timeline', new Set([0, 1])]]),
    validationSummary: { passed: true, stages: ['schema', 'compile', 'bind', 'sample', 'cross-output'] },
    observableEffect: 'Rendered timeline frames 0 and 1.',
    commit,
    dispose: vi.fn(),
  }
}

describe('Phase 8 source inventory and bounded inspection', () => {
  it('binds recursive root files and allowlisted version-root placeholders', () => {
    expect(sourceSelectorMatchesV1(
      waymoCompiledRecipe,
      waymoCompiledRecipe.recipe.sources.poseRows,
      'vehicle_pose/segment.parquet',
    )).toBe(true)
    expect(sourceSelectorMatchesV1(
      nuScenesCompiledRecipe,
      nuScenesCompiledRecipe.recipe.sources.samples,
      'v1.0-mini/sample.json',
    )).toBe(true)
    expect(sourceSelectorMatchesV1(
      nuScenesCompiledRecipe,
      nuScenesCompiledRecipe.recipe.sources.samples,
      'private-root/sample.json',
    )).toBe(false)
  })

  it('keeps file bodies unread until an explicit bounded inspection', async () => {
    const file = new File(['private evidence'], 'private.txt')
    const slice = vi.spyOn(file, 'slice')
    const source = new SourceInventoryV1([['private.txt', file]])
    expect(source.snapshot().entries).toMatchObject([{ path: 'private.txt', size: 16 }])
    expect(slice).not.toHaveBeenCalled()
    await inspectSourceInventoryV1(source, { mode: 'bytes', path: 'private.txt', maxBytes: 4 })
    expect(slice).toHaveBeenCalledTimes(1)
  })

  it('rejects paths outside the authorized inventory and enforces JSON byte limits', async () => {
    const source = inventory()
    await expect(inspectSourceInventoryV1(source, { mode: 'bytes', path: '../secret' })).rejects.toThrow(/Invalid inventory path/u)
    await expect(inspectSourceInventoryV1(source, { mode: 'json', path: 'frames.json', maxBytes: 8 })).rejects.toThrow(/complete file/u)
    const result = await inspectSourceInventoryV1(source, { mode: 'json', path: 'frames.json', maxBytes: 1024, maxValues: 32 })
    expect(result.data).toMatchObject({ schema: { type: 'array', length: 2 }, numeric: { finiteCount: 4 } })
  })

  it('bounds the returned JSON structure instead of filling it with truncation markers', async () => {
    const source = new SourceInventoryV1([
      ['large.json', new File([JSON.stringify(Array.from({ length: 1_000 }, (_, index) => index))], 'large.json')],
    ])
    const result = await inspectSourceInventoryV1(source, {
      mode: 'json',
      path: 'large.json',
      maxBytes: 16 * 1024,
      maxValues: 16,
    })
    const data = result.data as { sample: unknown[]; valueCount: number }
    expect(result.truncated).toBe(true)
    expect(data.valueCount).toBe(16)
    expect(data.sample.length).toBe(15)
  })

  it('makes revocation explicit and recoverable', () => {
    const source = inventory()
    source.revoke()
    expect(source.snapshot()).toMatchObject({ revoked: true, entries: [] })
    expect(() => source.resolveAuthorizedSource()).toThrow(/SOURCE_INVENTORY_REVOKED/u)
  })
})

describe('Phase 8 revision transaction and review gate', () => {
  it('commits a complete validated revision and computes separate identities', async () => {
    const commit = vi.fn()
    const evaluator: AuthoringRevisionEvaluatorV1 = { prepare: vi.fn(async () => prepared(commit)) }
    const authoring = session(evaluator)
    authoring.start(inventory())
    const result = await authoring.applyRevision(recipe())

    expect(result).toMatchObject({ ok: true, phase: 'review' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(authoring.getState().currentArtifact?.hashes).toMatchObject({
      recipeHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      artifactHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      formatFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      operatorSetFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    })
    expect(authoring.getState().currentArtifact?.provenance?.datasetFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('rejects a stale parent and preserves the last good artifact and preview', async () => {
    const commit = vi.fn()
    const evaluator: AuthoringRevisionEvaluatorV1 = { prepare: vi.fn(async () => prepared(commit)) }
    const authoring = session(evaluator)
    authoring.start(inventory())
    await authoring.applyRevision(recipe())
    const first = authoring.getState().currentArtifact
    const stale = structuredClone(recipe())
    stale.identity = { ...stale.identity, name: 'Stale title' }
    stale.provenance = { author: 'codex', createdAt: '2026-08-30T00:00:00.000Z', parentRecipeHash: `sha256:${'0'.repeat(64)}` }

    const result = await authoring.applyRevision(stale)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toMatchObject([{ code: 'STALE_PARENT_RECIPE' }])
    expect(authoring.getState().currentArtifact).toEqual(first)
    expect(authoring.getState().observableEffect).toBe('Last good preview preserved.')
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('preserves the last good revision when isolated sample preparation fails', async () => {
    let fail = false
    const evaluator: AuthoringRevisionEvaluatorV1 = {
      prepare: vi.fn(async () => {
        if (fail) throw new Error('sample exploded')
        return prepared(vi.fn())
      }),
    }
    const authoring = session(evaluator)
    authoring.start(inventory())
    await authoring.applyRevision(recipe())
    const first = authoring.getState().currentArtifact!
    fail = true
    const next = structuredClone(recipe())
    next.scene.timeline.nominalFrameRate = 20
    next.provenance = { author: 'codex', createdAt: '2026-08-30T00:00:00.000Z', parentRecipeHash: first.hashes!.recipeHash }
    const result = await authoring.applyRevision(next)
    expect(result.ok).toBe(false)
    expect(authoring.getState().currentArtifact).toEqual(first)
    expect(authoring.getState().diagnostics[0].code).toBe('REVISION_PREPARE_FAILED')
  })

  it('requires accepted review of actually presented frames before finalization and export', async () => {
    const authoring = session({ prepare: async () => prepared(vi.fn()) })
    authoring.start(inventory())
    await authoring.applyRevision(recipe())
    await expect(authoring.finalize()).rejects.toThrow(/HUMAN_REVIEW_INCOMPLETE/u)
    expect(() => authoring.submitHumanReview({ capability: 'timeline', frameIndices: [9], verdict: 'accepted' })).toThrow(/presented/u)
    authoring.submitHumanReview({ capability: 'timeline', frameIndices: [0, 1], verdict: 'accepted', note: 'Looks correct locally.' })
    const record = await authoring.finalize()
    expect(record.reviewedCapabilities).toEqual(['timeline'])
    expect(authoring.getState()).toMatchObject({ phase: 'finalized', exportReady: true })
    const exported = JSON.parse(authoring.exportArtifact()) as EgoLensAdapterRecipeV1
    expect(exported.provenance?.humanReviewReceipt).not.toHaveProperty('note')
    expect(assertValidRecipeV1(exported)).toMatchObject({ kind: 'egolens-adapter' })
  })
})

describe('Phase 8 diff, capability gap, and Site tools', () => {
  it('sample-runs and visibly commits a bounded JSON timeline through registered core operators', async () => {
    authoringPreviewStoreV1.clear()
    const timeline = structuredClone(recipe())
    timeline.engine.requiredOperators = {
      'json.records': { major: 1, provider: 'core' },
      'timeline.sort': { major: 1, provider: 'core' },
    }
    timeline.pipelines.timeline = {
      nodes: [{ id: 'sortTimeline', op: 'timeline.sort', version: 1, inputs: { rows: 'frames.rows' }, params: { timestampField: 'timestamp_us' } }],
      result: 'sortTimeline.frames',
    }
    const authoring = new TeachableAuthoringSessionV1(
      new InventoryBindingEvaluatorV1(new BrowserTimelinePreviewRuntimeV1()),
    )
    authoring.start(inventory())
    const result = await authoring.applyRevision(timeline)
    expect(result).toMatchObject({ ok: true, observableEffect: 'Rendered a 2-frame timeline preview.' })
    expect(authoringPreviewStoreV1.getSnapshot()).toMatchObject({ frameCount: 2, sampledFrames: [0, 1] })
  })

  it('keeps title-only changes out of the semantic diff', () => {
    const before = recipe()
    const after = structuredClone(before)
    after.identity = { ...after.identity, name: 'Display title only' }
    expect(semanticDiffV1(before, after).changed).toBe(false)
    after.scene.timeline.nominalFrameRate = 12
    expect(semanticDiffV1(before, after).entries.find((entry) => entry.group === 'timeline-synchronization')?.changed).toBe(true)
  })

  it('returns a structured capability gap when selectors bind but no preview runtime is installed', async () => {
    const authoring = session(new InventoryBindingEvaluatorV1())
    authoring.start(inventory())
    const result = await authoring.applyRevision(recipe())
    expect(result).toMatchObject({ ok: false, phase: 'capability-gap' })
    expect(result.diagnostics).toMatchObject([{ code: 'CAPABILITY_GAP' }])
  })

  it('registers the five top-level WebMCP tools once and engages only on first execution', async () => {
    const authoring = session({ prepare: async () => prepared(vi.fn()) })
    authoring.start(inventory())
    const tools = new Map<string, { execute(input: Record<string, unknown>): Promise<unknown> }>()
    const target = {
      modelContext: {
        registerTool: vi.fn((tool: { name: string; execute(input: Record<string, unknown>): Promise<unknown> }) => { tools.set(tool.name, tool) }),
      },
    } as unknown as Document
    const registrations = await Promise.all([
      registerTeachableWebMcpToolsV1(authoring, target),
      registerTeachableWebMcpToolsV1(authoring, target),
    ])
    expect(registrations).toEqual([true, true])
    expect(await registerTeachableWebMcpToolsV1(authoring, target)).toBe(true)
    expect(tools.size).toBe(5)
    expect(authoring.getState().agentEngaged).toBe(false)
    await tools.get('egolens_teachable_get_state')!.execute({})
    expect(authoring.getState().agentEngaged).toBe(true)
  })
})
