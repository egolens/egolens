/**
 * useThumbnailCache — lazy-loads scene thumbnails as they enter the viewport.
 *
 * Dataset-specific strategies:
 * - AV2 multi-log: fetch manifest.json → extract first frame FRONT camera ts → fetch JPEG
 * - AV2 single-log: extract from loaded db.cameraFilesByFrame
 * - nuScenes: extract first scene's CAM_FRONT filename from database
 * - Waymo: images are in Parquet row groups (~82MB) — always placeholder
 *
 * Concurrency is capped (default 3) to avoid flooding the network.
 */

import { useRef, useCallback, useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThumbnailStatus = 'idle' | 'loading' | 'loaded' | 'unavailable'

export interface ThumbnailEntry {
  status: ThumbnailStatus
  /** blob: URL when loaded */
  url: string | null
}

/**
 * Async resolver: given a segmentId, return a direct image URL to fetch,
 * or null if thumbnails are not available for this dataset type.
 * May perform intermediate fetches (e.g. manifest.json for AV2).
 */
export type ThumbnailResolverFn = (segmentId: string) => Promise<string | null> | string | null

// ---------------------------------------------------------------------------
// Cache singleton (survives re-renders, shared across component instances)
// ---------------------------------------------------------------------------

const cache = new Map<string, ThumbnailEntry>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

/** Global revision counter — bumped on every cache change */
let revision = 0

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot() {
  return revision
}

// ---------------------------------------------------------------------------
// Concurrency-limited async queue
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 3
let inflight = 0
const queue: Array<{ segmentId: string; resolve: ThumbnailResolverFn }> = []

function enqueue(segmentId: string, resolve: ThumbnailResolverFn) {
  queue.push({ segmentId, resolve })
  drainQueue()
}

function drainQueue() {
  while (inflight < MAX_CONCURRENCY && queue.length > 0) {
    const item = queue.shift()!
    inflight++
    loadThumbnail(item.segmentId, item.resolve).finally(() => {
      inflight--
      drainQueue()
    })
  }
}

async function loadThumbnail(segmentId: string, resolve: ThumbnailResolverFn) {
  try {
    const imageUrl = await resolve(segmentId)
    if (!imageUrl) {
      cache.set(segmentId, { status: 'unavailable', url: null })
      revision++
      notify()
      return
    }

    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    cache.set(segmentId, { status: 'loaded', url: blobUrl })
  } catch {
    cache.set(segmentId, { status: 'unavailable', url: null })
  }
  revision++
  notify()
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook that provides lazy thumbnail loading for the scene selector.
 *
 * @param resolver — async function that maps segmentId → direct image URL
 */
export function useThumbnailCache(resolver: ThumbnailResolverFn | null) {
  const resolverRef = useRef(resolver)
  resolverRef.current = resolver

  // Subscribe to cache changes (triggers re-render on thumbnail load)
  // The returned revision value is used as a dependency signal for react-window
  // rowProps so that rows re-render when thumbnails finish loading.
  const cacheRevision = useSyncExternalStore(subscribe, getSnapshot)

  /** Get current thumbnail state for a segment */
  const getThumbnail = useCallback((segmentId: string): ThumbnailEntry => {
    return cache.get(segmentId) ?? { status: 'idle', url: null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheRevision])

  /**
   * Request thumbnail loading for a segment (called when row enters viewport).
   * No-op if already loading/loaded/unavailable.
   */
  const requestThumbnail = useCallback((segmentId: string) => {
    const existing = cache.get(segmentId)
    if (existing && existing.status !== 'idle') return

    const r = resolverRef.current
    if (!r) {
      cache.set(segmentId, { status: 'unavailable', url: null })
      return
    }

    cache.set(segmentId, { status: 'loading', url: null })
    revision++
    notify()
    enqueue(segmentId, r)
  }, [])

  return { getThumbnail, requestThumbnail }
}

/**
 * Clear all cached thumbnails (call on dataset switch to avoid stale blob URLs).
 */
export function clearThumbnailCache() {
  for (const entry of cache.values()) {
    if (entry.url) URL.revokeObjectURL(entry.url)
  }
  cache.clear()
  queue.length = 0
  revision++
  notify()
}
