export interface AuthoringTimelinePreviewV1 {
  readonly recipeName: string
  readonly formatId: string
  readonly frameCount: number
  readonly sampledFrames: readonly number[]
  readonly sampledTimestampsMicros: readonly string[]
}

let preview: AuthoringTimelinePreviewV1 | null = null
const listeners = new Set<() => void>()

export const authoringPreviewStoreV1 = {
  getSnapshot: (): AuthoringTimelinePreviewV1 | null => preview,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  commit(next: AuthoringTimelinePreviewV1): void {
    preview = Object.freeze(next)
    listeners.forEach((listener) => listener())
  },
  clear(): void {
    preview = null
    listeners.forEach((listener) => listener())
  },
}
