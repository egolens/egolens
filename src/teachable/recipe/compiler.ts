import type { DatasetManifest } from '../../types/dataset'
import type { RecipeOperatorDescriptor } from '../operators/registry'
import { OperatorRegistry } from '../operators/registry'
import type { NormalizedCapabilityV1, NormalizedManifestV1 } from '../runtime/normalizedScene'
import { normalizedManifestToDatasetManifest, recipeManifestProjection } from '../runtime/compatibilityBridge'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import { AdapterCompileError, type AdapterDiagnostic } from './diagnostics'
import type { EgoLensAdapterRecipeV1, RecipePipelineNodeV1 } from './types'

export const RECIPE_ENGINE_VERSION = '1.0.0'

export interface CompiledPipelineV1 {
  readonly id: string
  readonly nodes: readonly RecipePipelineNodeV1[]
  readonly result: string
}

export interface CompiledRecipeV1 {
  readonly recipe: EgoLensAdapterRecipeV1
  readonly normalizedManifest: NormalizedManifestV1
  readonly compatibilityManifest: DatasetManifest
  readonly pipelines: ReadonlyMap<string, CompiledPipelineV1>
  readonly operators: ReadonlyMap<string, RecipeOperatorDescriptor>
  readonly capabilities: ReadonlySet<NormalizedCapabilityV1>
}

