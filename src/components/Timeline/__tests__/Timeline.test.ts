/**
 * Unit tests for Timeline — computeBufferSegments pure function.
 *
 * The React component itself is tested via integration tests;
 * here we cover the extracted pure logic that will grow with
 * annotation frame markers.
 */

import { describe, it, expect } from 'vitest'
import { computeBufferSegments, type BufferSegment } from '../Timeline'

describe('computeBufferSegments', () => {
  it('returns empty for totalFrames <= 1', () => {
    expect(computeBufferSegments([0], 1)).toEqual([])
    expect(computeBufferSegments([], 0)).toEqual([])
  })

  it('returns single segment for contiguous frames', () => {
    const result = computeBufferSegments([0, 1, 2, 3, 4], 10)
    expect(result).toEqual([{ start: 0, end: 4 }])
  })

  it('returns multiple segments for non-contiguous frames', () => {
    const result = computeBufferSegments([0, 1, 2, 5, 6, 7], 10)
    expect(result).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ])
  })

  it('handles single-frame segments', () => {
    const result = computeBufferSegments([0, 3, 7], 10)
    expect(result).toEqual([
      { start: 0, end: 0 },
      { start: 3, end: 3 },
      { start: 7, end: 7 },
    ])
  })

  it('handles empty cached frames array', () => {
    expect(computeBufferSegments([], 100)).toEqual([])
  })

  it('handles all frames loaded', () => {
    const frames = Array.from({ length: 199 }, (_, i) => i)
    const result = computeBufferSegments(frames, 199)
    expect(result).toEqual([{ start: 0, end: 198 }])
  })

  it('handles mixed single and multi-frame segments', () => {
    // Simulates row-group loading pattern: groups of ~51 frames
    const result = computeBufferSegments([0, 1, 2, 3, 10, 50, 51, 52], 100)
    expect(result).toEqual([
      { start: 0, end: 3 },
      { start: 10, end: 10 },
      { start: 50, end: 52 },
    ])
  })

  it('segment end values are inclusive', () => {
    const result = computeBufferSegments([5, 6, 7], 20)
    expect(result[0].start).toBe(5)
    expect(result[0].end).toBe(7) // inclusive
  })
})
