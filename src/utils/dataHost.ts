/**
 * Coarse classification of where a user's data is served from.
 *
 * Deliberately lossy. Knowing whether anyone points EgoLens at their own
 * infrastructure is the question worth answering; knowing *whose*
 * infrastructure is not ours to collect. An internal hostname often names the
 * company, so only the bucket family is reported and the host itself never
 * leaves the browser.
 */

export type DataHostKind =
  /** Amazon S3, in any of its URL forms */
  | 'aws_s3'
  /** Google Cloud Storage */
  | 'gcs'
  /** Azure Blob Storage */
  | 'azure'
  /** Cloudflare R2 */
  | 'r2'
  /** A dev server on the user's own machine */
  | 'localhost'
  /** Some other HTTP host — self-hosted, or a CDN we don't recognise */
  | 'other'
  /** Local files: nothing was fetched over the network at all */
  | 'none'
  /** URL was unparseable */
  | 'unknown'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export function classifyDataHost(url: string | null | undefined): DataHostKind {
  if (!url) return 'none'

  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'unknown'
  }

  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return 'localhost'
  // Matches bucket.s3.region.amazonaws.com, s3.amazonaws.com, and s3-region forms
  if (/(^|\.)s3[.-][^.]*\.?amazonaws\.com$/.test(host) || host.endsWith('.s3.amazonaws.com')) return 'aws_s3'
  if (host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com')) return 'gcs'
  if (host.endsWith('.blob.core.windows.net')) return 'azure'
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'r2'
  return 'other'
}
