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
import { nuScenesRecipe } from '../adapters/nuscenes/manifest'
import { selectVersionRootV1 } from '../teachable/runtime/versionRoot'
import {
  MAX_SOURCE_INVENTORY_ENTRIES_V1,
  SourceInventoryV1,
  sourceInventoryFromFilesV1,
} from '../teachable/authoring/SourceInventory'

// ---------------------------------------------------------------------------
// File System Access API typings not yet in this project's lib.dom setup
// ---------------------------------------------------------------------------

declare global {
  /**
   * `FileSystemDirectoryHandle` is async-iterable at runtime, but the
   * `DOM.AsyncIterable` lib is not enabled in tsconfig — declare the
   * iterator here so `for await` over a handle type-checks.
   */
  interface FileSystemDirectoryHandle {
    [Symbol.asyncIterator](): AsyncIterableIterator<
      [string, FileSystemFileHandle | FileSystemDirectoryHandle]
    >
  }
}

/** `DataTransferItem.getAsFileSystemHandle()` — File System Access API, not in lib.dom yet */
interface DataTransferItemWithHandle extends DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
}

/** `window.showDirectoryPicker()` — File System Access API, not in lib.dom yet */
interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

// ---------------------------------------------------------------------------
// Scan result & rejection diagnostics
// ---------------------------------------------------------------------------

/**
 * Directory names that belong to a published dataset layout.
 *
 * Only these are ever reported to analytics. Everything else in a user's tree
 * could name their employer or project, and answering "what shape do people
 * drop?" does not require knowing that.
 */
const KNOWN_LAYOUT_NAMES = new Set([
  // Waymo archive splits
  'training', 'validation', 'testing', 'domain_adaptation', 'perception', 'motion',
  // Generic splits
  'train', 'val', 'test',
  // nuScenes
  'samples', 'sweeps', 'maps', 'can_bus',
  'v1.0-mini', 'v1.0-trainval', 'v1.0-test',
  // Argoverse 2
  'sensor', 'lidar', 'cameras', 'calibration',
])

/** Split directories that mean the user is pointing above a single log. */
const SPLIT_NAMES = new Set(['training', 'validation', 'testing', 'train', 'val', 'test'])

/** Why a scan came back with nothing — drives the on-screen message and telemetry. */
export interface FolderRejection {
  /**
   * Every top-level directory name found.
   *
   * For the error message only. Shown in the browser, never transmitted: a
   * folder can be named after a company or an unreleased project.
   */
  found: string[]
  /** The subset drawn from KNOWN_LAYOUT_NAMES — the part safe to report */
  knownNames: string[]
  /** How many directories were there, a shape hint carrying no names */
  dirCount: number
  /** The drop looks like a dataset archive root, not a single log directory */
  looksLikeArchiveRoot: boolean
}

/** Outcome of a folder scan. `rejection` is set only when no segments were found. */
export interface ScanResult {
  segments: Map<string, Map<string, File>>
  rejection?: FolderRejection
  /** Session-only files retained for Teachable Lens when no adapter matches. */
  inventory?: SourceInventoryV1
}

/** Build the diagnostic for a folder that yielded no dataset. */
export function describeRejection(topLevelDirNames: string[]): FolderRejection {
  const lower = topLevelDirNames.map((n) => n.toLowerCase())
  return {
    found: topLevelDirNames,
    knownNames: lower.filter((n) => KNOWN_LAYOUT_NAMES.has(n)).sort(),
    dirCount: topLevelDirNames.length,
    looksLikeArchiveRoot: lower.some((n) => SPLIT_NAMES.has(n)),
  }
}


/**
 * Turn a failed scan into something the user can act on.
 *
 * The published datasets are tens to thousands of logs deep and hundreds of
 * gigabytes wide, so "drop a dataset folder" is not guidance — the whole
 * question is *which* folder. Each branch below names the specific mistake the
 * directory listing points to.
 */
export function describeFolderProblem(rejection: FolderRejection | undefined): string {
  const expected = 'Expected a log folder containing component directories like vehicle_pose/, lidar/, camera_image/ (Waymo), samples/ + sweeps/ (nuScenes), or sensors/ + calibration/ (Argoverse 2).'

  if (!rejection || rejection.dirCount === 0) {
    return `No folders found in that drop. Drop a dataset folder, not individual files. ${expected}`
  }

  if (rejection.looksLikeArchiveRoot) {
    return (
      `That looks like the dataset archive root — it contains ${rejection.found.slice(0, 4).join(', ')}` +
      `${rejection.found.length > 4 ? ', …' : ''}. Go into one split (e.g. validation/), then drop a single log folder from inside it. ${expected}`
    )
  }

  return (
    `No dataset found in that folder. It contains ${rejection.found.slice(0, 5).join(', ')}` +
    `${rejection.found.length > 5 ? `, and ${rejection.found.length - 5} more` : ''}. ${expected}`
  )
}

