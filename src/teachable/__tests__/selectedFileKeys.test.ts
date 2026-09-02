/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest'
import { selectedFileKeysV1 } from '../authoring/selectedFileKeys'

function selectedFile(relativePath: string): File {
  const file = new File([''], relativePath.split('/').at(-1) ?? 'file')
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

const keys = (files: readonly File[], options?: Parameters<typeof selectedFileKeysV1>[1]) =>
  selectedFileKeysV1(files, options).map(([key]) => key)

describe('selectedFileKeysV1', () => {
  it('drops the selected wrapper folder so path-joined sources bind against the dataset root', () => {
    expect(keys([
      selectedFile('nuscenes/v1.0-mini/sample_data.json'),
      selectedFile('nuscenes/samples/LIDAR_TOP/frame.pcd.bin'),
      selectedFile('nuscenes\\samples\\CAM_FRONT\\frame.jpg'),
    ])).toEqual([
      'samples/CAM_FRONT/frame.jpg',
      'samples/LIDAR_TOP/frame.pcd.bin',
      'v1.0-mini/sample_data.json',
    ])
  })

  it('keeps a dataset-internal root when it was selected directly', () => {
    expect(keys([
      selectedFile('samples/LIDAR_TOP/a.pcd.bin'),
      selectedFile('samples/CAM_FRONT/a.jpg'),
    ])).toEqual(['samples/CAM_FRONT/a.jpg', 'samples/LIDAR_TOP/a.pcd.bin'])
  })

  it('keeps a first segment the caller marks as significant', () => {
    const files = [selectedFile('lidar/a.parquet'), selectedFile('lidar/b.parquet')]
    expect(keys(files)).toEqual(['a.parquet', 'b.parquet'])
    expect(keys(files, { preserveFirstSegment: (segment) => segment === 'lidar' }))
      .toEqual(['lidar/a.parquet', 'lidar/b.parquet'])
  })

  it('leaves mixed or single-segment selections untouched', () => {
    expect(keys([selectedFile('a/x.json'), selectedFile('b/y.json')])).toEqual(['a/x.json', 'b/y.json'])
    expect(keys([selectedFile('root/x.json'), selectedFile('loose.json')])).toEqual(['loose.json', 'root/x.json'])
  })
})
