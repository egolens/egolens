/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HostedTeachingPreset from '../../components/TeachableLens/HostedTeachingPreset'
import { AgentAskCard } from '../../components/TeachableLens/stages'
import { HOSTED_TEACH_PROMPT_V1, TEACH_PROMPT_V1 } from '../authoring/agentDetection'
import { PANDASET_TEACHING_SAMPLE, PANDASET_TEACHING_SAMPLES } from '../../utils/teachingSample'

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
const button = (name: string) => [...container.querySelectorAll('button')].find(el => el.textContent?.startsWith(name))!
const click = async (name: string) => { await act(async () => button(name).click()) }

describe('hosted teaching sample entry', () => {
  it('selects the preset without an agent or any remote reads', async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(<HostedTeachingPreset onSelect={onSelect} />))
    await click('Try an unsupported format')
    expect(onSelect).toHaveBeenCalledWith('001')
    expect(remote.open).not.toHaveBeenCalled()
    expect(saved.find).not.toHaveBeenCalled()
    expect(container.querySelector(`a[href="${PANDASET_TEACHING_SAMPLE.zipUrl}"]`)).not.toBeNull()
  })
  it('selects log 002 and switches its ZIP without opening any data', async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(<HostedTeachingPreset onSelect={onSelect} />))
    await click('002')
    expect(onSelect).not.toHaveBeenCalled()
    expect(button('002').getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('a')?.getAttribute('aria-label')).toContain('log 002 ZIP (416 MB)')
    expect(container.querySelector(`a[href="${PANDASET_TEACHING_SAMPLES['002'].zipUrl}"]`)).not.toBeNull()
    await click('Try an unsupported format')
    expect(onSelect).toHaveBeenCalledWith('002')
    expect(remote.open).not.toHaveBeenCalled()
  })
  it('highlights only the log matching the active data source', async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(<HostedTeachingPreset onSelect={onSelect} activeSampleId="001" />))
    expect(button('Try an unsupported format').getAttribute('aria-pressed')).toBe('true')
    await click('002')
    expect(button('Try an unsupported format').getAttribute('aria-pressed')).toBe('false')
    await act(async () => root.render(<HostedTeachingPreset onSelect={onSelect} activeSampleId="002" />))
    expect(button('Try an unsupported format').getAttribute('aria-pressed')).toBe('true')
    await act(async () => root.render(<HostedTeachingPreset onSelect={onSelect} />))
    expect(button('Try an unsupported format').getAttribute('aria-pressed')).toBe('false')
  })
  it('does not select a disabled preset', async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(<HostedTeachingPreset onSelect={onSelect} disabled />))
    await click('Try an unsupported format')
    expect(onSelect).not.toHaveBeenCalled()
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
