/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AgentAskCard, useAgent } from '../../components/TeachableLens/stages'

it('rechecks late WebMCP availability without reloading the page', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const original = Object.getOwnPropertyDescriptor(document, 'modelContext')
  function Harness() { return <AgentAskCard agent={useAgent()} /> }
  try {
    await act(async () => root.render(<Harness />))
    const check = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Check again')!
    expect(container.textContent).toContain('Set up your browser to teach this format')
    await act(async () => check().click())
    expect(container.querySelector('[role="status"]')?.textContent).toContain('still unavailable')
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {} })
    await act(async () => check().click())
    expect(container.querySelector('[data-testid="agent-prompt-hint"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Check again')
  } finally {
    await act(async () => root.unmount())
    if (original) Object.defineProperty(document, 'modelContext', original)
    else Reflect.deleteProperty(document, 'modelContext')
    container.remove()
    vi.unstubAllGlobals()
  }
})
