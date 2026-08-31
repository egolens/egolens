/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest'
import { nuScenesRecipe } from '../../adapters/nuscenes/manifest'
import { scanSelectedFiles } from '../folderScan'

function selectedFile(relativePath: string, bytes: string = ''): File {
  const file = new File([bytes], relativePath.split('/').at(-1) ?? 'file')
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

describe('scanSelectedFiles', () => {
  it('preserves Waymo component identity from an ordinary directory input', () => {
    const result = scanSelectedFiles([
      selectedFile('selected/vehicle_pose/segment.parquet'),
      selectedFile('selected/lidar/segment.parquet'),
    ])
    expect([...result.segments.keys()]).toEqual(['segment'])
    expect([...result.segments.get('segment')!.keys()].sort()).toEqual(['lidar', 'vehicle_pose'])
  })

  it('selects the declared nuScenes version root and retains sample paths', () => {
    const policy = nuScenesRecipe.match.versionRoot!
    const root = policy.candidates[0]
    const files = [
      ...policy.requiredFiles.map((name) => selectedFile(`selected/${root}/${name}`, '[]')),
      selectedFile('selected/samples/LIDAR_TOP/frame.pcd.bin', 'point'),
    ]
    const result = scanSelectedFiles(files)
    const selected = result.segments.get('__nuscenes__')!
    expect(selected.get('__versionRoot__')?.name).toBe(root)
    expect(selected.has('samples/LIDAR_TOP/frame.pcd.bin')).toBe(true)
    for (const name of policy.requiredFiles) expect(selected.has(name)).toBe(true)
  })

  it('retains a complete AV2 log under transport-neutral relative keys', () => {
    const result = scanSelectedFiles([
      selectedFile('log-id/calibration/intrinsics.feather'),
      selectedFile('log-id/calibration/egovehicle_SE3_sensor.feather'),
      selectedFile('log-id/sensors/lidar/1.feather'),
      selectedFile('log-id/sensors/cameras/ring_front_center/1.jpg'),
      selectedFile('log-id/annotations.feather'),
      selectedFile('log-id/city_SE3_egovehicle.feather'),
    ])
    const selected = result.segments.get('__argoverse2__')!
    expect(selected.get('__logId__')?.name).toBe('log-id')
    expect([...selected.keys()].sort()).toEqual([
      '__logId__',
      'annotations.feather',
      'calibration/egovehicle_SE3_sensor.feather',
      'calibration/intrinsics.feather',
      'city_SE3_egovehicle.feather',
      'sensors/cameras/ring_front_center/1.jpg',
      'sensors/lidar/1.feather',
    ])
  })

  it('retains an unsupported directory only as a bounded authoring inventory', () => {
    const result = scanSelectedFiles([
      selectedFile('private-root/frames/000.bin', 'frame'),
      selectedFile('private-root/calib/config.json', '{}'),
    ])
    expect(result.segments.size).toBe(0)
    expect(result.inventory?.snapshot().entries.map((entry) => entry.path)).toEqual([
      'calib/config.json', 'frames/000.bin',
    ])
  })
})
