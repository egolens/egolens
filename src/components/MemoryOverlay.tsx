/**
 * MemoryOverlay — live memory usage HUD overlay (dev tool).
 *
 * Shows current heap usage, peak, and worker estimates in a small
 * floating panel. Only renders when memory logging is enabled.
 *
 * Enable: localStorage.setItem('waymo-memory-log', 'true') then reload.
 * Toggle: press 'M' key.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { computeMemoryStats, formatBytes, memLog } from '../utils/memoryLogger'
import type { MemoryStats } from '../utils/memoryLogger'

export default function MemoryOverlay() {
  const [visible, setVisible] = useState(false)
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Track whether the user has explicitly dismissed the overlay via M key.
  // Once dismissed, auto-show won't re-enable it — only another M press will.
  const userDismissedRef = useRef(false)

  // Check if memory logging is enabled
  const isEnabled = useCallback(() => {
    return (
      (window as Window).__WAYMO_MEMORY_LOG === true ||
      localStorage.getItem('waymo-memory-log') === 'true'
    )
  }, [])

  // Toggle with 'M' key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === 'KeyM') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
        setVisible((v) => {
          const next = !v
          userDismissedRef.current = !next // dismissed when turning OFF
          return next
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Auto-show if logging enabled — but respect explicit user dismissal
  useEffect(() => {
    if (isEnabled() && !userDismissedRef.current) setVisible(true)
  }, [isEnabled])

  // Poll memory stats
  useEffect(() => {
    if (!visible) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    const update = () => setStats(computeMemoryStats())
    update()
    intervalRef.current = setInterval(update, 500)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [visible])

  if (!visible || !stats) return null

  const heapPct = stats.mainHeapLimit > 0
    ? ((stats.mainHeapUsed / stats.mainHeapLimit) * 100).toFixed(1)
    : '—'

  return (
    <div style={{
      position: 'fixed',
      bottom: 12,
      right: 12,
      zIndex: 99999,
      background: 'rgba(10, 10, 15, 0.92)',
      backdropFilter: 'blur(8px)',
      border: '1px solid rgba(78, 205, 196, 0.3)',
      borderRadius: 10,
      padding: '10px 14px',
      fontFamily: 'monospace',
      fontSize: 11,
      color: '#e0e0e8',
      minWidth: 220,
      pointerEvents: 'auto',
      userSelect: 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: '#4ecdc4', fontWeight: 700, fontSize: 10, letterSpacing: 1 }}>
          MEMORY
        </span>
        <span style={{ color: '#555', fontSize: 9, cursor: 'pointer' }} onClick={() => {
          memLog.printSummary()
        }} title="Print summary to console">
          [console]
        </span>
      </div>

      <Row label="Heap Used" value={formatBytes(stats.mainHeapUsed)} color="#ef4444" />
      <Row label="Heap Total" value={formatBytes(stats.mainHeapTotal)} color="#888" />
      <Row label="Heap Limit" value={formatBytes(stats.mainHeapLimit)} color="#555" />

      {/* Progress bar */}
      <div style={{
        height: 3,
        background: '#222',
        borderRadius: 2,
        margin: '4px 0',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${Math.min(100, parseFloat(heapPct))}%`,
          height: '100%',
          background: parseFloat(heapPct) > 80 ? '#ef4444' : '#4ecdc4',
          borderRadius: 2,
          transition: 'width 0.3s',
        }} />
      </div>
      <div style={{ fontSize: 9, color: '#666', textAlign: 'right', marginBottom: 4 }}>
        {heapPct}% of limit
      </div>

      <Row label="Peak (main)" value={formatBytes(stats.peakMainHeap)} color="#f59e0b" />
      {stats.workerHeapEstimate > 0 && (
        <Row label="Workers est." value={formatBytes(stats.workerHeapEstimate)} color="#a78bfa" />
      )}
      {stats.workerHeapEstimate > 0 && (
        <Row label="Total est." value={formatBytes(stats.totalEstimate)} color="#fff" bold />
      )}

      <div style={{ fontSize: 9, color: '#444', marginTop: 6, borderTop: '1px solid #222', paddingTop: 4 }}>
        {stats.snapshotCount} snapshots · Press M to toggle
      </div>
    </div>
  )
}

function Row({ label, value, color, bold }: { label: string; value: string; color: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color, fontWeight: bold ? 700 : 600 }}>{value}</span>
    </div>
  )
}
