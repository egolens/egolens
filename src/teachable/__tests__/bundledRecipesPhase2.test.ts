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
import { compileRecipeV1 } from '../recipe/compiler'
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
        expect(roots).toContain(selector?.split('/')[0])
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
