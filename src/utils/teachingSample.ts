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


export const PANDASET_TEACHING_SAMPLES = {
  '001': { ...PANDASET_TEACHING_SAMPLE, zipSizeMB: 439 },
  '002': {
    rootUrl: 'https://data.egolens.org/pandaset/002/',
    catalogUrl: 'https://data.egolens.org/pandaset/002/source-catalog.json',
    catalogHash: 'sha256:953cfbf7d3a88fd202234b1553da6ff82576dbb238230b746279e3fb7c148406',
    maxTotalResponseBytes: PANDASET_TEACHING_SAMPLE.maxTotalResponseBytes,
    zipUrl: 'https://github.com/egolens/egolens/releases/download/webmcp-sample/egolens-sample-pandaset-002-full.zip?download=1',
    zipSizeMB: 416,
  },
} as const
export type PandaSetSampleId = keyof typeof PANDASET_TEACHING_SAMPLES
