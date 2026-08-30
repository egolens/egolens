function assertSortedUnique(timestamps: readonly bigint[], label: string): void {
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] <= timestamps[index - 1]) {
      throw new Error(`${label} timestamps must be strictly increasing.`)
    }
  }
}

/** Return the nearest source timestamp within an explicit maximum delta. */
export function alignNearestTimestampV1(
  sortedSources: readonly bigint[],
  target: bigint,
  maxDelta: bigint,
): bigint | null {
  if (maxDelta < 0n) throw new Error('maxDelta must be non-negative.')
  if (sortedSources.length === 0) return null
  assertSortedUnique(sortedSources, 'Source')
  let low = 0
  let high = sortedSources.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (sortedSources[middle] < target) low = middle + 1
    else high = middle
  }
  let nearest = sortedSources[low]
  let distance = nearest >= target ? nearest - target : target - nearest
  if (low > 0) {
    const previous = sortedSources[low - 1]
    const previousDistance = target - previous
    if (previousDistance <= distance) {
      nearest = previous
      distance = previousDistance
    }
  }
  return distance <= maxDelta ? nearest : null
}

/** Validate and convert one nanosecond timeline into normalized microseconds. */
export function normalizeNanosecondTimelineV1(timestamps: readonly bigint[]): readonly bigint[] {
  assertSortedUnique(timestamps, 'Timeline')
  return timestamps.map((timestamp) => timestamp / 1000n)
}
