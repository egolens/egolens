/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdapterEntryDialog from '../../components/TeachableLens/AdapterEntryDialog'
import type { AdapterEntryRequest } from '../../components/TeachableLens/AdapterEntryDialog'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { generateSourceCatalogV1 } from '../source/SourceCatalog'
import minimalJson from '../__fixtures__/importable.egolens-adapter.json'
import { sharedVerifiedRecipeCacheV1 } from '../share/RecipeTransport'

const session = vi.hoisted(() => ({ findSavedRecipes: vi.fn(async () => []), start: vi.fn(), finalize: vi.fn() }))
vi.mock('../authoring/browserSession', () => ({ teachableAuthoringSession: session }))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window.navigator, 'modelContext')
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  sharedVerifiedRecipeCacheV1.clear()
})

const button = (text: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === text)!
const click = async (text: string) => { await act(async () => button(text).click()) }
const settle = async (assert: () => void) => { await vi.waitFor(async () => { await act(async () => {}); assert() }) }
const attach = async (label: string, files: File[]) => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
const inventory = () => new SourceInventoryV1([['frames.json', new File(['[{"timestamp_us":1}]'], 'frames.json')]])
const fill = async (type: 'url' | 'text', value: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[type="${type}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount(request: AdapterEntryRequest, render = vi.fn(async () => {}), inline = false, choose = vi.fn()) {
  const close = vi.fn()
  const teach = vi.fn()
  await act(async () => root.render(<AdapterEntryDialog onChoose={choose} inline={inline} request={request} onClose={close} onTeach={teach} onRender={render} />))
  return { render, close, teach, choose }
}

describe('adapter recipient dialog', () => {
  it.each([false, true])('renders from a URL without an agent (inline=%s)', async (inline) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(minimalJson)))
    vi.stubGlobal('fetch', fetcher)
    const selected = inventory()
    const callbacks = await mount({ mode: 'use', inventory: selected, recipeSource: 'url' }, vi.fn(async () => {}), inline)
    expect(container.querySelector('dialog') !== null).toBe(!inline)
    if (!inline) expect(container.querySelector('details')?.open).toBe(false)
    if (!inline) expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.required).toBe(false)
    expect(button('Import URL').disabled).toBe(true)
    await fill('url', 'https://recipes.example/current.json')
    expect(button('Import URL').disabled).toBe(false)
    await click('Import URL')
    await settle(() => expect(button(inline ? 'Load' : 'Render this dataset').disabled).toBe(false))
    await click(inline ? 'Load' : 'Render this dataset')
    await settle(() => expect(callbacks.close).toHaveBeenCalledOnce())
    expect(callbacks.render).toHaveBeenCalledWith(selected, expect.objectContaining({ identity: minimalJson.identity }))
    expect(callbacks.teach).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects an optional version mismatch and can recover by clearing the pin without reselecting data', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(minimalJson)))
    vi.stubGlobal('fetch', fetcher)
    const selected = inventory()
    const callbacks = await mount({ mode: 'use', inventory: selected })
    await click('Recipe URL')
    await fill('url', 'https://recipes.example/current.json')
    await click('Import URL')
    await settle(() => expect(button('Render this dataset').disabled).toBe(false))
    await act(async () => container.querySelector('summary')!.click())
    await fill('text', `sha256:${'0'.repeat(64)}`)
    expect(button('Render this dataset').disabled).toBe(true)
    expect(container.querySelector('summary')?.textContent).toContain('version check enabled')
    await click('Import URL')
    await settle(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('REMOTE_RECIPE_HASH_MISMATCH'))
    expect(button('Render this dataset').disabled).toBe(true)
    expect(selected.revoked).toBe(false)
    expect(callbacks.render).not.toHaveBeenCalled()
    await fill('text', '   ')
    await click('Import URL')
    await settle(() => expect(button('Render this dataset').disabled).toBe(false))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(3)
    await fill('url', 'https://recipes.example/other.json')
    expect(button('Render this dataset').disabled).toBe(true)
    expect(selected.revoked).toBe(false)
  })

  it('keeps a dropped folder through route selection and renders a file recipe without an agent', async () => {
    const selected = inventory()
    const callbacks = await mount({ mode: 'choose', inventory: selected })
    await click('Use an adapter recipe')
    await attach('Adapter recipe file', [new File([JSON.stringify(minimalJson)], 'recipe.json')])
    await settle(() => expect(button('Render this dataset').disabled).toBe(false))
    await click('Render this dataset')
    await settle(() => expect(callbacks.close).toHaveBeenCalledOnce())
    expect(callbacks.render).toHaveBeenCalledWith(selected, expect.objectContaining({ provenance: minimalJson.provenance }))
    expect(callbacks.teach).not.toHaveBeenCalled()
    expect(session.start).not.toHaveBeenCalled()
    expect(session.finalize).not.toHaveBeenCalled()
    expect(selected.revoked).toBe(false)
  })

  it('disables stale recipes after a failed replacement and preserves the folder after rendering fails', async () => {
    const selected = inventory()
    const callbacks = await mount({ mode: 'use', inventory: selected }, vi.fn(async () => { throw new Error('Missing camera file') }))
    await attach('Adapter recipe file', [new File([JSON.stringify(minimalJson)], 'recipe.json')])
    await settle(() => expect(button('Render this dataset').disabled).toBe(false))
    await attach('Adapter recipe file', [new File(['{}'], 'invalid.json')])
    await settle(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(button('Render this dataset').disabled).toBe(true)
    await attach('Adapter recipe file', [new File([JSON.stringify(minimalJson)], 'recipe.json')])
    await settle(() => expect(button('Render this dataset').disabled).toBe(false))
    await click('Render this dataset')
    await settle(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('Missing camera file'))
    expect(selected.revoked).toBe(false)
    expect(callbacks.close).not.toHaveBeenCalled()
    expect(button('Change folder').disabled).toBe(false)
  })

  it('explains agent setup while leaving the recipe path available in an ordinary browser', async () => {
    const selected = inventory()
    const callbacks = await mount({ mode: 'choose', inventory: selected })
    expect(container.textContent).toContain('Use the in-app browser in the Codex desktop app.')
    expect(button('Create an adapter with AI').disabled).toBe(true)
    expect(button('Confirm and start authoring')).toBeUndefined()
    await click('Use an adapter recipe')
    expect(button('Import JSON')).toBeDefined()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close adapter setup"]')!.click())
    expect(callbacks.close).toHaveBeenCalledOnce()
    expect(selected.revoked).toBe(true)
  })

  it.each(['use', 'teach'] as const)('allows cancellation during pending %s folder matching and ignores its late result', async (purpose) => {
    Object.defineProperty(window.navigator, 'modelContext', { configurable: true, value: { codexTest: true } })
    let finish: (matches: never[]) => void = () => {}
    session.findSavedRecipes.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const callbacks = await mount({ mode: purpose === 'teach' ? 'choose' : 'use' })
    if (purpose === 'teach') await click('Create an adapter with AI')
    await attach('Dataset folder', [new File(['[]'], 'frames.json')])
    expect(container.textContent).toContain('Checking folder…')
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close adapter setup"]')!
    expect(close.disabled).toBe(false)
    await act(async () => close.click())
    await act(async () => finish([]))
    expect(callbacks.close).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('Dataset folder selected')
    expect(callbacks.render).not.toHaveBeenCalled()
    expect(callbacks.teach).not.toHaveBeenCalled()
  })

  it('opens the folder picker directly for AI creation and hands off the selected files', async () => {
    Object.defineProperty(window.navigator, 'modelContext', { configurable: true, value: { codexTest: true } })
    const callbacks = await mount({ mode: 'choose' })
    const picker = vi.spyOn(container.querySelector<HTMLInputElement>('[aria-label="Dataset folder"]')!, 'click')
    await click('Create an adapter with AI')
    expect(picker).toHaveBeenCalledOnce()
    expect(callbacks.teach).not.toHaveBeenCalled()
    expect(container.querySelector('h2')?.textContent).toBe('Open your dataset with an adapter')
    await attach('Dataset folder', [new File(['x'], '000001.bin')])
    await settle(() => expect(callbacks.teach).toHaveBeenCalledOnce())
    const selected = callbacks.teach.mock.calls[0][0].inventory as SourceInventoryV1
    expect(selected.snapshot().entries).toHaveLength(1)
    expect(selected.revoked).toBe(false)
    expect(session.start).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="sensor-configuration"]')).toBeNull()
  })

  it('hands an existing folder directly to authoring without another picker or confirmation', async () => {
    Object.defineProperty(window.navigator, 'modelContext', { configurable: true, value: { codexTest: true } })
    const selected = new SourceInventoryV1([['lidar/front/000001.bin', new File(['x'], '000001.bin')]])
    const callbacks = await mount({ mode: 'choose', inventory: selected })
    const picker = vi.spyOn(container.querySelector<HTMLInputElement>('[aria-label="Dataset folder"]')!, 'click')
    expect(callbacks.teach).not.toHaveBeenCalled()
    await click('Create an adapter with AI')
    expect(callbacks.teach).toHaveBeenCalledWith({ inventory: selected, savedRecipes: [] })
    expect(picker).not.toHaveBeenCalled()
    expect(session.start).not.toHaveBeenCalled()
    expect(selected.revoked).toBe(false)
  })

  it('keeps the choice dialog after canceling the AI picker and allows ordinary recipe reuse', async () => {
    Object.defineProperty(window.navigator, 'modelContext', { configurable: true, value: { codexTest: true } })
    const callbacks = await mount({ mode: 'choose' })
    await click('Create an adapter with AI')
    await act(async () => container.querySelector('[aria-label="Dataset folder"]')!.dispatchEvent(new Event('cancel', { bubbles: true })))
    expect(callbacks.teach).not.toHaveBeenCalled()
    expect(callbacks.close).not.toHaveBeenCalled()
    await click('Use an adapter recipe')
    await click('Select Folder')
    await attach('Dataset folder', [new File(['[]'], 'frames.json')])
    await settle(() => expect(container.textContent).toContain('Dataset folder selected'))
    expect(callbacks.teach).not.toHaveBeenCalled()
    await attach('Adapter recipe file', [new File([JSON.stringify(minimalJson)], 'recipe.json')])
    await settle(() => expect(button('Render this dataset').disabled).toBe(false))
  })
})


