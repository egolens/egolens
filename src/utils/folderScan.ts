/**
 * Folder scanning for drag & drop / folder picker.
 *
 * Accepts a dropped folder or FileSystemDirectoryHandle and discovers
 * dataset segments by scanning for component subdirectories defined in
 * registered dataset manifests (via `getAllKnownComponents()`).
 *
 * Expected structure (e.g. Waymo):
 *   {root}/
 *   ├── vehicle_pose/{segment_id}.parquet
 *   ├── lidar/{segment_id}.parquet
 *   └── ...
 *
 * Returns: Map<segmentId, Map<component, File>>
 */

import { getAllKnownComponents, detectDataset } from '../adapters/registry'

// ---------------------------------------------------------------------------
// FileSystemDirectoryHandle path (Chrome, Edge — best UX)
// ---------------------------------------------------------------------------

/**
 * Scan a FileSystemDirectoryHandle for Waymo segments.
 * Works with both `showDirectoryPicker()` and drag & drop `DataTransferItem.getAsFileSystemHandle()`.
 */
export async function scanDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
): Promise<Map<string, Map<string, File>>> {
  const segments = new Map<string, Map<string, File>>()

  // Check if this directory IS a component folder (user dropped waymo_data/)
  // or if it CONTAINS component folders (user dropped a parent)
  const childDirs = new Map<string, FileSystemDirectoryHandle>()

  for await (const [name, handle] of dirHandle as any) {
    if (handle.kind === 'directory') {
      childDirs.set(name, handle as FileSystemDirectoryHandle)
    }
  }

  // Determine root: if child dirs match known components, this IS the data root
  // Otherwise, look one level deeper (e.g. user dropped a folder containing waymo_data/)
  let componentDirs: Map<string, FileSystemDirectoryHandle>

  const hasComponents = [...childDirs.keys()].some((n) => getAllKnownComponents().has(n))
  if (hasComponents) {
    componentDirs = childDirs
  } else {
    // Try one level deeper: look for a child that has component subdirs
    componentDirs = new Map()
    for (const [, childDir] of childDirs) {
      for await (const [name, handle] of childDir as any) {
        if (handle.kind === 'directory' && getAllKnownComponents().has(name)) {
          componentDirs.set(name, handle as FileSystemDirectoryHandle)
        }
      }
      if (componentDirs.size > 0) break
    }
  }

  if (componentDirs.size === 0) return segments

  // Detect dataset type — nuScenes requires different scanning strategy
  const detectedManifest = detectDataset([...componentDirs.keys()])
  if (detectedManifest?.id === 'nuscenes') {
    return scanNuScenesDirectoryHandle(componentDirs)
  }

  // Scan each component directory for .parquet files
  for (const [component, compDir] of componentDirs) {
    if (!getAllKnownComponents().has(component)) continue
    for await (const [fileName, fileHandle] of compDir as any) {
      if (fileHandle.kind !== 'file' || !fileName.endsWith('.parquet')) continue
      const segmentId = fileName.replace('.parquet', '')
      const file = await (fileHandle as FileSystemFileHandle).getFile()

      let segMap = segments.get(segmentId)
      if (!segMap) {
        segMap = new Map()
        segments.set(segmentId, segMap)
      }
      segMap.set(component, file)
    }
  }

  return segments
}

// ---------------------------------------------------------------------------
// nuScenes-specific directory scanning
// ---------------------------------------------------------------------------

/**
 * Scan a nuScenes dataset root for JSON metadata + sample data files.
 * Returns a single entry with sentinel key '__nuscenes__' containing all files.
 *
 * Structure expected:
 *   {root}/
 *   ├── v1.0-mini/  (or v1.0-trainval, v1.0-test)
 *   │   ├── scene.json, sample.json, ...
 *   ├── samples/
 *   │   ├── LIDAR_TOP/xxx.pcd.bin
 *   │   ├── CAM_FRONT/xxx.jpg
 *   │   └── ...
 */
