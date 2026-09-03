import { describe, expect, it } from 'vitest'
import { MappedByteSourceV1 } from '../source/ByteSource'
import { releaseGraphValue } from '../runtime/GraphKernel'

describe('graph release and caller-owned sources', () => {
  it('clears graph caches but never the byte source or execution context they reference', () => {
    const source = new MappedByteSourceV1([['lidar/timestamps.json', new File(['[1]'], 'timestamps.json')]])
    const resources = { snapshot: () => ({}) }
    const context = { source, resources, throwIfAborted() {}, scratch: new Map([['k', 1]]) }
    let released = 0
    const collection = {
      context,
      retainedReleases: new Map([['a', () => { released += 1 }]]),
      cache: new Map([['x', 1]]),
      rows: [{ context, nested: new Map([['deep', context]]) }],
    }
    releaseGraphValue({ collection, direct: source, context }, new WeakSet())
    expect(released).toBe(1)
    expect(collection.cache.size).toBe(0)
    expect(source.has('lidar/timestamps.json')).toBe(true)
    expect(context.scratch.size).toBe(1)
  })
})

describe('mapped byte source hardening', () => {
  it('exposes no enumerable map that a reflective walk could clear', () => {
    const source = new MappedByteSourceV1([['a/b.json', new File(['1'], 'b.json')]])
    for (const value of Object.values(source)) expect(value instanceof Map || value instanceof Set).toBe(false)
    releaseGraphValue(source, new WeakSet())
    expect(source.has('a/b.json')).toBe(true)
  })
})