it('loads an imported recipe with a remote folder without requesting a catalog hash', async () => {
  const catalog = await generateSourceCatalogV1(inventory())
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog.catalog))
  vi.stubGlobal('fetch', fetcher)
  const callbacks = await mount({ mode: 'use' }, vi.fn(async () => {}), true)
  await attach('Adapter recipe file', [new File([JSON.stringify(minimalJson)], 'recipe.json')])
  await settle(() => expect(container.textContent).toContain('Recipe checked.'))
  await click('Remote URL')
  expect(button('Remote URL').getAttribute('aria-pressed')).toBe('true')
  expect(button('Load').disabled).toBe(true)
  await fill('url', 'https://data.example/log')
  expect(button('Load').disabled).toBe(false)
  await click('Load')
  await settle(() => expect(callbacks.render).toHaveBeenCalledOnce())
  expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://data.example/log/source-catalog.json')
  expect(container.textContent).toContain('Remote dataset connected')
  expect(callbacks.render).toHaveBeenCalledWith(expect.objectContaining({ kind: 'remote' }), expect.any(Object))
})


it('prefills remote data without fetching, and allows Load without a recipe', async () => {
  const catalog = await generateSourceCatalogV1(inventory())
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog.catalog))
  vi.stubGlobal('fetch', fetcher)
  const callbacks = await mount({ mode: 'use', remoteUrl: 'https://data.example/log/' }, vi.fn(async () => {}), true)
  expect(fetcher).not.toHaveBeenCalled()
  expect(container.querySelector<HTMLInputElement>('#adapter-data-url')?.value).toBe('https://data.example/log/')
  expect(container.textContent).toContain('Adapter recipe (optional)')
  expect(container.textContent).toContain('Data source (required)')
  expect(button('Load').disabled).toBe(false)
  await click('Load')
  await settle(() => expect(callbacks.choose).toHaveBeenCalledWith({ inventory: expect.objectContaining({ kind: 'remote' }), savedRecipes: [] }))
  expect(callbacks.render).not.toHaveBeenCalled()
})

it('passes recognized local recipes to the next screen without rendering automatically', async () => {
  const selected = inventory()
  const record = { recipeHash: 'saved', artifact: minimalJson } as never
  const callbacks = await mount({ mode: 'use', inventory: selected, savedRecipes: [record] }, vi.fn(async () => {}), true)
  expect(callbacks.render).not.toHaveBeenCalled()
  await click('Load')
  expect(callbacks.choose).toHaveBeenCalledWith({ inventory: selected, savedRecipes: [record] })
  expect(selected.snapshot().revoked).toBe(false)
})
