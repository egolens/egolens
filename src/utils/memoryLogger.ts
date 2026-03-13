/**
 * Memory Logger — tracks heap memory usage across the data pipeline.
 *
 * Uses Chrome's `performance.memory` API (non-standard but widely available)
 * for synchronous snapshots, and collects structured events with timestamps
 * so we can reconstruct the memory timeline.
 *
 * Usage:
 *   import { memLog, getMemoryTimeline, printMemorySummary } from './memoryLogger'
 *   memLog.snap('phase-1-start')
 *   // ... do work ...
 *   memLog.snap('phase-1-end')
 *   printMemorySummary()  // prints table to console
 *
 * For Workers: use WorkerMemoryLogger which posts snapshots back to main thread.
 *
 * Enable/disable via:
 *   localStorage.setItem('waymo-memory-log', 'true')  — enable
 *   localStorage.removeItem('waymo-memory-log')        — disable (default)
 *
 * Or set window.__WAYMO_MEMORY_LOG = true in console.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemorySnapshot {
  /** Human-readable label for this snapshot */
  label: string
  /** Milliseconds since page load (performance.now()) */
  time: number
  /** JS heap currently allocated (bytes) — Chrome only */
  usedJSHeapSize: number
  /** JS heap total available (bytes) — Chrome only */
  totalJSHeapSize: number
  /** JS heap limit (bytes) — Chrome only */
  jsHeapSizeLimit: number
  /** Thread identifier (main / worker-lidar-0 / worker-cam-0 / etc.) */
  thread: string
  /** Optional: size of data being processed at this point */
  dataSize?: number
  /** Optional: human-readable note */
  note?: string
}

export interface MemoryEvent {
  type: 'snapshot'
  snapshot: MemorySnapshot
}

// ---------------------------------------------------------------------------
// Chrome performance.memory type augmentation
// ---------------------------------------------------------------------------

interface PerformanceMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

declare global {
  interface Performance {
    memory?: PerformanceMemory
  }
  interface Window {
    __WAYMO_MEMORY_LOG?: boolean
    __WAYMO_MEMORY_TIMELINE?: MemorySnapshot[]
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
  if (typeof window !== 'undefined') {
    return (
      window.__WAYMO_MEMORY_LOG === true ||
      localStorage.getItem('waymo-memory-log') === 'true'
    )
  }
  // In Worker context, check if we were told to enable
  if (typeof self !== 'undefined' && (self as unknown as { __memLogEnabled?: boolean }).__memLogEnabled) {
    return true
  }
  return false
}

function getMemoryInfo(): { used: number; total: number; limit: number } {
  const mem = performance.memory
  if (mem) {
    return {
      used: mem.usedJSHeapSize,
      total: mem.totalJSHeapSize,
      limit: mem.jsHeapSizeLimit,
    }
  }
  return { used: 0, total: 0, limit: 0 }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ---------------------------------------------------------------------------
// Main Thread Memory Logger
// ---------------------------------------------------------------------------

class MemoryLogger {
  private timeline: MemorySnapshot[] = []
  private startTime = performance.now()

  /** Take a memory snapshot with a label */
  snap(label: string, opts?: { dataSize?: number; note?: string }): MemorySnapshot | null {
    if (!isEnabled()) return null

    const mem = getMemoryInfo()
    const snapshot: MemorySnapshot = {
      label,
      time: performance.now() - this.startTime,
      usedJSHeapSize: mem.used,
      totalJSHeapSize: mem.total,
      jsHeapSizeLimit: mem.limit,
      thread: 'main',
      dataSize: opts?.dataSize,
      note: opts?.note,
    }

    this.timeline.push(snapshot)

    // Console log with color
    console.log(
      `%c[MEM]%c ${label} — %c${formatBytes(mem.used)}%c used / ${formatBytes(mem.total)} total` +
        (opts?.dataSize ? ` (data: ${formatBytes(opts.dataSize)})` : '') +
        (opts?.note ? ` — ${opts.note}` : ''),
      'color: #4ecdc4; font-weight: bold',
      'color: #ccc',
      'color: #ef4444; font-weight: bold',
      'color: #888',
    )

    return snapshot
  }

  /** Add a snapshot from a worker (received via postMessage) */
  addWorkerSnapshot(snapshot: MemorySnapshot): void {
    if (!isEnabled()) return
    this.timeline.push(snapshot)

    console.log(
      `%c[MEM]%c [${snapshot.thread}] ${snapshot.label} — %c${formatBytes(snapshot.usedJSHeapSize)}%c used` +
        (snapshot.dataSize ? ` (data: ${formatBytes(snapshot.dataSize)})` : '') +
        (snapshot.note ? ` — ${snapshot.note}` : ''),
      'color: #a78bfa; font-weight: bold',
      'color: #ccc',
      'color: #f59e0b; font-weight: bold',
      'color: #888',
    )
  }

  /** Get the full timeline sorted by time */
  getTimeline(): MemorySnapshot[] {
    return [...this.timeline].sort((a, b) => a.time - b.time)
  }

  /** Get peak memory for a specific thread */
  getPeak(thread?: string): MemorySnapshot | null {
    const filtered = thread
      ? this.timeline.filter((s) => s.thread === thread)
      : this.timeline
    if (filtered.length === 0) return null
    return filtered.reduce((max, s) =>
      s.usedJSHeapSize > max.usedJSHeapSize ? s : max,
    )
  }

  /** Print a formatted summary table to console */
  printSummary(): void {
    if (this.timeline.length === 0) {
      console.log('[MEM] No memory snapshots recorded. Enable with: localStorage.setItem("waymo-memory-log", "true")')
      return
    }

    const sorted = this.getTimeline()

    // Group by thread
    const threads = new Map<string, MemorySnapshot[]>()
    for (const s of sorted) {
      const arr = threads.get(s.thread) ?? []
      arr.push(s)
      threads.set(s.thread, arr)
    }

    console.group('%c📊 Memory Timeline Summary', 'font-size: 14px; font-weight: bold; color: #4ecdc4')

    // Overall peak
    const peak = this.getPeak()
    if (peak) {
      console.log(
        `%cPeak (main thread): ${formatBytes(peak.usedJSHeapSize)} at "${peak.label}" (${(peak.time / 1000).toFixed(2)}s)`,
        'color: #ef4444; font-weight: bold',
      )
    }

    // Per-thread summary
    for (const [thread, snaps] of threads) {
      const threadPeak = snaps.reduce((max, s) =>
        s.usedJSHeapSize > max.usedJSHeapSize ? s : max,
      )
      console.group(`%c${thread}%c — peak: ${formatBytes(threadPeak.usedJSHeapSize)}`,
        'color: #60a5fa; font-weight: bold', 'color: #888')

      console.table(
        snaps.map((s) => ({
          time: `${(s.time / 1000).toFixed(3)}s`,
          label: s.label,
          heapUsed: formatBytes(s.usedJSHeapSize),
          heapTotal: formatBytes(s.totalJSHeapSize),
          delta: '',
          dataSize: s.dataSize ? formatBytes(s.dataSize) : '—',
          note: s.note ?? '',
        })).map((row, i, _arr) => {
          if (i === 0) return { ...row, delta: '—' }
          const prev = snaps[i - 1]
          const curr = snaps[i]
          const d = curr.usedJSHeapSize - prev.usedJSHeapSize
          return { ...row, delta: `${d >= 0 ? '+' : ''}${formatBytes(d)}` }
        }),
      )

      console.groupEnd()
    }

    console.groupEnd()

    // Expose on window for programmatic access
    if (typeof window !== 'undefined') {
      window.__WAYMO_MEMORY_TIMELINE = sorted
    }
  }

  /** Reset timeline */
  clear(): void {
    this.timeline = []
    this.startTime = performance.now()
  }
}

/** Singleton instance for main thread */
export const memLog = new MemoryLogger()

// Expose globally for console access
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).memLog = memLog
}

