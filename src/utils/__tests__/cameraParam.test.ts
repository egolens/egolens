import { describe, it, expect } from 'vitest'
import { resolveCameraParam } from '../cameraParam'
import { waymoManifest } from '../../adapters/waymo/manifest'
import { nuScenesManifest } from '../../adapters/nuscenes/manifest'
import { argoverse2Manifest } from '../../adapters/argoverse2/manifest'

describe('resolveCameraParam', () => {
  it('matches the panel label on every dataset', () => {
    expect(resolveCameraParam('FRONT', waymoManifest)).toBe(1)
    expect(resolveCameraParam('FRONT', nuScenesManifest)).not.toBeNull()
    expect(resolveCameraParam('FRONT', argoverse2Manifest)).not.toBeNull()
  })

  it('ignores case, spaces, underscores and hyphens', () => {
    const id = resolveCameraParam('FRONT LEFT', waymoManifest)
    expect(id).toBe(2)
    expect(resolveCameraParam('front_left', waymoManifest)).toBe(id)
    expect(resolveCameraParam('front-left', waymoManifest)).toBe(id)
    expect(resolveCameraParam('FrontLeft', waymoManifest)).toBe(id)
  })

  it('accepts the dataset’s own channel name where one exists', () => {
    // documented in EMBEDDING.md as a valid spelling
    expect(resolveCameraParam('ring_front_center', argoverse2Manifest))
      .toBe(resolveCameraParam('FRONT', argoverse2Manifest))
    expect(resolveCameraParam('CAM_FRONT', nuScenesManifest))
      .toBe(resolveCameraParam('FRONT', nuScenesManifest))
    // …and does not invent one for datasets that have no channel names
    expect(argoverse2Manifest.cameraAliases).toBeDefined()
    expect(waymoManifest.cameraAliases).toBeUndefined()
  })

  it('accepts a bare id, but only one this dataset has', () => {
    expect(resolveCameraParam('1', waymoManifest)).toBe(1)
    expect(resolveCameraParam('99', waymoManifest)).toBeNull()
  })

  it('returns null for anything unrecognised, including a lidar channel', () => {
    expect(resolveCameraParam('nope', nuScenesManifest)).toBeNull()
    expect(resolveCameraParam('', waymoManifest)).toBeNull()
    // LIDAR_TOP is in the channel map but is not a camera
    expect(resolveCameraParam('LIDAR_TOP', nuScenesManifest)).toBeNull()
  })

  it('does not match a camera from a different dataset by id alone', () => {
    // AV2 ring ids start at 1 as well, but 6/7 exist only there
    const av2Only = argoverse2Manifest.cameraSensors.map((c) => c.id).find((id) =>
      !waymoManifest.cameraSensors.some((c) => c.id === id))
    expect(av2Only).toBeDefined()
    expect(resolveCameraParam(String(av2Only), waymoManifest)).toBeNull()
  })
})
