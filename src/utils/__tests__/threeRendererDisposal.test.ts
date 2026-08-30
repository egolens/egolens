import { describe, expect, it, vi } from 'vitest'
import { disposeThreeRendererResources } from '../threeRendererDisposal'

describe('Three renderer disposal', () => {
  it('disposes unique geometries and materials before the renderer', () => {
    const order: string[] = []
    const geometry = { dispose: vi.fn(() => order.push('geometry')) }
    const materialA = { dispose: vi.fn(() => order.push('material-a')) }
    const materialB = { dispose: vi.fn(() => order.push('material-b')) }
    const scene = {
      traverse(callback: (object: unknown) => void) {
        callback({ geometry, material: [materialA, materialB] })
        callback({ geometry, material: materialA })
      },
    }
    const renderer = { dispose: vi.fn(() => order.push('renderer')) }

    disposeThreeRendererResources(scene as never, renderer as never)

    expect(geometry.dispose).toHaveBeenCalledOnce()
    expect(materialA.dispose).toHaveBeenCalledOnce()
    expect(materialB.dispose).toHaveBeenCalledOnce()
    expect(order.at(-1)).toBe('renderer')
  })
})
