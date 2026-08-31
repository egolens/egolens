import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DatasetManifest } from '../../../types/dataset'
import { canonicalizeJson } from '../../../teachable/recipe/canonicalize'
import type { JsonValue } from '../../../teachable/recipe/types'
import { getAdapterById } from '../../registry'
import {
  argoverse2RecipeAdapter,
  bundledRecipeAdapters,
  nuScenesRecipeAdapter,
  waymoRecipeAdapter,
} from '..'

function behaviorSnapshot(manifest: DatasetManifest): JsonValue {
  return JSON.parse(JSON.stringify({
    ...manifest,
    colormapModes: manifest.colormapModes ?? ['intensity', 'range', 'elongation', 'segment', 'panoptic', 'camera'],
    intensityRange: manifest.intensityRange ?? [0, 1],
    overlayModes: manifest.overlayModes ?? ['bbox2d', 'lidarProjection'],
    annotationModes: manifest.annotationModes ?? ['bbox3d'],
  })) as JsonValue
}

function snapshotHash(manifest: DatasetManifest): string {
  return createHash('sha256').update(canonicalizeJson(behaviorSnapshot(manifest))).digest('hex')
}

describe('Spec 007 bundled recipes', () => {
  it('ships complete schema-valid recipe shells through the shared compiler', () => {
    for (const adapter of bundledRecipeAdapters) {
      expect(adapter.kind).toBe('recipe')
      expect(adapter.recipe.kind).toBe('egolens-adapter')
      expect(adapter.recipe.schemaVersion).toBe(1)
      expect(Object.keys(adapter.recipe.engine.requiredOperators).length).toBeGreaterThan(0)
      expect(adapter.recipe.match.inventory.rootEntries.length).toBeGreaterThan(0)
      expect(Object.keys(adapter.recipe.sources).length).toBeGreaterThan(0)
      expect(Object.keys(adapter.recipe.pipelines).length).toBeGreaterThan(0)
      expect(adapter.recipe.outputs.timeline).toBeTruthy()
      expect(adapter.recipe.validation.sampleFrames).toEqual(['first', 'middle', 'last'])
      expect(adapter.compiledRecipe.operators.size).toBe(Object.keys(adapter.recipe.engine.requiredOperators).length)
    }
  })

  it('uses only core, dataset-neutral operator descriptors', () => {
    for (const adapter of bundledRecipeAdapters) {
      for (const [name, dependency] of Object.entries(adapter.recipe.engine.requiredOperators)) {
        expect(dependency.provider).toBe('core')
        expect(name).not.toMatch(/waymo|nuscenes|argoverse|av2/iu)
      }
    }
  })

  it('keeps raw inventory and column bindings at the compatibility edge', () => {
    for (const adapter of bundledRecipeAdapters) {
      const { recipe, compiledRecipe } = adapter
      expect(compiledRecipe.compatibilityManifest.knownComponents).toEqual(
        recipe.match.inventory.rootEntries.map((entry) => entry.path),
      )
      expect(compiledRecipe.compatibilityManifest.requiredComponents).toEqual(
        recipe.match.inventory.rootEntries.filter((entry) => entry.required).map((entry) => entry.path),
      )
      expect(compiledRecipe.normalizedManifest).not.toHaveProperty('knownComponents')
      expect(compiledRecipe.normalizedManifest).not.toHaveProperty('requiredComponents')
      expect(compiledRecipe.normalizedManifest).not.toHaveProperty('columnMap')
    }
  })

  it('locks behavior-normalized compatibility snapshots from the TypeScript manifests', () => {
    expect(snapshotHash(waymoRecipeAdapter.manifest)).toBe('fb471d8d361b115f7a839b57c5f9a5df086003d90f3f4ea74619c6c988b00ff5')
    expect(snapshotHash(nuScenesRecipeAdapter.manifest)).toBe('5ce27f420ed2a9468aa3a991493e079a3fd2d1784a8c73456594f5af14f639b8')
    expect(snapshotHash(argoverse2RecipeAdapter.manifest)).toBe('f6dce252fe6b9a37752a1f9887c5a97d5fb1e1c0dce56a4adda7849e1586d564')
  })

  it('resolves every bundled dataset through the recipe strategy', () => {
    expect(getAdapterById('waymo')).toBe(waymoRecipeAdapter)
    expect(getAdapterById('nuscenes')).toBe(nuScenesRecipeAdapter)
    expect(getAdapterById('argoverse2')).toBe(argoverse2RecipeAdapter)
  })
})
