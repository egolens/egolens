import { describe, expect, it, vi } from 'vitest'
import { waymoCompiledRecipe } from '../../adapters/recipes/bundled'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import { RecipeExecutorV1, recipeOperatorGraphV1, type RecipeProviderResultV1 } from '../runtime/RecipeExecutor'
import { MappedByteSourceV1 } from '../source/ByteSource'

const emptyResult = {} as RecipeProviderResultV1

describe('RecipeExecutorV1 operator-profile dispatch', () => {
  it('derives versioned dispatch IDs from the compiled operator graph', () => {
    const graph = recipeOperatorGraphV1(waymoCompiledRecipe)
    expect(graph.readers).toContain('parquet.columns@1')
    expect(graph.operators).toContain('geometry.range_image_to_cartesian@1')
  })

  it('does not use recipe identity, format ID, source paths, or transport for selection', async () => {
    const execute = vi.fn(() => emptyResult)
    const executor = new RecipeExecutorV1([{
      id: 'test/parquet-range-image@1',
      readers: [...recipeOperatorGraphV1(waymoCompiledRecipe).readers],
      operators: [...recipeOperatorGraphV1(waymoCompiledRecipe).operators],
      execute,
    }])
    const learned = structuredClone(waymoCompiledRecipe.recipe)
    learned.identity.name = 'unrelated learned identity'
    learned.scene.formatId = 'unrelated-format-id'
    const compiled = compileRecipeV1(learned, bundledPhase2OperatorRegistry)
    const source = new MappedByteSourceV1([
      ['arbitrary/logical/name.bin', new File(['bytes'], 'name.bin')],
    ])

    await expect(executor.execute({ compiledRecipe: compiled, source }))
      .resolves.toMatchObject({ executionProfile: 'test/parquet-range-image@1' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('fails closed for missing and ambiguous runtime profiles', async () => {
    const source = new MappedByteSourceV1([])
    const missing = new RecipeExecutorV1([{
      id: 'test/json@1',
      readers: ['json.records@1'],
      operators: [],
      execute: () => emptyResult,
    }])
    await expect(missing.execute({ compiledRecipe: waymoCompiledRecipe, source }))
      .rejects.toThrow(/RECIPE_RUNTIME_MISSING/u)

    const marker = {
      readers: [...recipeOperatorGraphV1(waymoCompiledRecipe).readers],
      operators: [...recipeOperatorGraphV1(waymoCompiledRecipe).operators],
      execute: () => emptyResult,
    }
    const ambiguous = new RecipeExecutorV1([
      { id: 'test/a@1', ...marker },
      { id: 'test/b@1', ...marker },
    ])
    await expect(ambiguous.execute({ compiledRecipe: waymoCompiledRecipe, source }))
      .rejects.toThrow(/RECIPE_RUNTIME_AMBIGUOUS: test\/a@1, test\/b@1/u)
  })
})
