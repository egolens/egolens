import { assertValidSensorConfigurationV1, sensorConfigurationDiagnosticsV1, type SensorConfigurationV1 } from './sensorConfiguration'
import schema from '../schema/egolens-adapter-v1.schema.json'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import type { OperatorRegistry } from '../operators/registry'
import { compileRecipeV1, RECIPE_ENGINE_VERSION, type CompiledRecipeV1 } from '../recipe/compiler'
import { AdapterCompileError, AdapterValidationError, type AdapterDiagnostic } from '../recipe/diagnostics'
import type { EgoLensAdapterRecipeV1, JsonObject } from '../recipe/types'
import type { NormalizedCapabilityV1 } from '../runtime/normalizedScene'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import a2d2Example from '../examples/a2d2.egolens-adapter.json'
import kittiRawExample from '../examples/kitti-raw.egolens-adapter.json'
import pandasetExample from '../examples/pandaset.egolens-adapter.json'
import { formatFingerprintV1, withComputedArtifactHashesV1, verifySuppliedHashesV1 } from './hashes'
import { inspectSourceInventoryV1, INSPECTION_LIMITS_V1, type SourceInspectionRequestV1, type SourceInspectionResultV1 } from './inspection'
import { TeachableArtifactCacheV1, type FinalizedArtifactRecordV1 } from './persistence'
import { readRecipeArtifactFileV1, serializeRecipeArtifactV1 } from './portability'
import {
  requiredHumanReviewCapabilitiesV1,
  reviewReceiptV1,
  type HumanReviewCapabilityV1,
  type HumanReviewItemV1,
} from './review'
import { semanticDiffV1, type SemanticDiffV1 } from './semanticDiff'
import { SourceInventoryV1, type SourceInventorySnapshotV1 } from './SourceInventory'

export type AuthoringPhaseV1 =
  | 'idle'
  | 'inspecting'
  | 'validating'
  | 'review'
  | 'finalized'
  | 'capability-gap'
  | 'revoked'

export interface PreparedAuthoringRevisionV1 {
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly capabilities: ReadonlySet<NormalizedCapabilityV1>
  readonly presentedFrames: ReadonlyMap<HumanReviewCapabilityV1, ReadonlySet<number>>
  readonly validationSummary: JsonObject
  readonly observableEffect: string
  /** Swap the isolated, validated candidate into the visible scene. */
  commit(): void | Promise<void>
  /** Dispose candidate resources when validation or commit fails. */
  dispose(): void
}

export interface AuthoringRevisionEvaluatorV1 {
  prepare(
    compiledRecipe: CompiledRecipeV1,
    inventory: SourceInventoryV1,
    signal?: AbortSignal,
  ): Promise<PreparedAuthoringRevisionV1>
}

export interface AuthoringValidationStateV1 {
  readonly capabilities: readonly NormalizedCapabilityV1[]
  readonly requiredReview: readonly HumanReviewCapabilityV1[]
  readonly presentedFrames: Readonly<Partial<Record<HumanReviewCapabilityV1, readonly number[]>>>
  readonly summary: JsonObject
}

/** One agent tool call as shown in the review dock's activity feed. */
export interface AgentActivityV1 {
  readonly at: number
  readonly tool: string
  readonly arg: string
  readonly ms: number
  readonly result: string
  readonly kind: 'ok' | 'bad' | 'info'
}

export interface AuthoringSessionStateV1 {
  readonly phase: AuthoringPhaseV1
  readonly agentEngaged: boolean
  /** Newest last; capped at 200 entries. Reset when a folder is (re)started. */
  readonly activity: readonly AgentActivityV1[]
  readonly revisionCount: number
  readonly inspectionCount: number
  readonly inventory: SourceInventorySnapshotV1 | null
  /** Human-confirmed sensor layout; null when authoring started without one. */
  readonly sensorConfiguration: SensorConfigurationV1 | null
  readonly currentArtifact: EgoLensAdapterRecipeV1 | null
  readonly currentRecipeHash: string | null
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly semanticDiff: SemanticDiffV1 | null
  readonly reviews: readonly HumanReviewItemV1[]
  readonly validation: AuthoringValidationStateV1 | null
  readonly observableEffect: string | null
  readonly exportReady: boolean
}

export interface ApplyRevisionResultV1 {
  readonly ok: boolean
  readonly revisionId: string | null
  readonly phase: AuthoringPhaseV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly observableEffect?: string
}

function diagnostic(
  stage: AdapterDiagnostic['stage'],
  code: string,
  hint: string,
  jsonPointer?: string,
): AdapterDiagnostic {
  return { stage, severity: 'error', code, hint, jsonPointer }
}