// ---------------------------------------------------------------------------
// Worker-side Memory Logger (lighter — posts snapshots to main thread)
// ---------------------------------------------------------------------------

/**
 * Create a memory logger for use inside a Web Worker.
 * Snapshots are logged locally AND posted back to main thread.
 *
 * @param threadName - e.g. 'worker-lidar-0', 'worker-cam-1'
 */
export function createWorkerMemoryLogger(threadName: string) {
  const startTime = performance.now()
  let enabled = false

  return {
    /** Call this when the worker receives the enable flag */
    setEnabled(flag: boolean) {
      enabled = flag;
      (self as unknown as { __memLogEnabled?: boolean }).__memLogEnabled = flag
    },

    /** Take a snapshot and post it to main thread */
    snap(label: string, opts?: { dataSize?: number; note?: string }): void {
      if (!enabled) return

      const mem = getMemoryInfo()
      const snapshot: MemorySnapshot = {
        label,
        time: performance.now() - startTime,
        usedJSHeapSize: mem.used,
        totalJSHeapSize: mem.total,
        jsHeapSizeLimit: mem.limit,
        thread: threadName,
        dataSize: opts?.dataSize,
        note: opts?.note,
      }

      // Log in worker console
      console.log(
        `[MEM][${threadName}] ${label} — ${formatBytes(mem.used)} used` +
          (opts?.dataSize ? ` (data: ${formatBytes(opts.dataSize)})` : ''),
      )

      // Post to main thread for aggregation
      self.postMessage({ type: '__memorySnapshot', snapshot } satisfies { type: '__memorySnapshot'; snapshot: MemorySnapshot })
    },
  }
}

// ---------------------------------------------------------------------------
// Computed stats helper (for the overlay UI)
// ---------------------------------------------------------------------------

export interface MemoryStats {
  mainHeapUsed: number
  mainHeapTotal: number
  mainHeapLimit: number
  /** Sum of latest worker heap snapshots */
  workerHeapEstimate: number
  /** Total estimated: main + workers */
  totalEstimate: number
  /** Peak main heap seen */
  peakMainHeap: number
  /** All snapshots count */
  snapshotCount: number
}

export function computeMemoryStats(): MemoryStats {
  const mainMem = getMemoryInfo()
  const timeline = memLog.getTimeline()

  // Get latest snapshot per worker thread
  const workerLatest = new Map<string, MemorySnapshot>()
  for (const s of timeline) {
    if (s.thread !== 'main') {
      workerLatest.set(s.thread, s)
    }
  }
  let workerHeapEstimate = 0
  for (const s of workerLatest.values()) {
    workerHeapEstimate += s.usedJSHeapSize
  }

  const peakMain = memLog.getPeak('main')

  return {
    mainHeapUsed: mainMem.used,
    mainHeapTotal: mainMem.total,
    mainHeapLimit: mainMem.limit,
    workerHeapEstimate,
    totalEstimate: mainMem.used + workerHeapEstimate,
    peakMainHeap: peakMain?.usedJSHeapSize ?? mainMem.used,
    snapshotCount: timeline.length,
  }
}

export { formatBytes }
