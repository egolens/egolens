/** Public original-data sample for creating an adapter, without a bundled recipe. */
export const PANDASET_TEACHING_SAMPLE = Object.freeze({
  rootUrl: 'https://data.egolens.org/pandaset/001/',
  catalogUrl: 'https://data.egolens.org/pandaset/001/source-catalog.json',
  catalogHash: 'sha256:1739c7780cdac2c667c5cfab80aee1784595f2a6edd742eb23b720338c4d40df',
  // The 439 MB ZIP expands to 875 MB. Allow repeated review/playback reads,
  // while keeping the session's transport, object and memory budgets bounded.
  maxTotalResponseBytes: 4 * 1024 * 1024 * 1024,
  zipUrl: 'https://github.com/egolens/egolens/releases/download/webmcp-sample/egolens-sample-pandaset-001-full.zip',
})