function asDiagnostics(error: unknown): readonly AdapterDiagnostic[] {
  if (error instanceof AdapterValidationError || error instanceof AdapterCompileError) return error.diagnostics
  return [diagnostic(
    'sample',
    'REVISION_PREPARE_FAILED',
    error instanceof Error ? error.message : String(error),
  )]
}

function presentedRecord(
  values: ReadonlyMap<HumanReviewCapabilityV1, ReadonlySet<number>>,
): Readonly<Partial<Record<HumanReviewCapabilityV1, readonly number[]>>> {
  return Object.fromEntries([...values].map(([capability, frames]) => [capability, [...frames].sort((a, b) => a - b)]))
}

function initialState(): AuthoringSessionStateV1 {
  return {
    phase: 'idle',
    agentEngaged: false,
    activity: [],
    revisionCount: 0,
    inspectionCount: 0,
    inventory: null,
    sensorConfiguration: null,
    currentArtifact: null,
    currentRecipeHash: null,
    diagnostics: [],
    semanticDiff: null,
    reviews: [],
    validation: null,
    observableEffect: null,
    exportReady: false,
  }
}

/** Shared command layer for the human UI, imports, and top-level WebMCP tools. */
export class TeachableAuthoringSessionV1 {
  readonly #evaluator: AuthoringRevisionEvaluatorV1
  readonly #cache: TeachableArtifactCacheV1
  readonly #operators: OperatorRegistry
  readonly #listeners = new Set<() => void>()
  #inventory: SourceInventoryV1 | null = null
  #state = initialState()

  constructor(
    evaluator: AuthoringRevisionEvaluatorV1,
    cache = new TeachableArtifactCacheV1(),
    operators: OperatorRegistry = bundledPhase2OperatorRegistry,
  ) {
    this.#evaluator = evaluator
    this.#cache = cache
    this.#operators = operators
  }

  getState = (): AuthoringSessionStateV1 => this.#state