function compareVersions(left: string, right: string): number {
  const a = left.split(/[+-]/u, 1)[0].split('.').map(Number)
  const b = right.split(/[+-]/u, 1)[0].split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

function diagnostic(code: string, hint: string, jsonPointer?: string, got?: unknown): AdapterDiagnostic {
  return { stage: 'compile', severity: 'error', code, hint, jsonPointer, got }
}

function topologicalNodes(
  pipelineId: string,
  nodes: readonly RecipePipelineNodeV1[],
  result: string,
  externalIds: ReadonlySet<string>,
  diagnostics: AdapterDiagnostic[],
): readonly RecipePipelineNodeV1[] {
  const byId = new Map<string, RecipePipelineNodeV1>()
  for (const node of nodes) {
    if (byId.has(node.id)) {
      diagnostics.push(diagnostic('DUPLICATE_NODE_ID', `Node "${node.id}" is duplicated.`, `/pipelines/${pipelineId}/nodes`))
    }
    byId.set(node.id, node)
  }
  const dependencies = new Map<string, Set<string>>()
  for (const node of nodes) {
    const refs = new Set<string>()
    for (const reference of Object.values(node.inputs ?? {})) {
      const root = reference.split('.')[0]
      if (byId.has(root)) refs.add(root)
      else if (!externalIds.has(root) && root !== 'scene') {
        diagnostics.push(diagnostic('REFERENCE_MISSING', `Input "${reference}" does not resolve.`, `/pipelines/${pipelineId}/nodes/${node.id}/inputs`, reference))
      }
    }
    dependencies.set(node.id, refs)
  }

  const resultRoot = result.split('.')[0]
  if (!byId.has(resultRoot)) {
    diagnostics.push(diagnostic('PIPELINE_RESULT_MISSING', `Result "${result}" does not reference a node in pipeline "${pipelineId}".`, `/pipelines/${pipelineId}/result`, result))
    return []
  }

  const temporary = new Set<string>()
  const permanent = new Set<string>()
  const ordered: RecipePipelineNodeV1[] = []
  const visit = (id: string): void => {
    if (permanent.has(id)) return
    if (temporary.has(id)) {
      diagnostics.push(diagnostic('GRAPH_CYCLE', `Pipeline "${pipelineId}" contains a cycle at node "${id}".`, `/pipelines/${pipelineId}`))
      return
    }
    temporary.add(id)
    for (const dependency of dependencies.get(id) ?? []) visit(dependency)
    temporary.delete(id)
    permanent.add(id)
    const node = byId.get(id)
    if (node) ordered.push(node)
  }
  visit(resultRoot)

  for (const node of nodes) {
    if (!permanent.has(node.id)) {
      diagnostics.push(diagnostic('UNREACHABLE_NODE', `Node "${node.id}" cannot contribute to pipeline result "${result}".`, `/pipelines/${pipelineId}/nodes/${node.id}`))
    }
  }
  return ordered
}

function validateScene(recipe: EgoLensAdapterRecipeV1, diagnostics: AdapterDiagnostic[]): void {
  const frameIds = new Set<string>()
  // Point sensors and cameras historically use separate renderer ID spaces.
  // Radar shares the point-sensor space because both project to lidarSensors.
  const pointRendererIds = new Set<number>()
  const cameraRendererIds = new Set<number>()
  for (const frame of recipe.scene.coordinateFrames) {
    if (frameIds.has(frame.id)) diagnostics.push(diagnostic('DUPLICATE_FRAME_ID', `Coordinate frame "${frame.id}" is duplicated.`, '/scene/coordinateFrames'))
    frameIds.add(frame.id)
    const axes = [frame.convention.x, frame.convention.y, frame.convention.z].map((axis) => {
      if (axis === 'forward' || axis === 'backward') return 'longitudinal'
      if (axis === 'left' || axis === 'right') return 'lateral'
      return 'vertical'
    })
    if (new Set(axes).size !== 3) diagnostics.push(diagnostic('INVALID_AXIS_MAP', `Coordinate frame "${frame.id}" must map one longitudinal, lateral, and vertical axis.`, '/scene/coordinateFrames'))
  }
  for (const frame of recipe.scene.coordinateFrames) {
    if (frame.parent && !frameIds.has(frame.parent)) diagnostics.push(diagnostic('FRAME_PARENT_MISSING', `Parent frame "${frame.parent}" does not exist.`, '/scene/coordinateFrames'))
  }
  const sensorIds = new Set<string>()
  for (const sensor of recipe.scene.sensors) {
    if (sensorIds.has(sensor.id)) diagnostics.push(diagnostic('DUPLICATE_SENSOR_ID', `Sensor "${sensor.id}" is duplicated.`, '/scene/sensors'))
    const rendererIds = sensor.modality === 'camera' ? cameraRendererIds : pointRendererIds
    if (rendererIds.has(sensor.rendererId)) diagnostics.push(diagnostic('DUPLICATE_RENDERER_ID', `Renderer sensor id ${sensor.rendererId} is duplicated within the ${sensor.modality === 'camera' ? 'camera' : 'point-sensor'} namespace.`, '/scene/sensors'))
    sensorIds.add(sensor.id)
    rendererIds.add(sensor.rendererId)
    if (!frameIds.has(sensor.frameId)) diagnostics.push(diagnostic('SENSOR_FRAME_MISSING', `Sensor "${sensor.id}" references unknown frame "${sensor.frameId}".`, '/scene/sensors'))
    if (sensor.modality === 'camera' && !sensor.image) diagnostics.push(diagnostic('CAMERA_IMAGE_MODEL_MISSING', `Camera "${sensor.id}" requires image geometry.`, '/scene/sensors'))
    if (sensor.modality !== 'camera' && sensor.image) diagnostics.push(diagnostic('NON_CAMERA_IMAGE_MODEL', `Only camera sensors may declare image geometry.`, '/scene/sensors'))
  }
  const attributes = new Set(recipe.scene.pointAttributes.map((attribute) => attribute.id))
  for (const coordinate of ['x', 'y', 'z']) {
    if (!attributes.has(coordinate)) diagnostics.push(diagnostic('POINT_COORDINATE_MISSING', `Point attribute "${coordinate}" is required.`, '/scene/pointAttributes'))
  }
  if (recipe.scene.pointLayout.interleavedAttributes.slice(0, 3).join(',') !== 'x,y,z') {
    diagnostics.push(diagnostic('POINT_LAYOUT_XYZ_ORDER', 'The interleaved point layout must begin with x, y, z.', '/scene/pointLayout/interleavedAttributes'))
  }
  for (const attribute of recipe.scene.pointLayout.interleavedAttributes) {
    if (!attributes.has(attribute)) diagnostics.push(diagnostic('POINT_LAYOUT_ATTRIBUTE_MISSING', `Interleaved attribute "${attribute}" is not declared in pointAttributes.`, '/scene/pointLayout/interleavedAttributes'))
  }
  const taxonomyRoles = new Set<string>()
  for (const taxonomy of recipe.scene.taxonomies) {
    if (taxonomyRoles.has(taxonomy.role)) diagnostics.push(diagnostic('DUPLICATE_TAXONOMY_ROLE', `Taxonomy role "${taxonomy.role}" may be declared only once.`, '/scene/taxonomies'))
    taxonomyRoles.add(taxonomy.role)
  }
}

export function compileRecipeV1(input: string | unknown, registry: OperatorRegistry): CompiledRecipeV1 {
  const recipe = assertValidRecipeV1(input)
  const diagnostics: AdapterDiagnostic[] = []
  if (compareVersions(recipe.engine.minimumVersion, RECIPE_ENGINE_VERSION) > 0) {
    diagnostics.push(diagnostic('ENGINE_VERSION_UNSUPPORTED', `Recipe requires EgoLens ${recipe.engine.minimumVersion}, but this engine is ${RECIPE_ENGINE_VERSION}.`, '/engine/minimumVersion'))
  }

  const resolvedOperators = new Map<string, RecipeOperatorDescriptor>()
  for (const [name, dependency] of Object.entries(recipe.engine.requiredOperators)) {
    const operator = registry.resolve(name, dependency)
    if (!operator) diagnostics.push(diagnostic('OPERATOR_MISSING', `Required operator ${name}@${dependency.major} (${dependency.provider}) is unavailable or incompatible.`, `/engine/requiredOperators/${name}`))
    else resolvedOperators.set(`${name}@${dependency.major}`, operator)
  }

  const usedOperators = new Set<string>()
  for (const [sourceId, source] of Object.entries(recipe.sources)) {
    const dependency = recipe.engine.requiredOperators[source.reader]
    if (!dependency) diagnostics.push(diagnostic('OPERATOR_REQUIREMENT_MISSING', `Source reader "${source.reader}" is not declared in requiredOperators.`, `/sources/${sourceId}/reader`))
    else {
      usedOperators.add(source.reader)
      for (const error of registry.validateParams(source.reader, dependency, source.params ?? {})) {
        diagnostics.push(diagnostic('OPERATOR_PARAMS_INVALID', error.message ?? `Parameters for source reader "${source.reader}" are invalid.`, `/sources/${sourceId}/params${error.instancePath}`))
      }
    }
  }
  for (const [pipelineId, pipeline] of Object.entries(recipe.pipelines)) {
    for (const node of pipeline.nodes) {
      const dependency = recipe.engine.requiredOperators[node.op]
      if (!dependency || dependency.major !== node.version) {
        diagnostics.push(diagnostic('OPERATOR_REQUIREMENT_MISSING', `Node operator "${node.op}@${node.version}" is not declared with the same major version.`, `/pipelines/${pipelineId}/nodes/${node.id}/op`))
      } else {
        usedOperators.add(node.op)
        for (const error of registry.validateParams(node.op, dependency, node.params ?? {})) {
          diagnostics.push(diagnostic('OPERATOR_PARAMS_INVALID', error.message ?? `Parameters for operator "${node.op}" are invalid.`, `/pipelines/${pipelineId}/nodes/${node.id}/params${error.instancePath}`))
        }
      }
    }
  }
  for (const name of Object.keys(recipe.engine.requiredOperators)) {
    if (!usedOperators.has(name)) diagnostics.push(diagnostic('OPERATOR_REQUIREMENT_UNUSED', `Operator requirement "${name}" is not used by a source or pipeline.`, `/engine/requiredOperators/${name}`))
  }

  validateScene(recipe, diagnostics)
  const rootPaths = new Set<string>()
  for (const entry of recipe.match.inventory.rootEntries) {
    if (rootPaths.has(entry.path)) diagnostics.push(diagnostic('DUPLICATE_INVENTORY_ROOT', `Inventory root "${entry.path}" is duplicated.`, '/match/inventory/rootEntries'))
    rootPaths.add(entry.path)
  }
  if (!recipe.match.inventory.rootEntries.some((entry) => entry.required)) {
    diagnostics.push(diagnostic('INVENTORY_REQUIRED_ROOT_MISSING', 'At least one inventory root must be required for bounded pre-read detection.', '/match/inventory/rootEntries'))
  }
  const versionRootCandidates = new Set(recipe.match.versionRoot?.candidates ?? [])
  for (const candidate of versionRootCandidates) {
    if (!rootPaths.has(candidate)) diagnostics.push(diagnostic('VERSION_ROOT_UNDECLARED', `Version-root candidate "${candidate}" is not declared in inventory.rootEntries.`, '/match/versionRoot/candidates'))
  }
  const boundFields = new Map<string, string>()
  for (const [sourceId, source] of Object.entries(recipe.sources)) {
    const selector = source.files.exact ?? source.files.glob ?? ''
    const selectorRoot = selector.split('/')[0]
    if (selectorRoot === '{versionRoot}') {
      if (versionRootCandidates.size === 0) diagnostics.push(diagnostic('VERSION_ROOT_SELECTOR_UNDECLARED', `Source "${sourceId}" uses {versionRoot} without match.versionRoot.`, `/sources/${sourceId}/files`))
    } else if (!rootPaths.has(selectorRoot)) diagnostics.push(diagnostic('SOURCE_ROOT_UNDECLARED', `Source "${sourceId}" selects undeclared inventory root "${selectorRoot}".`, `/sources/${sourceId}/files`))
    for (const [role, field] of Object.entries(source.bindings ?? {})) {
      const previous = boundFields.get(role)
      if (previous && previous !== field) diagnostics.push(diagnostic('SOURCE_BINDING_AMBIGUOUS', `Source role "${role}" is bound to both "${previous}" and "${field}".`, `/sources/${sourceId}/bindings/${role}`))
      boundFields.set(role, field)
      if (source.columns && !source.columns.includes(field)) diagnostics.push(diagnostic('SOURCE_BINDING_COLUMN_MISSING', `Bound field "${field}" is not selected by source "${sourceId}".`, `/sources/${sourceId}/bindings/${role}`))
    }
  }
  for (const rules of [recipe.match.all, recipe.match.any, recipe.match.none]) {
    for (const rule of rules ?? []) {
      if (('source' in rule) && !recipe.sources[rule.source]) diagnostics.push(diagnostic('MATCH_SOURCE_MISSING', `Matcher references unknown source "${rule.source}".`, '/match'))
      if ('glob' in rule) {
        const matcherRoot = rule.glob.split('/')[0]
        if (!rootPaths.has(matcherRoot)) diagnostics.push(diagnostic('MATCH_ROOT_UNDECLARED', `Matcher selects undeclared inventory root "${matcherRoot}".`, '/match'))
      }
    }
  }

  const externalIds = new Set([...Object.keys(recipe.sources), ...Object.keys(recipe.pipelines)])
  const pipelines = new Map<string, CompiledPipelineV1>()
  for (const [pipelineId, pipeline] of Object.entries(recipe.pipelines)) {
    const ordered = topologicalNodes(pipelineId, pipeline.nodes, pipeline.result, externalIds, diagnostics)
    pipelines.set(pipelineId, { id: pipelineId, nodes: ordered, result: pipeline.result })
  }

  const capabilities = new Set<NormalizedCapabilityV1>()
  for (const [output, binding] of Object.entries(recipe.outputs)) {
    const pipelineId = binding.split('.')[0]
    if (!recipe.pipelines[pipelineId]) diagnostics.push(diagnostic('OUTPUT_BINDING_MISSING', `Output "${output}" references unknown pipeline "${pipelineId}".`, `/outputs/${output}`, binding))
    capabilities.add(output as NormalizedCapabilityV1)
  }
  for (const assertion of recipe.validation.assertions) {
    if (!recipe.outputs[assertion.output]) diagnostics.push(diagnostic('ASSERTION_OUTPUT_MISSING', `Assertion targets unbound output "${assertion.output}".`, '/validation/assertions'))
  }
  if (diagnostics.length > 0) throw new AdapterCompileError(diagnostics)

  const normalizedManifest: NormalizedManifestV1 = {
    id: recipe.scene.formatId,
    name: recipe.identity.name,
    nominalFrameRate: recipe.scene.timeline.nominalFrameRate,
    sensors: recipe.scene.sensors,
    taxonomies: recipe.scene.taxonomies,
    pointAttributes: recipe.scene.pointAttributes,
    pointLayout: recipe.scene.pointLayout,
    capabilities,
  }
  return {
    recipe,
    normalizedManifest,
    compatibilityManifest: normalizedManifestToDatasetManifest(normalizedManifest, recipeManifestProjection(recipe)),
    pipelines,
    operators: resolvedOperators,
    capabilities,
  }
}
