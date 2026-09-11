/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AdapterRecipeIntro from '../../components/TeachableLens/AdapterRecipeIntro'

it('invokes the preset action without passing the click event as a log ID', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onTry = vi.fn()
  try {
    await act(async () => root.render(<AdapterRecipeIntro onClose={() => {}} onTry={onTry} />))
    await act(async () => container.querySelector<HTMLButtonElement>('.adapter-intro-cta')!.click())
    expect(onTry).toHaveBeenCalledExactlyOnceWith()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
