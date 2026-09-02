/**
 * Canonical relative keys for a browser directory-input selection.
 *
 * A `webkitdirectory` input reports every file under the selected folder's
 * own name (`nuscenes/samples/...`). Recipes, `{versionRoot}` detection, and
 * path-joined sources (`sample_data.filename`, AV2 sensor paths) are written
 * against the dataset root itself, so that leading folder name is dropped when
 * every entry shares it. The ordinary viewer and the isolated author workspace
 * must apply the identical rule: a recipe authored against one inventory shape
 * cannot bind under the other.
 */

/** Directory names that are dataset-internal roots rather than a wrapper folder. */
export const DATASET_INTERNAL_ROOT_SEGMENTS_V1: readonly string[] = Object.freeze([
  'samples', 'sweeps', 'lidarseg', 'panoptic', 'sensors', 'calibration',
])

export interface SelectedFileKeyOptionsV1 {
  /** Extra first segments that must be preserved (for example known component names). */
  readonly preserveFirstSegment?: (segment: string) => boolean
}

export function selectedFileRelativePathV1(file: File): string {
  return (file.webkitRelativePath || file.name).replaceAll('\\', '/')
}

export interface SelectedFileSelectionV1 {
  /** `[relativeKey, file]` pairs sorted by key. */
  readonly entries: readonly (readonly [string, File])[]
  /** The wrapper folder name that was dropped from every key, if any. */
  readonly strippedRoot: string | null
}

/**
 * The common leading folder is stripped unless it is a dataset-internal root
 * or preserved by `options`.
 */
export function selectedFileSelectionV1(
  files: FileList | readonly File[],
  options: SelectedFileKeyOptionsV1 = {},
): SelectedFileSelectionV1 {
  const raw = Array.from(files)
    .map((file) => ({ file, path: selectedFileRelativePathV1(file) }))
    .filter((entry) => entry.path.length > 0)
  const segments = raw.map((entry) => entry.path.split('/'))
  const commonFirst = segments.length > 0
    && segments.every((parts) => parts.length > 1 && parts[0] === segments[0]?.[0])
    ? segments[0]![0]!
    : null
  const preserveFirst = commonFirst !== null && (
    DATASET_INTERNAL_ROOT_SEGMENTS_V1.includes(commonFirst)
    || options.preserveFirstSegment?.(commonFirst) === true
  )
  const strip = commonFirst !== null && !preserveFirst
  const entries = raw
    .map((entry) => [strip ? entry.path.split('/').slice(1).join('/') : entry.path, entry.file] as const)
    .sort((left, right) => left[0].localeCompare(right[0], 'en'))
  return { entries, strippedRoot: strip ? commonFirst : null }
}

/** Sorted `[relativeKey, file]` pairs; see {@link selectedFileSelectionV1}. */
export function selectedFileKeysV1(
  files: FileList | readonly File[],
  options: SelectedFileKeyOptionsV1 = {},
): readonly (readonly [string, File])[] {
  return selectedFileSelectionV1(files, options).entries
}