async function scanNuScenesDirectoryHandle(
  componentDirs: Map<string, FileSystemDirectoryHandle>,
): Promise<Map<string, Map<string, File>>> {
  const allFiles = new Map<string, File>()

  // Read JSON files from metadata directory (v1.0-mini, v1.0-trainval, v1.0-test)
  const metaDirNames = ['v1.0-mini', 'v1.0-trainval', 'v1.0-test']
  for (const name of metaDirNames) {
    const dir = componentDirs.get(name)
    if (!dir) continue
    for await (const [fileName, handle] of dir as any) {
      if ((handle as FileSystemHandle).kind === 'file' && fileName.endsWith('.json')) {
        allFiles.set(fileName, await (handle as FileSystemFileHandle).getFile())
      }
    }
    break // Only use the first metadata directory found
  }

  // Read lidarseg/panoptic label files (flat: {dir}/{split}/{token}.bin or .npz)
  for (const dirName of ['lidarseg', 'panoptic'] as const) {
    const dir = componentDirs.get(dirName)
    if (!dir) continue
    // One level: lidarseg/v1.0-mini/<token>_lidarseg.bin
    for await (const [splitName, handle] of dir as any) {
      if ((handle as FileSystemHandle).kind !== 'directory') continue
      const splitDir = handle as FileSystemDirectoryHandle
      for await (const [fileName, fileHandle] of splitDir as any) {
        if ((fileHandle as FileSystemHandle).kind !== 'file') continue
        allFiles.set(
          `${dirName}/${splitName}/${fileName}`,
          await (fileHandle as FileSystemFileHandle).getFile(),
        )
      }
    }
  }

  // Read sample data files recursively (one level of sensor subdirectories)
  // Structure: samples/{sensorName}/{file}
  for (const dirName of ['samples'] as const) {
    const dir = componentDirs.get(dirName)
    if (!dir) continue
    for await (const [sensorName, handle] of dir as any) {
      if ((handle as FileSystemHandle).kind !== 'directory') continue
      const sensorDir = handle as FileSystemDirectoryHandle
      for await (const [fileName, fileHandle] of sensorDir as any) {
        if ((fileHandle as FileSystemHandle).kind !== 'file') continue
        allFiles.set(
          `${dirName}/${sensorName}/${fileName}`,
          await (fileHandle as FileSystemFileHandle).getFile(),
        )
      }
    }
  }

  return new Map([['__nuscenes__', allFiles]])
}

// ---------------------------------------------------------------------------
// DataTransfer / FileList path (Firefox, Safari fallback)
// ---------------------------------------------------------------------------

/**
 * Scan a DataTransferItemList from a drop event.
 * Uses webkitGetAsEntry() for directory traversal.
 */
export async function scanDataTransfer(
  items: DataTransferItemList,
): Promise<Map<string, Map<string, File>>> {
  const segments = new Map<string, Map<string, File>>()

  // Prefer FileSystem Access API handles (Chrome/Edge)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue

    // Try modern API first
    const handle = await (item as any).getAsFileSystemHandle?.()
    if (handle && handle.kind === 'directory') {
      return scanDirectoryHandle(handle as FileSystemDirectoryHandle)
    }

    // Fallback: webkitGetAsEntry
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isDirectory) {
      return scanFileSystemEntry(entry as FileSystemDirectoryEntry)
    }
  }

  return segments
}

/**
 * Scan using the legacy FileSystemEntry API (webkitGetAsEntry).
 */
async function scanFileSystemEntry(
  dirEntry: FileSystemDirectoryEntry,
): Promise<Map<string, Map<string, File>>> {
  const segments = new Map<string, Map<string, File>>()

  const readDir = (entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      const reader = entry.createReader()
      const entries: FileSystemEntry[] = []
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(entries)
          } else {
            entries.push(...batch)
            readBatch()
          }
        }, reject)
      }
      readBatch()
    })

  const getFile = (entry: FileSystemFileEntry): Promise<File> =>
    new Promise((resolve, reject) => entry.file(resolve, reject))

  // Find component directories (one or two levels deep)
  const topEntries = await readDir(dirEntry)
  const topDirs = topEntries.filter((e) => e.isDirectory)

  let componentEntries: { component: string; entry: FileSystemDirectoryEntry }[] = []

  // Check if top-level dirs are components
  const hasComponents = topDirs.some((d) => getAllKnownComponents().has(d.name))
  if (hasComponents) {
    componentEntries = topDirs
      .filter((d) => getAllKnownComponents().has(d.name))
      .map((d) => ({ component: d.name, entry: d as FileSystemDirectoryEntry }))
  } else {
    // Try one level deeper
    for (const dir of topDirs) {
      const children = await readDir(dir as FileSystemDirectoryEntry)
      const compDirs = children.filter((c) => c.isDirectory && getAllKnownComponents().has(c.name))
      if (compDirs.length > 0) {
        componentEntries = compDirs.map((d) => ({
          component: d.name,
          entry: d as FileSystemDirectoryEntry,
        }))
        break
      }
    }
  }

  // Read parquet files from each component dir
  for (const { component, entry } of componentEntries) {
    const files = await readDir(entry)
    for (const fileEntry of files) {
      if (!fileEntry.isFile || !fileEntry.name.endsWith('.parquet')) continue
      const segmentId = fileEntry.name.replace('.parquet', '')
      const file = await getFile(fileEntry as FileSystemFileEntry)

      let segMap = segments.get(segmentId)
      if (!segMap) {
        segMap = new Map()
        segments.set(segmentId, segMap)
      }
      segMap.set(component, file)
    }
  }

  return segments
}

// ---------------------------------------------------------------------------
// showDirectoryPicker path
// ---------------------------------------------------------------------------

/**
 * Open a native folder picker dialog and scan for segments.
 * Only works in Chrome/Edge (File System Access API).
 */
export async function pickAndScanFolder(): Promise<Map<string, Map<string, File>>> {
  const dirHandle = await (window as any).showDirectoryPicker()
  return scanDirectoryHandle(dirHandle)
}

/** Check if the File System Access API is available */
export function hasDirectoryPicker(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function'
}