// ---------------------------------------------------------------------------
// FileSystemDirectoryHandle path (Chrome, Edge — best UX)
// ---------------------------------------------------------------------------

/**
 * Scan a FileSystemDirectoryHandle for Waymo segments.
 * Works with both `showDirectoryPicker()` and drag & drop `DataTransferItem.getAsFileSystemHandle()`.
 */
export async function scanDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
): Promise<ScanResult> {
  const segments = new Map<string, Map<string, File>>()

  // Check if this directory IS a component folder (user dropped waymo_data/)
  // or if it CONTAINS component folders (user dropped a parent)
  const childDirs = new Map<string, FileSystemDirectoryHandle>()

  for await (const [name, handle] of dirHandle) {
    if (handle.kind === 'directory') {
      childDirs.set(name, handle as FileSystemDirectoryHandle)
    }
  }

  // Determine root: if child dirs match known components, this IS the data root
  // Otherwise, look one level deeper (e.g. user dropped a folder containing waymo_data/)
  let componentDirs: Map<string, FileSystemDirectoryHandle>
  let resolvedDirHandle = dirHandle  // Track the actual data root for AV2

  const hasComponents = [...childDirs.keys()].some((n) => getAllKnownComponents().has(n))
  if (hasComponents) {
    componentDirs = childDirs
  } else {
    // Try one level deeper: look for a child that has component subdirs
    componentDirs = new Map()
    for (const [, childDir] of childDirs) {
      for await (const [name, handle] of childDir) {
        if (handle.kind === 'directory' && getAllKnownComponents().has(name)) {
          componentDirs.set(name, handle as FileSystemDirectoryHandle)
        }
      }
      if (componentDirs.size > 0) {
        resolvedDirHandle = childDir  // The actual log/data directory is one level down
        break
      }
    }
  }

  if (componentDirs.size === 0) {
    // Nothing recognisable at either level. Report what the user actually
    // pointed at so the message can name the mismatch instead of restating
    // the requirement.
    return {
      segments,
      rejection: describeRejection([...childDirs.keys()]),
      inventory: await inventoryFromDirectoryHandle(dirHandle),
    }
  }

  // Detect dataset type — nuScenes/AV2 require different scanning strategies
  const detectedManifest = detectDataset([...componentDirs.keys()])
  if (detectedManifest?.id === 'nuscenes') {
    return { segments: await scanNuScenesDirectoryHandle(componentDirs) }
  }
  if (detectedManifest?.id === 'argoverse2') {
    return { segments: await scanAV2DirectoryHandle(resolvedDirHandle, componentDirs) }
  }

  // Scan each component directory for .parquet files
  for (const [component, compDir] of componentDirs) {
    if (!getAllKnownComponents().has(component)) continue
    for await (const [fileName, fileHandle] of compDir) {
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

  if (segments.size === 0) {
    return {
      segments,
      rejection: describeRejection([...childDirs.keys()]),
      inventory: await inventoryFromDirectoryHandle(dirHandle),
    }
  }
  return { segments }
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

  const policy = nuScenesRecipe.match.versionRoot
  if (!policy) throw new Error('The bundled nuScenes recipe has no version-root policy.')
  const filesByRoot = new Map<string, Map<string, File>>()
  for (const name of policy.candidates) {
    const dir = componentDirs.get(name)
    if (!dir) continue
    const files = new Map<string, File>()
    for await (const [fileName, handle] of dir) {
      if ((handle as FileSystemHandle).kind === 'file' && fileName.endsWith('.json')) {
        files.set(fileName, await (handle as FileSystemFileHandle).getFile())
      }
    }
    filesByRoot.set(name, files)
  }
  const viableRoots = [...filesByRoot]
    .filter(([, files]) => policy.requiredFiles.every((file) => files.has(file)))
    .map(([root]) => root)
  const selectedRoot = selectVersionRootV1(policy, viableRoots)
  for (const [fileName, file] of filesByRoot.get(selectedRoot) ?? []) allFiles.set(fileName, file)
  allFiles.set('__versionRoot__', new File([], selectedRoot))

  // Read lidarseg/panoptic label files (flat: {dir}/{split}/{token}.bin or .npz)
  for (const dirName of ['lidarseg', 'panoptic'] as const) {
    const dir = componentDirs.get(dirName)
    if (!dir) continue
    // One level: lidarseg/v1.0-mini/<token>_lidarseg.bin
    for await (const [splitName, handle] of dir) {
      if (splitName !== selectedRoot) continue
      if ((handle as FileSystemHandle).kind !== 'directory') continue
      const splitDir = handle as FileSystemDirectoryHandle
      for await (const [fileName, fileHandle] of splitDir) {
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
    for await (const [sensorName, handle] of dir) {
      if ((handle as FileSystemHandle).kind !== 'directory') continue
      const sensorDir = handle as FileSystemDirectoryHandle
      for await (const [fileName, fileHandle] of sensorDir) {
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
// Argoverse 2-specific directory scanning
// ---------------------------------------------------------------------------

/**
 * Scan an Argoverse 2 Sensor Dataset directory.
 *
 * AV2 has two possible input structures:
 * 1. Single log: user drops a log directory containing sensors/ and calibration/
 * 2. Multi-log: user drops a parent directory containing multiple log subdirectories
 *
 * Returns a single entry with sentinel key '__argoverse2__' containing all files
 * for the detected log(s), or one entry per log if multiple are found.
 *
 * Single log structure:
 *   {log_id}/
 *   ├── sensors/
 *   │   ├── lidar/{timestamp_ns}.feather
 *   │   └── cameras/{cam_name}/{timestamp_ns}.jpg
 *   ├── calibration/
 *   │   ├── egovehicle_SE3_sensor.feather
 *   │   └── intrinsics.feather
 *   ├── annotations.feather
 *   └── city_SE3_egovehicle.feather
 */
async function scanAV2DirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  componentDirs: Map<string, FileSystemDirectoryHandle>,
): Promise<Map<string, Map<string, File>>> {
  // Check if this IS a single log directory (has sensors/ and calibration/ directly)
  if (componentDirs.has('sensors') && componentDirs.has('calibration')) {
    const allFiles = await scanSingleAV2Log(dirHandle, componentDirs)
    const logId = dirHandle.name || 'av2_log'
    return new Map([['__argoverse2__', new Map([
      ...allFiles.entries(),
      ['__logId__', new File([], logId)] as [string, File],  // Sentinel to pass logId
    ])]])
  }

  // Otherwise, this might be a parent directory with multiple log subdirs
  // Scan each child directory to see if it's an AV2 log
  const result = new Map<string, Map<string, File>>()
  const logDirs: [string, FileSystemDirectoryHandle][] = []

  for await (const [name, handle] of dirHandle) {
    if (handle.kind !== 'directory') continue
    // Check if this child has sensors/ and calibration/
    const childDirs = new Map<string, FileSystemDirectoryHandle>()
    for await (const [childName, childHandle] of handle) {
      if (childHandle.kind === 'directory') {
        childDirs.set(childName, childHandle as FileSystemDirectoryHandle)
      }
    }
    if (childDirs.has('sensors') && childDirs.has('calibration')) {
      logDirs.push([name, handle as FileSystemDirectoryHandle])
    }
  }

  if (logDirs.length === 0) return result

  // For now, load first log only (multi-log support can be added later)
  const [logId, logHandle] = logDirs[0]
  const logComponentDirs = new Map<string, FileSystemDirectoryHandle>()
  for await (const [name, handle] of logHandle) {
    if (handle.kind === 'directory') {
      logComponentDirs.set(name, handle as FileSystemDirectoryHandle)
    }
  }

  const allFiles = await scanSingleAV2Log(logHandle, logComponentDirs)
  return new Map([['__argoverse2__', new Map([
    ...allFiles.entries(),
    ['__logId__', new File([], logId)] as [string, File],
  ])]])
}

/**
 * Scan a single AV2 log directory and collect all files.
 */
async function scanSingleAV2Log(
  logHandle: FileSystemDirectoryHandle,
  componentDirs: Map<string, FileSystemDirectoryHandle>,
): Promise<Map<string, File>> {
  const allFiles = new Map<string, File>()

  // Read top-level feather files (annotations, poses)
  for await (const [fileName, handle] of logHandle) {
    if (handle.kind === 'file' && fileName.endsWith('.feather')) {
      allFiles.set(fileName, await (handle as FileSystemFileHandle).getFile())
    }
  }

  // Read calibration files
  const calibDir = componentDirs.get('calibration')
  if (calibDir) {
    for await (const [fileName, handle] of calibDir) {
      if (handle.kind === 'file' && fileName.endsWith('.feather')) {
        allFiles.set(`calibration/${fileName}`, await (handle as FileSystemFileHandle).getFile())
      }
    }
  }

  // Read sensor files: sensors/lidar/*.feather and sensors/cameras/{cam}/*.jpg
  const sensorsDir = componentDirs.get('sensors')
  if (sensorsDir) {
    for await (const [sensorType, handle] of sensorsDir) {
      if (handle.kind !== 'directory') continue
      const sensorTypeDir = handle as FileSystemDirectoryHandle

      if (sensorType === 'lidar') {
        // sensors/lidar/{timestamp_ns}.feather
        for await (const [fileName, fileHandle] of sensorTypeDir) {
          if (fileHandle.kind === 'file' && fileName.endsWith('.feather')) {
            allFiles.set(
              `sensors/lidar/${fileName}`,
              await (fileHandle as FileSystemFileHandle).getFile(),
            )
          }
        }
      } else if (sensorType === 'cameras') {
        // sensors/cameras/{cam_name}/{timestamp_ns}.jpg
        for await (const [camName, camHandle] of sensorTypeDir) {
          if (camHandle.kind !== 'directory') continue
          const camDir = camHandle as FileSystemDirectoryHandle
          for await (const [fileName, fileHandle] of camDir) {
            if (fileHandle.kind === 'file' && fileName.endsWith('.jpg')) {
              allFiles.set(
                `sensors/cameras/${camName}/${fileName}`,
                await (fileHandle as FileSystemFileHandle).getFile(),
              )
            }
          }
        }
      }
    }
  }

  return allFiles
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
): Promise<ScanResult> {
  const segments = new Map<string, Map<string, File>>()

  // Prefer FileSystem Access API handles (Chrome/Edge)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue

    // Try modern API first
    const handle = await (item as DataTransferItemWithHandle).getAsFileSystemHandle?.()
    if (handle && handle.kind === 'directory') {
      return scanDirectoryHandle(handle as FileSystemDirectoryHandle)
    }

    // Fallback: webkitGetAsEntry
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isDirectory) {
      const directory = entry as FileSystemDirectoryEntry
      const scanned = await scanFileSystemEntry(directory)
      if (scanned.size > 0) return { segments: scanned }
      return {
        segments: scanned,
        rejection: describeRejection([]),
        inventory: await inventoryFromFileSystemEntry(directory),
      }
    }
  }

  // Loose files are still a user-authorized source inventory (and may include
  // an importable .egolens-adapter.json artifact).
  const looseFiles: [string, File][] = []
  for (let index = 0; index < items.length; index += 1) {
    const file = items[index].getAsFile()
    if (file) looseFiles.push([file.webkitRelativePath || file.name, file])
  }
  return {
    segments,
    rejection: describeRejection([]),
    ...(looseFiles.length > 0 ? { inventory: sourceInventoryFromFilesV1(looseFiles) } : {}),
  }
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
export async function pickAndScanFolder(): Promise<ScanResult> {
  const dirHandle = await (window as WindowWithDirectoryPicker).showDirectoryPicker!()
  return scanDirectoryHandle(dirHandle)
}

/** Check if the File System Access API is available */
export function hasDirectoryPicker(): boolean {
  return typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
}

async function inventoryFromDirectoryHandle(dirHandle: FileSystemDirectoryHandle): Promise<SourceInventoryV1> {
  const files: [string, File][] = []
  let truncated = false
  const visit = async (directory: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > 12) {
      truncated = true
      return
    }
    for await (const [name, handle] of directory) {
      if (files.length >= MAX_SOURCE_INVENTORY_ENTRIES_V1) {
        truncated = true
        return
      }
      const path = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'file') files.push([path, await (handle as FileSystemFileHandle).getFile()])
      else await visit(handle as FileSystemDirectoryHandle, path, depth + 1)
    }
  }
  await visit(dirHandle, '', 0)
  return sourceInventoryFromFilesV1(files, { truncated })
}

async function inventoryFromFileSystemEntry(dirEntry: FileSystemDirectoryEntry): Promise<SourceInventoryV1> {
  const files: [string, File][] = []
  let truncated = false
  const readDir = (entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      const reader = entry.createReader()
      const entries: FileSystemEntry[] = []
      const readBatch = (): void => {
        reader.readEntries((batch) => {
          if (batch.length === 0) resolve(entries)
          else {
            entries.push(...batch)
            readBatch()
          }
        }, reject)
      }
      readBatch()
    })
  const getFile = (entry: FileSystemFileEntry): Promise<File> =>
    new Promise((resolve, reject) => entry.file(resolve, reject))
  const visit = async (directory: FileSystemDirectoryEntry, prefix: string, depth: number): Promise<void> => {
    if (depth > 12) {
      truncated = true
      return
    }
    for (const entry of await readDir(directory)) {
      if (files.length >= MAX_SOURCE_INVENTORY_ENTRIES_V1) {
        truncated = true
        return
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isFile) files.push([path, await getFile(entry as FileSystemFileEntry)])
      else await visit(entry as FileSystemDirectoryEntry, path, depth + 1)
    }
  }
  await visit(dirEntry, '', 0)
  return sourceInventoryFromFilesV1(files, { truncated })
}
