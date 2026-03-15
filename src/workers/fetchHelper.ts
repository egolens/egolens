/**
 * Worker-side fetch helper for URL-based data loading.
 *
 * Workers receive file entries as `File | string`:
 * - File  → local drag-and-drop (call .arrayBuffer())
 * - string → remote URL (call fetch())
 *
 * The retry logic (3 attempts, exponential backoff 1s/2s/4s) is embedded here —
 * workers handle their own retries with no main-thread coordination.
 * Per-attempt AbortSignal.timeout(30s) prevents hung connections.
 */

const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 1000
const FETCH_TIMEOUT_MS = 30_000 // 30s per attempt

/**
 * Resolve a file entry (local File or remote URL) to an ArrayBuffer.
 *
 * - File: calls file.arrayBuffer() directly (no retry — local I/O is reliable)
 * - string (URL): fetches with retry + exponential backoff + per-attempt timeout
 *
 * @throws Error on permanent failure (all retries exhausted or non-retryable HTTP status)
 */
export async function resolveFileEntry(entry: File | string): Promise<ArrayBuffer> {
  if (typeof entry !== 'string') {
    return entry.arrayBuffer()
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(entry, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        // 4xx errors are not retryable (except 429 Too Many Requests)
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status}: ${entry}`)
        }
        // 5xx and 429 are retryable
        throw new RetryableError(`HTTP ${res.status}: ${entry}`)
      }
      return res.arrayBuffer()
    } catch (err) {
      // Non-retryable errors: don't waste attempts
      if (err instanceof Error && !(err instanceof RetryableError) && err.name !== 'TimeoutError' && err.name !== 'AbortError') {
        // If it's a TypeError ('Failed to fetch') it could be transient network — retry
        if (!(err instanceof TypeError)) {
          throw err
        }
      }

      if (attempt === MAX_RETRIES - 1) {
        throw err instanceof RetryableError
          ? new Error(err.message)
          : err
      }

      // Exponential backoff: 1s, 2s, 4s
      await new Promise(r => setTimeout(r, BACKOFF_BASE_MS * (2 ** attempt)))
    }
  }

  throw new Error('unreachable')
}

/** Internal marker for retryable errors within the retry loop. */
class RetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryableError'
  }
}
