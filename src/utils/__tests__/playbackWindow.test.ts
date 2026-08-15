import { describe, it, expect } from 'vitest'
import { toNanoseconds, parseWindowTimestamp, resolveWindowToFrames } from '../playbackWindow'

// AV2-style nanosecond timestamps, 10 frames 0.1s apart
const NS_BASE = 315966265659927216n
const NS_TS = Array.from({ length: 10 }, (_, i) => NS_BASE + BigInt(i) * 100_000_000n)

// nuScenes/Waymo-style microsecond timestamps, 10 frames 0.5s apart
const US_BASE = 1532402927814384n
const US_TS = Array.from({ length: 10 }, (_, i) => US_BASE + BigInt(i) * 500_000n)

describe('toNanoseconds', () => {
  it('passes nanosecond-scale values through', () => {
    expect(toNanoseconds(NS_BASE)).toBe(NS_BASE)
  })
  it('scales microsecond-scale values up', () => {
    expect(toNanoseconds(US_BASE)).toBe(US_BASE * 1000n)
  })
})

describe('parseWindowTimestamp', () => {
  it('parses digit strings', () => {
    expect(parseWindowTimestamp('315966265659927216')).toBe(315966265659927216n)
  })
  it('rejects non-digits, negatives, and empty', () => {
    expect(parseWindowTimestamp('12.5')).toBeNull()
    expect(parseWindowTimestamp('-5')).toBeNull()
    expect(parseWindowTimestamp('')).toBeNull()
    expect(parseWindowTimestamp('1e18')).toBeNull()
  })
})

describe('resolveWindowToFrames', () => {
  it('resolves an interior ns window to [first ≥ t0, last ≤ t1]', () => {
    const t0 = String(NS_TS[2])
    const t1 = String(NS_TS[5])
    expect(resolveWindowToFrames(NS_TS, t0, t1)).toEqual({ f0: 2, f1: 5 })
  })

  it('resolves µs params against µs timestamps', () => {
    const t0 = String(US_TS[1])
    const t1 = String(US_TS[8])
    expect(resolveWindowToFrames(US_TS, t0, t1)).toEqual({ f0: 1, f1: 8 })
  })

  it('resolves ns params against µs timestamps (cross-unit)', () => {
    const t0 = String(US_TS[3] * 1000n)
    const t1 = String(US_TS[6] * 1000n)
    expect(resolveWindowToFrames(US_TS, t0, t1)).toEqual({ f0: 3, f1: 6 })
  })

  it('clamps a window wider than the scene', () => {
    const t0 = String(NS_TS[0] - 10_000_000_000n)
    const t1 = String(NS_TS[9] + 10_000_000_000n)
    expect(resolveWindowToFrames(NS_TS, t0, t1)).toEqual({ f0: 0, f1: 9 })
  })

  it('snaps mid-interval bounds inward', () => {
    // t0 just after frame 2, t1 just before frame 7 → [3, 6]
    const t0 = String(NS_TS[2] + 1n)
    const t1 = String(NS_TS[7] - 1n)
    expect(resolveWindowToFrames(NS_TS, t0, t1)).toEqual({ f0: 3, f1: 6 })
  })

  it('rejects inverted windows', () => {
    expect(resolveWindowToFrames(NS_TS, String(NS_TS[5]), String(NS_TS[2]))).toBeNull()
  })

  it('rejects non-overlapping windows', () => {
    const t0 = String(NS_TS[9] + 1_000_000_000n)
    const t1 = String(NS_TS[9] + 2_000_000_000n)
    expect(resolveWindowToFrames(NS_TS, t0, t1)).toBeNull()
  })

  it('rejects malformed values and empty scenes', () => {
    expect(resolveWindowToFrames(NS_TS, 'abc', String(NS_TS[5]))).toBeNull()
    expect(resolveWindowToFrames([], String(NS_TS[0]), String(NS_TS[5]))).toBeNull()
  })
})
