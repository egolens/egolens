import { describe, expect, it } from 'vitest'
import minimalJson from '../__fixtures__/importable.egolens-adapter.json'
import { validateRecipeImportV1, validateRecipeSourceV1 } from '../authoring/recipeImport'
import { withComputedArtifactHashesV1 } from '../authoring/hashes'
import { readRecipeArtifactFileV1 } from '../authoring/portability'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { fetchRemoteRecipeForImportV1, VerifiedRecipeCacheV1 } from '../share/RecipeTransport'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import { bindRecipeSceneV1 } from '../runtime/bindRecipeScene'

const source = () => new SourceInventoryV1([
  ['frames.json', new File(['[{"timestamp_us":1000000},{"timestamp_us":1100000}]'], 'frames.json')],
])

describe('agent-free recipe consumption', () => {
  it.each(['file', 'url', 'pinned-url'] as const)('opens an exported %s recipe against local data without rewriting authoring history', async (transport) => {
    const inventory = source()
    const original = assertValidRecipeV1({
      ...structuredClone(minimalJson),
      provenance: { ...minimalJson.provenance, parentRecipeHash: `sha256:${'a'.repeat(64)}` },
    })
    const exported = await withComputedArtifactHashesV1(original, inventory)
    const text = JSON.stringify(exported)
    const received = transport === 'file'
      ? await readRecipeArtifactFileV1(new File([text], 'adapter.egolens-adapter.json'))
      : (await fetchRemoteRecipeForImportV1('https://recipes.example/adapter.json', {
          expectedRecipeHash: transport === 'pinned-url' ? exported.hashes!.recipeHash! : undefined,
          fetch: async () => new Response(text), cache: new VerifiedRecipeCacheV1(),
        })).recipe
    const recipe = await validateRecipeImportV1(received)
    await validateRecipeSourceV1(recipe, inventory)
    const binding = await bindRecipeSceneV1({
      compiledRecipe: compileRecipeV1(recipe, bundledPhase2OperatorRegistry),
      source: inventory.resolveAuthorizedSource(), inventory,
    })
    try {
      expect(binding.scene.index.timestampsMicros).toEqual([1000000n, 1100000n])
      expect((await binding.scene.loadFrame(1, { capabilities: new Set(['timeline']) })).timestampMicros).toBe(1100000n)
      expect(recipe.provenance).toEqual(exported.provenance)
      expect(recipe.hashes).toEqual(exported.hashes)
      expect(inventory.revoked).toBe(false)
    } finally { binding.scene.dispose(); inventory.revoke() }
  })

  it('rejects altered artifacts before asking for data, and missing engine operators', async () => {
    const exported = await withComputedArtifactHashesV1(assertValidRecipeV1(minimalJson), source())
    await expect(validateRecipeImportV1({ ...exported, identity: { name: 'Changed after export' } })).rejects.toThrow(/integrity check/)
    await expect(validateRecipeImportV1({
      ...minimalJson,
      engine: { ...minimalJson.engine, requiredOperators: { ...minimalJson.engine.requiredOperators, 'unknown.reader': { major: 1, provider: 'core' } } },
    })).rejects.toThrow()
  })

  it('retains the selected inventory after incompatibility so the visitor can choose another adapter', async () => {
    const exported = await withComputedArtifactHashesV1(assertValidRecipeV1(minimalJson), source())
    const wrongFolder = new SourceInventoryV1([['other.json', new File(['[]'], 'other.json')]])
    await expect(validateRecipeSourceV1(exported, wrongFolder)).rejects.toThrow(/folder layout differs/)
    expect(wrongFolder.revoked).toBe(false)
    const incomplete = new SourceInventoryV1([['frames.json', new File(['[]'], 'frames.json')]], { truncated: true })
    await expect(validateRecipeSourceV1(exported, incomplete)).rejects.toThrow(/read completely/)
  })
})
