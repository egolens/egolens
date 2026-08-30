export interface VersionRootPolicyV1 {
  readonly candidates: readonly string[]
  readonly requiredFiles: readonly string[]
}

export class VersionRootSelectionError extends Error {
  readonly code: 'VERSION_ROOT_MISSING' | 'VERSION_ROOT_AMBIGUOUS' | 'VERSION_ROOT_INVALID'

  constructor(code: VersionRootSelectionError['code'], message: string) {
    super(message)
    this.name = 'VersionRootSelectionError'
    this.code = code
  }
}

/** Select one allowlisted root; never merges records across viable roots. */
export function selectVersionRootV1(
  policy: VersionRootPolicyV1,
  viableRoots: readonly string[],
  explicitSelection?: string,
): string {
  const allowed = new Set(policy.candidates)
  const viable = [...new Set(viableRoots)].filter((root) => allowed.has(root))
  if (explicitSelection !== undefined) {
    if (!allowed.has(explicitSelection)) {
      throw new VersionRootSelectionError('VERSION_ROOT_INVALID', `Selected version root is not allowlisted: ${explicitSelection}`)
    }
    if (!viable.includes(explicitSelection)) {
      throw new VersionRootSelectionError('VERSION_ROOT_MISSING', `Selected version root is unavailable or incomplete: ${explicitSelection}`)
    }
    return explicitSelection
  }
  if (viable.length === 0) {
    throw new VersionRootSelectionError(
      'VERSION_ROOT_MISSING',
      `No complete version root found. Expected exactly one of: ${policy.candidates.join(', ')}.`,
    )
  }
  if (viable.length > 1) {
    throw new VersionRootSelectionError(
      'VERSION_ROOT_AMBIGUOUS',
      `Multiple viable version roots found (${viable.join(', ')}). Select one explicitly; EgoLens will not merge them.`,
    )
  }
  return viable[0]
}

/** Expand the only dynamic path token admitted by the v1 source binder. */
export function bindVersionRootPathV1(path: string, versionRoot: string): string {
  if (versionRoot.includes('/') || versionRoot === '.' || versionRoot === '..') {
    throw new VersionRootSelectionError('VERSION_ROOT_INVALID', `Unsafe version root: ${versionRoot}`)
  }
  return path.replaceAll('{versionRoot}', versionRoot)
}
