/**
 * WorkerPool maxConcurrentFetches tests (Phase 0c).
 *
 * Uses the real WorkerPool class with mock Worker factories to verify
 * that the in-flight fetch limiter works correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkerPool } from '../workerPool'

// Mock Worker that auto-responds to init, and responds to loadBatch on demand
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  private pendingBatches: Map<number, number> = new Map() // requestId → batchIndex

  postMessage(msg: any) {
    if (msg.type === 'init') {
      // Auto-respond ready after a microtask
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: 'ready', numBatches: 10 } } as MessageEvent)
      })
    } else if (msg.type === 'loadBatch') {
      this.pendingBatches.set(msg.requestId, msg.batchIndex)
    }
  }

  /** Simulate completing a batch request */
  completeBatch(requestId: number) {
    this.pendingBatches.delete(requestId)
    this.onmessage?.({
      data: { type: 'batchReady', requestId, frames: [] },
    } as MessageEvent)
  }

  /** Get pending request IDs */
  getPendingRequestIds(): number[] {
    return [...this.pendingBatches.keys()]
  }

  terminate() {}
}

describe('WorkerPool maxConcurrentFetches', () => {
  let mockWorkers: MockWorker[]

  function createPool(concurrency: number, maxConcurrentFetches?: number) {
    mockWorkers = []
    const pool = new WorkerPool<Record<string, unknown>>(
      concurrency,
      () => {
        const w = new MockWorker()
        mockWorkers.push(w)
        return w as unknown as Worker
      },
      maxConcurrentFetches,
    )
    return pool
  }

  it('defaults maxConcurrentFetches to Infinity', () => {
    const pool = createPool(4)
    expect(pool.maxConcurrentFetches).toBe(Infinity)
  })

  it('stores maxConcurrentFetches when provided', () => {
    const pool = createPool(4, 2)
    expect(pool.maxConcurrentFetches).toBe(2)
  })

  it('limits dispatched batches to maxConcurrentFetches', async () => {
    const pool = createPool(4, 2) // 4 workers but only 2 concurrent
    await pool.init({})

    // Request 4 batches — only 2 should be dispatched
    const p0 = pool.requestBatch(0)
    const p1 = pool.requestBatch(1)
    const p2 = pool.requestBatch(2)
    const p3 = pool.requestBatch(3)

    // Check that only 2 workers received loadBatch messages
    const dispatched = mockWorkers.filter(w => w.getPendingRequestIds().length > 0)
    expect(dispatched.length).toBe(2)

    // Complete the first batch — should dispatch one more from queue
    const firstWorker = dispatched[0]
    const rid = firstWorker.getPendingRequestIds()[0]
    firstWorker.completeBatch(rid)

    // Wait a tick for drain
    await new Promise(r => setTimeout(r, 0))

    // Now 2 should be in-flight again (1 original + 1 newly dispatched)
    const nowDispatched = mockWorkers.filter(w => w.getPendingRequestIds().length > 0)
    expect(nowDispatched.length).toBe(2)

    // Complete all remaining
    for (const w of mockWorkers) {
      for (const r of w.getPendingRequestIds()) {
        w.completeBatch(r)
      }
    }
    await new Promise(r => setTimeout(r, 0))
    for (const w of mockWorkers) {
      for (const r of w.getPendingRequestIds()) {
        w.completeBatch(r)
      }
    }

    // All promises should resolve
    await Promise.all([p0, p1, p2, p3])
  })

  it('dispatches all batches when maxConcurrentFetches >= concurrency (default)', async () => {
    const pool = createPool(3) // unlimited
    await pool.init({})

    pool.requestBatch(0)
    pool.requestBatch(1)
    pool.requestBatch(2)

    // All 3 workers should be dispatched
    const dispatched = mockWorkers.filter(w => w.getPendingRequestIds().length > 0)
    expect(dispatched.length).toBe(3)
  })

  it('maxConcurrentFetches=1 serializes all batch requests', async () => {
    const pool = createPool(2, 1) // 2 workers, 1 concurrent
    await pool.init({})

    const results: number[] = []
    const p0 = pool.requestBatch(0).then(() => results.push(0))
    const p1 = pool.requestBatch(1).then(() => results.push(1))

    // Only 1 should be dispatched
    let dispatched = mockWorkers.filter(w => w.getPendingRequestIds().length > 0)
    expect(dispatched.length).toBe(1)

    // Complete first
    dispatched[0].completeBatch(dispatched[0].getPendingRequestIds()[0])
    await new Promise(r => setTimeout(r, 0))

    // Now second should be dispatched
    dispatched = mockWorkers.filter(w => w.getPendingRequestIds().length > 0)
    expect(dispatched.length).toBe(1)

    // Complete second
    dispatched[0].completeBatch(dispatched[0].getPendingRequestIds()[0])

    await Promise.all([p0, p1])
    expect(results).toEqual([0, 1])
  })
})
