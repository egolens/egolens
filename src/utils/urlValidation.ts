/**
 * URL validation and normalization for remote data loading.
 *
 * Used by:
 * - loadFromUrl() — normalizes baseUrl before any fetches
 * - Landing page "Load" button — validates user input
 * - URL param parser — validates ?data= param on mount
 */

import { DataLoadError } from './errors'

/**
 * Normalize and validate a base URL for dataset loading.
 * Enforces HTTPS (except localhost for dev), adds trailing slash,
 * strips query/hash, rejects obviously invalid inputs.
 *
 * @throws DataLoadError on invalid input
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()

  if (!trimmed) {
    throw new DataLoadError('URL is required.', 'UNKNOWN')
  }

  // Allow http://localhost for local development
  if (trimmed.startsWith('http://localhost') || trimmed.startsWith('http://127.0.0.1')) {
    const normalized = trimmed.split('?')[0].split('#')[0]
    return normalized.endsWith('/') ? normalized : normalized + '/'
  }

  if (!trimmed.startsWith('https://')) {
    throw new DataLoadError(
      'URL must start with https://. Insecure HTTP is not supported for remote data.',
      'UNKNOWN',
      trimmed,
    )
  }

  try {
    const url = new URL(trimmed)
    // Strip query string and hash — base URL should be a clean path
    const normalized = url.origin + url.pathname
    return normalized.endsWith('/') ? normalized : normalized + '/'
  } catch {
    throw new DataLoadError('Invalid URL format.', 'UNKNOWN', trimmed)
  }
}
