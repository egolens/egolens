/**
 * Structured error types for URL-based data loading.
 *
 * Provides classification codes so the UI can show actionable
 * error messages to users (e.g. "CORS issue" vs "file not found").
 */

export type DataLoadErrorCode =
  | 'CORS'         // Blocked by CORS (opaque fetch failure)
  | 'NOT_FOUND'    // 404 — wrong URL or missing file
  | 'NETWORK'      // Network offline or DNS failure
  | 'TIMEOUT'      // Fetch took > 30s
  | 'PARSE'        // File fetched but unparseable (corrupt/wrong format)
  | 'MANIFEST'     // manifest.json missing or malformed
  | 'RANGE'        // Server doesn't support Range requests (warning, not fatal)
  | 'UNKNOWN'

export class DataLoadError extends Error {
  readonly code: DataLoadErrorCode
  readonly url: string | undefined
  readonly retryable: boolean

  constructor(
    message: string,
    code: DataLoadErrorCode,
    url?: string,
    retryable: boolean = false,
  ) {
    super(message)
    this.name = 'DataLoadError'
    this.code = code
    this.url = url
    this.retryable = retryable
  }
}

/**
 * Classify a fetch() catch error into a DataLoadError.
 *
 * Heuristic: `TypeError('Failed to fetch')` is the canonical signal for
 * CORS blocks and network failures in browsers. `AbortError` means timeout
 * (via AbortSignal.timeout). Everything else is UNKNOWN.
 */
export function classifyFetchError(error: unknown, url: string): DataLoadError {
  if (error instanceof TypeError) {
    const msg = error.message.toLowerCase()
    if (msg.includes('failed to fetch') || msg.includes('network')) {
      // Could be CORS or actual network failure. We can't distinguish in
      // the browser (opaque response), but CORS is more likely for cross-origin URLs.
      return new DataLoadError(
        'Cannot access data at this URL. This is usually a CORS issue — ' +
        'ensure the hosting server allows cross-origin requests, ' +
        'or check your network connection.',
        'CORS', url, true,
      )
    }
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return new DataLoadError(
      'Request timed out. The server may be slow or the file too large.',
      'TIMEOUT', url, true,
    )
  }

  if (error instanceof Error) {
    return new DataLoadError(error.message, 'UNKNOWN', url)
  }

  return new DataLoadError(String(error), 'UNKNOWN', url)
}

/**
 * Classify an HTTP error status into a DataLoadError.
 * Use after fetch() succeeds but `response.ok` is false.
 */
export function classifyHttpError(status: number, url: string): DataLoadError {
  if (status === 404) {
    const filename = url.split('/').pop() ?? url
    return new DataLoadError(
      `File not found: ${filename}\nCheck the URL path.`,
      'NOT_FOUND', url,
    )
  }

  if (status === 403) {
    return new DataLoadError(
      'Access denied. The hosting server may require authentication or CORS headers.',
      'CORS', url,
    )
  }

  if (status === 416) {
    return new DataLoadError(
      'Server does not support Range requests for this resource.',
      'RANGE', url,
    )
  }

  // 5xx are retryable; 4xx generally are not
  return new DataLoadError(
    `HTTP ${status} for ${url}`,
    'UNKNOWN', url, status >= 500,
  )
}
