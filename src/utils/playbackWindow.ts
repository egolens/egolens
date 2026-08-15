/**
 * Playback time window — resolve t0/t1 URL params to frame indices.
 *
 * Scenario-mining results are intervals, not logs: a mining hit says "watch
 * this log from t0 to t1". The `t0`/`t1` params (and the `setWindow`
 * postMessage command) clip playback to that interval.
 *
 * Timestamps are dataset-native sensor times carried as strings — int64
 * nanoseconds exceed Number.MAX_SAFE_INTEGER, so they are only ever compared
 * as BigInt here. Units differ per dataset (AV2 ns, nuScenes/Waymo µs);
 * both sides are normalized by magnitude: values below 10^17 are µs
 * (~year 5138 in µs, ~1973 in ns — real sensor times are unambiguous).
 */

const NS_THRESHOLD = 10n ** 17n

/** Normalize a sensor timestamp to nanoseconds by magnitude. */
export function toNanoseconds(value: bigint): bigint {
  return value < NS_THRESHOLD ? value * 1000n : value
}

/** Parse a t0/t1 param — digits only, anything else is null. */
export function parseWindowTimestamp(raw: string): bigint | null {
  if (!/^\d{1,20}$/.test(raw)) return null
  return BigInt(raw)
}

export interface ResolvedWindow {
  /** First frame with timestamp ≥ t0 */
  f0: number
  /** Last frame with timestamp ≤ t1 */
  f1: number
}

/**
 * Resolve a [t0, t1] interval against a scene's per-frame timestamps.
 * Returns null when the window is malformed, inverted, or doesn't overlap
 * the scene — callers ignore the window rather than fail the load.
 */
export function resolveWindowToFrames(
  timestamps: readonly bigint[],
  t0raw: string,
  t1raw: string,
): ResolvedWindow | null {
  if (timestamps.length === 0) return null

  const t0 = parseWindowTimestamp(t0raw)
  const t1 = parseWindowTimestamp(t1raw)
  if (t0 === null || t1 === null) return null

  const lo = toNanoseconds(t0)
  const hi = toNanoseconds(t1)
  if (lo > hi) return null

  let f0 = -1
  let f1 = -1
  for (let i = 0; i < timestamps.length; i++) {
    const ts = toNanoseconds(timestamps[i])
    if (f0 === -1 && ts >= lo) f0 = i
    if (ts <= hi) f1 = i
  }
  if (f0 === -1 || f1 === -1 || f0 > f1) return null

  return { f0, f1 }
}
