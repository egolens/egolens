import { describe, expect, it } from 'vitest'
import {
  bindVersionRootPathV1,
  selectVersionRootV1,
  VersionRootSelectionError,
} from '../runtime/versionRoot'

const policy = {
  candidates: ['v1.0-mini', 'v1.0-trainval', 'v1.0-test'],
  requiredFiles: ['scene.json', 'sample.json'],
}

describe('bounded version-root binding', () => {
  it.each(policy.candidates)('selects %s in isolation', (root) => {
    expect(selectVersionRootV1(policy, [root])).toBe(root)
    expect(bindVersionRootPathV1('{versionRoot}/sample.json', root)).toBe(`${root}/sample.json`)
  })

  it('rejects multiple viable roots instead of merging them', () => {
    expect(() => selectVersionRootV1(policy, ['v1.0-mini', 'v1.0-trainval'])).toThrow(VersionRootSelectionError)
    try {
      selectVersionRootV1(policy, ['v1.0-mini', 'v1.0-trainval'])
    } catch (error) {
      expect(error).toMatchObject({ code: 'VERSION_ROOT_AMBIGUOUS' })
    }
  })

  it('permits an explicit allowlisted choice for an ambiguous inventory', () => {
    expect(selectVersionRootV1(policy, ['v1.0-mini', 'v1.0-test'], 'v1.0-test')).toBe('v1.0-test')
  })

  it('rejects unavailable, unallowlisted, and unsafe selections', () => {
    expect(() => selectVersionRootV1(policy, [])).toThrow(/No complete version root/)
    expect(() => selectVersionRootV1(policy, ['v2'], 'v2')).toThrow(/not allowlisted/)
    expect(() => bindVersionRootPathV1('{versionRoot}/sample.json', '../secret')).toThrow(/Unsafe/)
  })
})
