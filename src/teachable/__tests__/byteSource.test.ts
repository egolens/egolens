import { describe, expect, it, vi } from 'vitest'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { scopedByteSourceV1 } from '../source/ByteSource'

describe('transport-neutral local ByteSourceV1', () => {
  it('keeps File below the seam and performs bounded reads', async () => {
    const file = new File([new Uint8Array([10, 20, 30, 40, 50])], 'points.bin')
    const slice = vi.spyOn(file, 'slice')
    const inventory = new SourceInventoryV1([['frames/points.bin', file]])
    const source = inventory.resolveAuthorizedSource()

    expect(source.byteLength('frames/points.bin')).toBe(5)
    await expect(source.read('frames/points.bin', { start: 1, end: 4 }))
      .resolves.toEqual(new Uint8Array([20, 30, 40]).buffer)
    expect(slice).toHaveBeenCalledWith(1, 4)

    const asyncBuffer = await source.asyncBuffer('frames/points.bin')
    await expect(asyncBuffer.slice(3, 5)).resolves.toEqual(new Uint8Array([40, 50]).buffer)
  })

  it('confines logical paths and selector scopes', async () => {
    const inventory = new SourceInventoryV1([
      ['allowed/a.bin', new File(['a'], 'a.bin')],
      ['private/b.bin', new File(['b'], 'b.bin')],
    ])
    const scoped = scopedByteSourceV1(inventory.resolveAuthorizedSource(), ['allowed/a.bin'])

    expect(scoped.has('allowed/a.bin')).toBe(true)
    expect(scoped.has('private/b.bin')).toBe(false)
    await expect(scoped.read('private/b.bin')).rejects.toThrow(/SOURCE_PATH_UNAVAILABLE/u)
    await expect(scoped.read('../secret')).rejects.toThrow(/SOURCE_PATH_INVALID/u)
  })

  it('propagates cancellation and revocation through retained capabilities', async () => {
    const inventory = new SourceInventoryV1([
      ['frame.bin', new File([new Uint8Array([1, 2, 3])], 'frame.bin')],
    ])
    const source = inventory.resolveAuthorizedSource()
    const controller = new AbortController()
    controller.abort()

    await expect(source.read('frame.bin', { signal: controller.signal })).rejects.toThrow(/aborted/u)
    inventory.revoke()
    await expect(source.read('frame.bin')).rejects.toThrow(/BYTE_SOURCE_REVOKED/u)
  })
})
