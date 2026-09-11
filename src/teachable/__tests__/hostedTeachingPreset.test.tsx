/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HostedTeachingPreset from '../../components/TeachableLens/HostedTeachingPreset'
import { AgentAskCard } from '../../components/TeachableLens/stages'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { HOSTED_TEACH_PROMPT_V1, TEACH_PROMPT_V1 } from '../authoring/agentDetection'
import { PANDASET_TEACHING_SAMPLE } from '../../utils/teachingSample'
import type { FinalizedArtifactRecordV1 } from '../authoring/persistence'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import recipeJson from '../__fixtures__/importable.egolens-adapter.json'

const remote = vi.hoisted(() => ({ open: vi.fn() }))
const saved = vi.hoisted(() => ({ find: vi.fn() }))
vi.mock('../authoring/RemoteSourceInventory', () => ({ openRemoteSourceInventoryV1: remote.open }))
vi.mock('../authoring/browserSession', () => ({ teachableAuthoringSession: { findSavedRecipes: saved.find } }))
vi.mock('../../utils/analytics', () => ({ trackPresetClick: vi.fn() }))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  remote.open.mockReset()
  saved.find.mockReset().mockResolvedValue([])
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window.navigator, 'modelContext')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const agent = () => Object.defineProperty(window.navigator, 'modelContext', { configurable: true, value: { codexTest: true } })
const selected = () => new SourceInventoryV1([['frames.json', new File(['[]'], 'frames.json')]])
const button = (name: string) => [...container.querySelectorAll('button')].find((el) => el.textContent?.startsWith(name))!
const click = async (name: string) => { await act(async () => button(name).click()) }
const settle = async (check: () => void) => { await vi.waitFor(async () => { await act(async () => {}); check() }) }
const mount = async (onTeach = vi.fn(), disabled = false) => {
  await act(async () => root.render(<HostedTeachingPreset onTeach={onTeach} disabled={disabled} />))
  return onTeach
}

