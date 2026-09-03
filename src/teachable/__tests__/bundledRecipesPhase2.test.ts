import { describe, expect, it } from 'vitest'
import {
  argoverse2CompiledRecipe,
  bundledCompiledRecipes,
  nuScenesCompiledRecipe,
  waymoCompiledRecipe,
} from '../../adapters/recipes/bundled'
import { argoverse2Manifest } from '../../adapters/argoverse2/manifest'
import { nuScenesManifest } from '../../adapters/nuscenes/manifest'
import { waymoManifest } from '../../adapters/waymo/manifest'
import { getAdapterById } from '../../adapters/registry'
import { compileRecipeV1 } from '../recipe/compiler'
import { AdapterCompileError } from '../recipe/diagnostics'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { validateRecipeV1 } from '../schema/validateSchema'

describe('bundled Phase 2 recipes', () => {
  it('ships three complete, schema-valid v1 artifacts', () => {
    expect(bundledCompiledRecipes).toHaveLength(3)
    for (const compiled of bundledCompiledRecipes) {
      expect(validateRecipeV1(compiled.recipe)).toEqual({ ok: true, recipe: compiled.recipe, diagnostics: [] })
      expect(compiled.recipe).toMatchObject({
        kind: 'egolens-adapter',
        schemaVersion: 1,
        engine: { minimumVersion: '1.0.0' },
        match: { inventory: { rootEntries: expect.any(Array) } },
        sources: expect.any(Object),
        scene: { formatId: compiled.normalizedManifest.id },
        pipelines: expect.any(Object),
        outputs: { timeline: expect.any(String) },
        validation: {
          sampleFrames: ['first', 'middle', 'last'],
          assertions: expect.any(Array),
          humanReview: expect.any(Array),
        },
      })
    }
  })

  it('uses only generic registered operators and inventory-rooted selectors', () => {
    for (const { recipe } of bundledCompiledRecipes) {
      const roots = new Set(recipe.match.inventory.rootEntries.map((entry) => entry.path))
      expect(recipe.match.inventory.rootEntries.some((entry) => entry.required)).toBe(true)
      for (const [name] of Object.entries(recipe.engine.requiredOperators)) {
        expect(name).not.toMatch(/^(?:waymo|nuscenes|argoverse)/u)
      }
      for (const source of Object.values(recipe.sources)) {
        const selector = source.files.exact ?? source.files.glob
        expect(selector).toBeDefined()
        const selectorRoot = selector?.split('/')[0]
        if (selectorRoot === '{versionRoot}') {
          expect(recipe.match.versionRoot?.candidates.length).toBeGreaterThan(0)
        } else {
          expect(roots).toContain(selectorRoot)
        }
      }
    }
  })

  it('derives the current data-driven capabilities from output bindings', () => {
    expect(waymoCompiledRecipe.capabilities).toEqual(new Set([
      'timeline', 'egoPoses', 'pointClouds', 'cameraImages', 'boxes3d', 'boxes2d',
      'boxAssociations', 'trajectories', 'lidarSegmentation', 'cameraSegmentation',
      'keypoints3d', 'keypoints2d', 'segmentMetadata',
    ]))
    expect(nuScenesCompiledRecipe.capabilities).toEqual(new Set([
      'timeline', 'egoPoses', 'pointClouds', 'radarPointClouds', 'cameraImages',
      'boxes3d', 'boxes2d', 'trajectories', 'lidarSegmentation', 'segmentMetadata',
    ]))
    expect(argoverse2CompiledRecipe.capabilities).toEqual(new Set([
      'timeline', 'egoPoses', 'pointClouds', 'cameraImages', 'boxes3d', 'boxes2d',
      'trajectories', 'segmentMetadata',
    ]))
  })

  it('uses closed contracts for every operator on all executable bundled graphs', () => {
    const isClosed = (contract: Readonly<Record<string, unknown>>): boolean => {
      if (contract.additionalProperties === false) return true
      const alternatives = contract.oneOf
      return Array.isArray(alternatives)
        && alternatives.every((alternative) => isClosed(alternative as Readonly<Record<string, unknown>>))
    }
    for (const compiled of bundledCompiledRecipes) {
      for (const [name, dependency] of Object.entries(compiled.recipe.engine.requiredOperators)) {
        const descriptor = bundledPhase2OperatorRegistry.resolve(name, dependency)
        expect(descriptor, name).not.toBeNull()
        expect(isClosed(descriptor!.paramsContract), `${name} params`).toBe(true)
        expect(isClosed(descriptor!.inputContract), `${name} input`).toBe(true)
        expect(isClosed(descriptor!.outputContract), `${name} output`).toBe(true)
      }
    }
  })

  it('resolves all three bundled datasets through recipe-backed registry strategies', () => {
    for (const id of ['waymo', 'nuscenes', 'argoverse2']) {
      expect(getAdapterById(id)?.kind).toBe('recipe')
      expect(getAdapterById(id)?.prepare().kind).toBe('recipe')
    }
  })

  it('rejects an output bound to a node output instead of the pipeline result', () => {
    const recipe = structuredClone(nuScenesCompiledRecipe.recipe)
    ;(recipe.outputs as Record<string, string>).timeline = 'timeline.sort.frames'
    expect(() => compileRecipeV1(recipe, bundledPhase2OperatorRegistry)).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(recipe, bundledPhase2OperatorRegistry)
    } catch (error) {
      expect((error as AdapterCompileError).diagnostics).toContainEqual(expect.objectContaining({
        code: 'OUTPUT_BINDING_INVALID',
        jsonPointer: '/outputs/timeline',
      }))
    }
  })

  it('rejects the relational boxes3d form without an ego-pose timeline at compile time', () => {
    const recipe = structuredClone(nuScenesCompiledRecipe.recipe)
    const node = recipe.pipelines.boxes3d.nodes.find((entry) => entry.op === 'geometry.normalize_boxes3d') as unknown as { inputs: Record<string, string> }
    expect(node.inputs.poses).toBe('egoPoses.result')
    delete node.inputs.poses
    expect(() => compileRecipeV1(recipe, bundledPhase2OperatorRegistry)).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(recipe, bundledPhase2OperatorRegistry)
    } catch (error) {
      expect((error as AdapterCompileError).diagnostics).toContainEqual(expect.objectContaining({
        code: 'OPERATOR_INPUTS_INVALID',
      }))
    }
  })

  it('rejects graph input drift and Feather column-contract drift before binding', () => {
    const invalidInputs = structuredClone(argoverse2CompiledRecipe.recipe)
    const joinNode = invalidInputs.pipelines.egoPoses.nodes[0] as unknown as { inputs: Record<string, string> }
    joinNode.inputs = { timeline: 'timeline.result', typo: 'poses.rows' }
    expect(() => compileRecipeV1(invalidInputs, bundledPhase2OperatorRegistry)).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(invalidInputs, bundledPhase2OperatorRegistry)
    } catch (error) {
      expect((error as AdapterCompileError).diagnostics).toContainEqual(expect.objectContaining({
        code: 'OPERATOR_INPUTS_INVALID',
      }))
    }

    const invalidColumns = structuredClone(argoverse2CompiledRecipe.recipe)
    const lidarSource = invalidColumns.sources.lidarFrames as unknown as { columns: string[] }
    lidarSource.columns = ['x', 'y', 'z']
    expect(() => compileRecipeV1(invalidColumns, bundledPhase2OperatorRegistry)).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(invalidColumns, bundledPhase2OperatorRegistry)
    } catch (error) {
      expect((error as AdapterCompileError).diagnostics).toContainEqual(expect.objectContaining({
        code: 'SOURCE_COLUMNS_CONTRACT_MISMATCH',
      }))
    }
  })

  it('keeps display names out of stable format identity', () => {
    for (const compiled of bundledCompiledRecipes) {
      const renamed = structuredClone(compiled.recipe)
      renamed.identity = { ...renamed.identity, name: `${renamed.identity.name} renamed` }
      const recompiled = compileRecipeV1(renamed, bundledPhase2OperatorRegistry)
      expect(recompiled.normalizedManifest.id).toBe(compiled.normalizedManifest.id)
    }
  })

  it('projects behavior-normalized compatibility manifests as snapshots', () => {
    expect({
      waymo: waymoManifest,
      nuscenes: nuScenesManifest,
      argoverse2: argoverse2Manifest,
    }).toMatchSnapshot()
  })
})

describe('artifact size limit at apply time', () => {
  it('rejects an in-memory recipe whose pretty-printed artifact would exceed the export limit', () => {
    const filler = Array.from({ length: 600 }, (_, index) => ({ field: `f${index}`, from: 'x', pattern: '^(.*)$', replacement: 'y'.repeat(400) }))
    const result = validateRecipeV1({ kind: 'egolens-adapter', schemaVersion: 1, pipelines: { p: { nodes: [{ params: { derive: filler } }] } } })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('RESOURCE_LIMIT_ARTIFACT_SIZE')
  })
})