  /** Append one tool call to the activity feed (the WebMCP wrapper calls this). */
  recordActivity(entry: Omit<AgentActivityV1, 'at'>): void {
    const activity = [...this.#state.activity, { ...entry, at: Date.now() }].slice(-200)
    this.#set({
      ...this.#state,
      activity,
      revisionCount: this.#state.revisionCount + (entry.tool === 'apply_revision' ? 1 : 0),
      inspectionCount: this.#state.inspectionCount + (entry.tool === 'inspect' ? 1 : 0),
    })
  }

  /**
   * Reopen authoring on a folder that is already rendering with a recipe: the
   * confirmed layout is taken from the recipe's declared sensors and the recipe
   * becomes the first revision, so the human can reject what looked wrong and
   * an agent can revise from there.
   */
  async resumeFromArtifact(inventory: SourceInventoryV1, recipe: EgoLensAdapterRecipeV1): Promise<ApplyRevisionResultV1> {
    const byModality = (modality: 'lidar' | 'radar' | 'camera') => recipe.scene.sensors.filter((sensor) => sensor.modality === modality).map((sensor) => sensor.id)
    const configuration: SensorConfigurationV1 = {
      lidar: byModality('lidar').length, radar: byModality('radar').length, camera: byModality('camera').length,
      names: { lidar: byModality('lidar'), radar: byModality('radar'), camera: byModality('camera') },
      datasetName: recipe.identity.name,
    }
    this.start(inventory, { sensorConfiguration: configuration })
    const { hashes: _hashes, ...rest } = recipe
    const { parentRecipeHash: _parent, ...provenance } = rest.provenance ?? { author: 'imported', createdAt: new Date().toISOString() }
    return await this.applyRevision({ ...rest, provenance: { ...provenance, author: provenance.author === 'imported' || provenance.author === 'registry' ? 'human' : provenance.author } })
  }

  /** The live user-authorized inventory, for rendering the current recipe in the viewer. */
  getInventory(): SourceInventoryV1 | null {
    return this.#inventory
  }

  /**
   * Finalized recipes saved in this browser whose format fingerprint matches
   * the dropped folder (same path templates and readers), newest first. Lets a
   * taught format render again without authoring.
   */
  async findSavedRecipes(inventory: SourceInventoryV1): Promise<readonly FinalizedArtifactRecordV1[]> {
    const records = await this.#cache.listAll()
    const matches: FinalizedArtifactRecordV1[] = []
    for (const record of records) {
      try {
        if (await formatFingerprintV1(record.artifact, inventory) === record.formatFingerprint) matches.push(record)
      } catch {
        // A record from an older engine that no longer fingerprints is simply not offered.
      }
    }
    return matches
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  start(inventory: SourceInventoryV1, options: { readonly sensorConfiguration?: SensorConfigurationV1 | null } = {}): void {
    // Restarting on the same folder (name or layout edited on the P0 screen) keeps its authorization.
    if (this.#inventory && this.#inventory !== inventory) this.#inventory.revoke()
    this.#inventory = inventory
    const sensorConfiguration = options.sensorConfiguration ? assertValidSensorConfigurationV1(options.sensorConfiguration) : null
    this.#set({ ...initialState(), phase: 'inspecting', inventory: inventory.snapshot(), sensorConfiguration })
  }

  revoke(): void {
    this.#inventory?.revoke()
    this.#inventory = null
    this.#set({ ...this.#state, phase: 'revoked', inventory: null, exportReady: false })
  }

  markAgentEngaged(): void {
    if (!this.#state.agentEngaged) this.#set({ ...this.#state, agentEngaged: true })
  }

  async inspect(request: SourceInspectionRequestV1, signal?: AbortSignal): Promise<SourceInspectionResultV1> {
    return await inspectSourceInventoryV1(this.#requireInventory(), request, signal)
  }

  getContract(options: { readonly example?: string } = {}): Readonly<Record<string, unknown>> {
    const examples: Record<string, { readonly summary: string; readonly recipe: unknown }> = {
      'kitti-raw': { summary: 'Ego-frame dataset: text timestamp tables, per-camera rectified calibration from key-value calib files, Velodyne bin records, XML tracklets exploded into boxes.', recipe: kittiRawExample },
      pandaset: { summary: 'World-frame dataset: JSON arrays of float-second timestamps and quaternion poses (records.derive scale/integer, json.records indexField), pandas pickle points and cuboids, poseChain with a constant axis fix, outputFrame "world".', recipe: pandasetExample },
      a2d2: { summary: 'Per-file sidecars: JSON per camera frame, NPZ per lidar view, axis-vector calibration, path-derived linkage.', recipe: a2d2Example },
    }
    const requested = options.example && examples[options.example] ? { example: options.example, ...examples[options.example]! } : undefined
    return {
      schemaVersion: 1,
      exampleRecipes: Object.fromEntries(Object.entries(examples).map(([id, entry]) => [id, entry.summary])),
      ...(requested ? { example: requested } : {}),
      engineVersion: RECIPE_ENGINE_VERSION,
      authoringGuide: [
        '1. egolens_teachable_get_state: read the confirmed sensor layout (counts and ids) and, when present, sensorConfiguration.datasetName. The recipe must declare and bind exactly those sensors and use that name as identity.name; a different layout or name is rejected. Without a datasetName, choose a short descriptive identity.name yourself.',
        '2. egolens_teachable_inspect: inventory first, then metadata/text/json/json-sample/table-schema on one example of every file kind (bounded maxBytes). Never guess a column name you could read.',
        '3. Read recipeSchema and operators below. Call get_contract again with { example: "<id>" } (ids in exampleRecipes) to read a complete, sealed recipe for the closest layout and adapt it: change identity, match, sources, sensor ids, and provenance, keep the operator patterns. Recipes are declarative: sources (readers) → pipelines of operators → outputs bound as "<pipelineId>.result". Set scene.formatId to the dataset id, provenance.author to your lowercase agent id (e.g. "chatgpt", "codex"), provenance.createdAt to now.',
        '4. egolens_teachable_apply_revision with the COMPLETE recipe every time (a rejected revision keeps nothing). Diagnostics name the input or field to fix. Bind timeline first, then pointClouds and cameraImages, then boxes3d, egoPoses, segmentation, segmentMetadata.',
        '5. Conventions: ego frame is x-forward, y-left, z-up; camera frames are optical (x-right, y-down, z-forward); poses are ego ← sensor (compose or invert with poseChain when the dataset publishes the other direction or another axis convention); timestamps are integers in the declared unit (records.derive scale/integer converts float seconds).',
        '6. World-frame datasets: bind points with outputFrame "world" and boxes with frameId "world" and provide egoPoses; EgoLens converts them per frame.',
        '7. After each accepted revision call get_state and stop when validation passes: summarize the bindings and let the user review the rendered preview. Their accept/reject per capability (with an issue name) arrives in get_state.latestHumanReview; revise from it. Do not call finalize unless the user asks.',
      ],
      recipeSchema: schema,
      normalizedOutputs: [
        'timeline', 'egoPoses', 'pointClouds', 'radarPointClouds', 'cameraImages',
        'boxes3d', 'boxes2d', 'boxAssociations', 'trajectories', 'lidarSegmentation',
        'cameraSegmentation', 'keypoints3d', 'keypoints2d', 'segmentMetadata',
      ],
      operators: this.#operators.list().map((operator) => ({
        name: operator.name,
        majorVersion: operator.majorVersion,
        provider: operator.provider,
        execution: operator.execution,
        inputContract: operator.inputContract,
        paramsContract: operator.paramsContract,
        outputContract: operator.outputContract,
        ...(operator.provider === 'extension' ? { package: operator.package, resources: operator.resources } : {}),
      })),
      inspectionLimits: INSPECTION_LIMITS_V1,
      // The confirmed layout is part of the public contract: every modality
      // count here must be matched by declared (and bound) scene sensors.
      sensorConfiguration: this.#state.sensorConfiguration,
      diagnostics: this.#state.diagnostics,
    }
  }

  async applyRevision(input: string | unknown, signal?: AbortSignal): Promise<ApplyRevisionResultV1> {
    const inventory = this.#requireInventory()
    const lastGood = this.#state
    this.#set({ ...this.#state, phase: 'validating', diagnostics: [], exportReady: false })
    let prepared: PreparedAuthoringRevisionV1 | null = null
    try {
      const recipe = assertValidRecipeV1(input)
      const suppliedHashErrors = await verifySuppliedHashesV1(recipe, inventory, signal)
      if (suppliedHashErrors.length > 0) {
        throw new AdapterValidationError(suppliedHashErrors.map((code) => diagnostic('schema', code, 'The supplied artifact hash does not recompute exactly.', '/hashes')))
      }
      if (
        lastGood.currentRecipeHash
        && recipe.provenance?.parentRecipeHash !== lastGood.currentRecipeHash
      ) {
        throw new AdapterCompileError([diagnostic(
          'compile',
          'STALE_PARENT_RECIPE',
          `Revision parent ${recipe.provenance?.parentRecipeHash ?? '(missing)'} does not match current recipe ${lastGood.currentRecipeHash}.`,
          '/provenance/parentRecipeHash',
        )])
      }
      // The finalized export is only ever attributed to the declared author;
      // a revision without one would silently export as "imported".
      if (recipe.provenance?.author === undefined || recipe.provenance.author === 'imported' || recipe.provenance.author === 'registry') {
        throw new AdapterCompileError([diagnostic(
          'compile',
          'PROVENANCE_AUTHOR_REQUIRED',
          'Declare provenance.author as the authoring agent id (e.g. "codex", "chatgpt") and provenance.createdAt on every revision; "imported" and "registry" are reserved.',
          '/provenance/author',
        )])
      }
      const sensorDiagnostics = sensorConfigurationDiagnosticsV1(recipe, this.#state.sensorConfiguration)
      if (sensorDiagnostics.length > 0) throw new AdapterCompileError(sensorDiagnostics)
      const compiled = compileRecipeV1(recipe, this.#operators)
      prepared = await this.#evaluator.prepare(compiled, inventory, signal)
      const errors = prepared.diagnostics.filter((item) => item.severity === 'error')
      if (errors.length > 0) throw new AdapterCompileError(errors)
      const artifact = await withComputedArtifactHashesV1(recipe, inventory, signal)
      const recipeHash = artifact.hashes?.recipeHash
      if (!recipeHash) throw new Error('Recipe hash was not computed.')
      await prepared.commit()
      const capabilities = [...prepared.capabilities].sort()
      const requiredReview = requiredHumanReviewCapabilitiesV1(prepared.capabilities)
      const validation: AuthoringValidationStateV1 = {
        capabilities,
        requiredReview,
        presentedFrames: presentedRecord(prepared.presentedFrames),
        summary: prepared.validationSummary,
      }
      this.#set({
        ...this.#state,
        phase: 'review',
        inventory: inventory.snapshot(),
        currentArtifact: artifact,
        currentRecipeHash: recipeHash,
        diagnostics: prepared.diagnostics,
        semanticDiff: semanticDiffV1(lastGood.currentArtifact, artifact),
        reviews: lastGood.reviews.filter((review) => review.recipeHash === recipeHash),
        validation,
        observableEffect: prepared.observableEffect,
        exportReady: false,
      })
      return { ok: true, revisionId: recipeHash, phase: 'review', diagnostics: prepared.diagnostics, observableEffect: prepared.observableEffect }
    } catch (error) {
      prepared?.dispose()
      const diagnostics = asDiagnostics(error)
      const capabilityGap = diagnostics.some((item) => item.code === 'CAPABILITY_GAP' || item.code === 'OPERATOR_MISSING')
      this.#set({
        ...lastGood,
        phase: capabilityGap ? 'capability-gap' : lastGood.currentArtifact ? 'review' : 'inspecting',
        diagnostics,
        observableEffect: lastGood.currentArtifact ? 'Last good preview preserved.' : null,
      })
      return { ok: false, revisionId: lastGood.currentRecipeHash, phase: this.#state.phase, diagnostics }
    }
  }

  submitHumanReview(item: Omit<HumanReviewItemV1, 'recipeHash'>): void {
    const recipeHash = this.#state.currentRecipeHash
    const validation = this.#state.validation
    if (!recipeHash || !validation) throw new Error('No validated revision is ready for human review.')
    if (!validation.requiredReview.includes(item.capability)) throw new Error(`Capability ${item.capability} does not require review.`)
    const presented = new Set(validation.presentedFrames[item.capability] ?? [])
    if (item.frameIndices.length === 0 || item.frameIndices.some((frame) => !presented.has(frame))) {
      throw new Error(`Review frames for ${item.capability} must have been presented by the current revision.`)
    }
    if (item.verdict === 'rejected' && !item.issue) throw new Error('Rejected reviews require an issue.')
    const review: HumanReviewItemV1 = { ...item, recipeHash, frameIndices: [...new Set(item.frameIndices)].sort((a, b) => a - b) }
    const reviews = this.#state.reviews.filter((existing) => existing.capability !== item.capability)
    reviews.push(review)
    this.#set({ ...this.#state, reviews, exportReady: false })
  }

  async finalize(): Promise<FinalizedArtifactRecordV1> {
    const inventory = this.#requireInventory()
    const artifact = this.#state.currentArtifact
    const recipeHash = this.#state.currentRecipeHash
    const validation = this.#state.validation
    if (!artifact || !recipeHash || !validation) throw new Error('No engine-validated revision is ready to finalize.')
    const reviews = validation.requiredReview.map((capability) =>
      this.#state.reviews.find((review) => review.recipeHash === recipeHash && review.capability === capability),
    )
    if (reviews.some((review) => !review || review.verdict !== 'accepted')) {
      throw new Error('HUMAN_REVIEW_INCOMPLETE: every presented capability requires an accepted review.')
    }
    const finalizedAt = new Date().toISOString()
    const finalized = await withComputedArtifactHashesV1({
      ...artifact,
      provenance: {
        author: artifact.provenance?.author ?? 'imported',
        createdAt: artifact.provenance?.createdAt ?? finalizedAt,
        ...artifact.provenance,
        validatorVersion: RECIPE_ENGINE_VERSION,
        validationSummary: validation.summary,
        humanReviewReceipt: reviewReceiptV1(reviews as HumanReviewItemV1[]) as JsonObject,
      },
    }, inventory)
    const finalizedRecipeHash = finalized.hashes?.recipeHash
    const formatFingerprint = finalized.hashes?.formatFingerprint
    if (!finalizedRecipeHash || !formatFingerprint) throw new Error('Finalized artifact identity is incomplete.')
    const record: FinalizedArtifactRecordV1 = {
      recipeHash: finalizedRecipeHash,
      formatFingerprint,
      artifact: finalized,
      finalizedAt,
      capabilities: validation.capabilities,
      reviewedCapabilities: validation.requiredReview,
      matcherEvidence: { rootEntries: artifact.match.inventory.rootEntries.map((entry) => entry.path) },
      validationSummary: validation.summary,
    }
    await this.#cache.saveFinalized(record)
    this.#set({ ...this.#state, phase: 'finalized', currentArtifact: finalized, exportReady: true })
    return record
  }

  async importArtifact(file: File, signal?: AbortSignal): Promise<ApplyRevisionResultV1> {
    return await this.applyRevision(await readRecipeArtifactFileV1(file), signal)
  }

  exportArtifact(): string {
    if (!this.#state.exportReady || !this.#state.currentArtifact) throw new Error('Finalize the current revision before export.')
    return serializeRecipeArtifactV1(this.#state.currentArtifact)
  }

  #requireInventory(): SourceInventoryV1 {
    if (!this.#inventory) throw new Error('No active Teachable Lens source inventory.')
    if (this.#inventory.revoked) throw new Error('SOURCE_INVENTORY_REVOKED: select the dataset folder again.')
    return this.#inventory
  }

  #set(state: AuthoringSessionStateV1): void {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