describe('hosted teaching sample entry', () => {
  it('keeps the full ZIP available without an agent and focuses setup instead of fetching', async () => {
    const onTeach = await mount()
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${PANDASET_TEACHING_SAMPLE.zipUrl}"]`)!
    expect(link.textContent).toBe('Download ZIP (439 MB)')
    expect(link.href).toContain('-001-full.zip')
    expect(container.textContent).toContain('Unzip, then drag the extracted folder below.')
    expect(container.textContent).toContain('80 frames')
    await click('Teach PandaSet')
    expect(document.activeElement?.textContent).toContain('Codex desktop app')
    expect(remote.open).not.toHaveBeenCalled()
    expect(saved.find).not.toHaveBeenCalled()
    expect(onTeach).not.toHaveBeenCalled()
    expect(container.querySelector('dialog')).toBeNull()
  })

  it('opens the catalog and hands the source directly to authoring without revoking it on unmount', async () => {
    agent()
    const inventory = selected()
    remote.open.mockResolvedValue(inventory)
    const onTeach = await mount()
    expect(remote.open).not.toHaveBeenCalled()
    await click('Teach PandaSet')
    await settle(() => expect(onTeach).toHaveBeenCalledWith(inventory, []))
    expect(saved.find).toHaveBeenCalledWith(inventory)
    expect(remote.open).toHaveBeenCalledWith(expect.objectContaining({
      rootUrl: PANDASET_TEACHING_SAMPLE.rootUrl,
      catalogUrl: PANDASET_TEACHING_SAMPLE.catalogUrl,
      expectedCatalogHash: PANDASET_TEACHING_SAMPLE.catalogHash,
    }))
    await act(async () => root.render(null))
    expect(inventory.revoked).toBe(false)
  })

  it('passes a matching sealed adapter to the recognized-format screen on reopening', async () => {
    agent()
    const inventory = selected()
    const record: FinalizedArtifactRecordV1 = {
      recipeHash: 'sha256:sealed-fixture', formatFingerprint: 'sha256:matching-fixture',
      artifact: assertValidRecipeV1(recipeJson), finalizedAt: '2026-09-11T00:00:00.000Z',
      capabilities: ['timeline'], reviewedCapabilities: ['timeline'],
      matcherEvidence: {}, validationSummary: {},
    }
    saved.find.mockResolvedValue([record])
    remote.open.mockResolvedValue(inventory)
    const onTeach = await mount()
    await click('Teach PandaSet')
    await settle(() => expect(onTeach).toHaveBeenCalledWith(inventory, [record]))
    expect(saved.find).toHaveBeenCalledOnce()
    expect(inventory.revoked).toBe(false)
  })

  it.each(['cancel', 'other source', 'unmount'] as const)('cancels saved-recipe lookup on %s without entering a stale source', async (action) => {
    agent()
    const inventory = selected()
    remote.open.mockResolvedValue(inventory)
    let resolve: (records: readonly FinalizedArtifactRecordV1[]) => void = () => {}
    saved.find.mockReturnValue(new Promise<readonly FinalizedArtifactRecordV1[]>((done) => { resolve = done }))
    const onTeach = await mount()
    await click('Teach PandaSet')
    await settle(() => expect(saved.find).toHaveBeenCalledOnce())
    if (action === 'cancel') await click('Cancel')
    if (action === 'other source') await mount(onTeach, true)
    if (action === 'unmount') await act(async () => root.render(null))
    await act(async () => resolve([]))
    expect(inventory.revoked).toBe(true)
    expect(onTeach).not.toHaveBeenCalled()
  })

  it('keeps a failed saved-recipe lookup retryable instead of treating the format as unknown', async () => {
    agent()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = selected()
    const retry = selected()
    remote.open.mockResolvedValueOnce(first).mockResolvedValueOnce(retry)
    saved.find.mockRejectedValueOnce(new Error('IndexedDB unavailable')).mockResolvedValueOnce([])
    const onTeach = await mount()
    await click('Teach PandaSet')
    await settle(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(first.revoked).toBe(true)
    expect(onTeach).not.toHaveBeenCalled()
    await click('Teach PandaSet')
    await settle(() => expect(onTeach).toHaveBeenCalledWith(retry, []))
  })

  it('shows a usable local alternative after network failure and retries the remote source', async () => {
    agent()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    remote.open.mockRejectedValueOnce(new Error('CORS')).mockResolvedValueOnce(selected())
    const onTeach = await mount()
    await click('Teach PandaSet')
    await settle(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('download the ZIP'))
    expect(container.querySelector(`a[href="${PANDASET_TEACHING_SAMPLE.zipUrl}"]`)).not.toBeNull()
    await click('Teach PandaSet')
    await settle(() => expect(onTeach).toHaveBeenCalledOnce())
    expect(remote.open).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it.each(['cancel', 'other source', 'unmount'] as const)('aborts on %s and revokes a late result without starting authoring', async (action) => {
    agent()
    let resolve: (inventory: SourceInventoryV1) => void = () => {}
    remote.open.mockReturnValue(new Promise<SourceInventoryV1>((done) => { resolve = done }))
    const onTeach = await mount()
    await click('Teach PandaSet')
    const signal = remote.open.mock.calls[0][0].signal as AbortSignal
    expect(button('Connecting').disabled).toBe(true)
    if (action === 'cancel') await click('Cancel')
    if (action === 'other source') await mount(onTeach, true)
    if (action === 'unmount') await act(async () => root.render(null))
    expect(signal.aborted).toBe(true)
    const inventory = selected()
    await act(async () => resolve(inventory))
    expect(inventory.revoked).toBe(true)
    expect(onTeach).not.toHaveBeenCalled()
  })

  it('copies a source-appropriate teaching prompt', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const host = { available: true, kind: 'codex', chatLocation: 'sidebar-left' } as const
    await act(async () => root.render(<AgentAskCard agent={host} sourceKind="remote" />))
    await click('Copy prompt')
    expect(writeText).toHaveBeenLastCalledWith(HOSTED_TEACH_PROMPT_V1)
    expect(writeText.mock.calls[0][0]).not.toContain('my own dataset on my machine')
    await act(async () => root.render(<AgentAskCard key="local" agent={host} />))
    await click('Copy prompt')
    expect(writeText).toHaveBeenLastCalledWith(TEACH_PROMPT_V1)
  })
})
