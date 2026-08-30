/** Cache residency can shrink under LRU; loading progress is cumulative. */
export function isCameraBufferLoadingV1(loadedBatches: number, totalBatches: number): boolean {
  return totalBatches > 0 && loadedBatches > 0 && loadedBatches < totalBatches
}
