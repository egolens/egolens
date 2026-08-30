import { describe, expect, it } from 'vitest'
import { scanDirectoryHandle } from '../folderScan'

type Entry = FileSystemFileHandle | FileSystemDirectoryHandle

function directory(name: string, entries: ReadonlyMap<string, Entry>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *[Symbol.asyncIterator]() {
      yield* entries
    },
  } as unknown as FileSystemDirectoryHandle
}

function file(name: string): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    getFile: async () => new File(['[]'], name, { type: 'application/json' }),
  } as unknown as FileSystemFileHandle
}

const requiredMetadata = [
  'scene.json',
  'sample.json',
  'sample_data.json',
  'ego_pose.json',
  'calibrated_sensor.json',
  'sensor.json',
]

function rootWith(versionRoots: readonly string[]): FileSystemDirectoryHandle {
  const rootEntries = new Map<string, Entry>()
  rootEntries.set('samples', directory('samples', new Map()))
  for (const root of versionRoots) {
    rootEntries.set(root, directory(root, new Map(requiredMetadata.map((name) => [name, file(name)]))))
  }
  return directory('nuscenes', rootEntries)
}

describe('local nuScenes version-root scanning', () => {
  it.each(['v1.0-mini', 'v1.0-trainval', 'v1.0-test'])('binds %s in isolation', async (root) => {
    const result = await scanDirectoryHandle(rootWith([root]))
    const files = result.segments.get('__nuscenes__')
    expect(files?.get('__versionRoot__')?.name).toBe(root)
    expect(files?.has('scene.json')).toBe(true)
  })

  it('rejects an ambiguous local inventory', async () => {
    await expect(scanDirectoryHandle(rootWith(['v1.0-mini', 'v1.0-trainval']))).rejects.toMatchObject({
      code: 'VERSION_ROOT_AMBIGUOUS',
    })
  })
})
