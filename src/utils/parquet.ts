/**
 * Parquet file loading utilities for Waymo Open Dataset v2.0.
 *
 * Two access modes:
 * 1. File API (drag & drop) → AsyncBuffer from File.slice()
 * 2. Static URL (Vite dev server) → AsyncBuffer from fetch + Range Requests
 *
 * Heavy files (camera_image, lidar, lidar_camera_projection, lidar_pose)
 * use lazy per-frame loading via row-range reads.
 * Light files (<2MB) are loaded fully at startup.
 */

import {
  parquetMetadataAsync,
  parquetReadObjects,
  asyncBufferFromUrl,
  cachedAsyncBuffer,
  type AsyncBuffer,
  type FileMetaData,
} from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type { ParquetRow } from './merge'

// ---------------------------------------------------------------------------
// AsyncBuffer from File (drag & drop)
// ---------------------------------------------------------------------------

/**
 * Create an AsyncBuffer backed by a browser File object.
 * Uses File.slice() for zero-copy byte-range reads.
 */
export function asyncBufferFromFile(file: File): AsyncBuffer {
  return {
    byteLength: file.size,
    slice(start: number, end?: number): Promise<ArrayBuffer> {
      return file.slice(start, end).arrayBuffer()
    },
  }
}

// ---------------------------------------------------------------------------
// WaymoParquetFile — wrapper around a single Parquet file
// ---------------------------------------------------------------------------

export interface WaymoParquetFile {
  /** Component name (e.g. 'lidar', 'camera_image') */
  component: string
  /** The underlying async buffer */
  buffer: AsyncBuffer
  /** Parsed Parquet metadata (footer) — row groups, schema, etc. */
  metadata: FileMetaData
  /** Total number of rows */
  numRows: number
  /** Row group boundaries: [{ rowStart, rowEnd }] */
  rowGroups: Array<{ rowStart: number; rowEnd: number; numRows: number }>
}

/**
 * Open a Parquet file and parse its metadata.
 * This reads only the footer (a few KB), NOT the data.
 *
 * @param source - File object (drag & drop), URL string (static serving),
 *                 or pre-built AsyncBuffer (Node.js testing)
 */
export async function openParquetFile(
  component: string,
  source: File | string | AsyncBuffer,
): Promise<WaymoParquetFile> {
  let rawBuffer: AsyncBuffer
  if (source instanceof File) {
    rawBuffer = asyncBufferFromFile(source)
  } else if (typeof source === 'string') {
    rawBuffer = await asyncBufferFromUrl({ url: source })
  } else {
    // Pre-built AsyncBuffer (e.g. from hyparquet/node in tests)
    rawBuffer = source
  }

  // Cache repeated reads (e.g. metadata + first row group in same region)
  const buffer = cachedAsyncBuffer(rawBuffer)
  const metadata = await parquetMetadataAsync(buffer)

  // Build row group index
  let offset = 0
  const rowGroups = metadata.row_groups.map((rg) => {
    const numRows = Number(rg.num_rows)
    const group = { rowStart: offset, rowEnd: offset + numRows, numRows }
    offset += numRows
    return group
  })

  return {
    component,
    buffer,
    metadata,
    numRows: offset,
    rowGroups,
  }
}

// ---------------------------------------------------------------------------
// Reading: full load vs lazy load
// ---------------------------------------------------------------------------

/**
 * Read ALL rows from a Parquet file.
 * Use for small files (<2MB): vehicle_pose, lidar_box, calibrations, etc.
 */
export async function readAllRows(
  pf: WaymoParquetFile,
  columns?: string[],
  options?: { utf8?: boolean },
): Promise<ParquetRow[]> {
  return parquetReadObjects({
    file: pf.buffer,
    metadata: pf.metadata,
    columns,
    compressors,
    rowFormat: 'object',
    ...(options?.utf8 === false ? { utf8: false } : {}),
  })
}

/**
 * Read a specific row range from a Parquet file.
 * Use for heavy files: camera_image, lidar, lidar_camera_projection, lidar_pose.
 *
 * hyparquet internally reads only the row groups that overlap the requested range.
 */
export async function readRowRange(
  pf: WaymoParquetFile,
  rowStart: number,
  rowEnd: number,
  columns?: string[],
  options?: { utf8?: boolean },
): Promise<ParquetRow[]> {
  return parquetReadObjects({
    file: pf.buffer,
    metadata: pf.metadata,
    columns,
    compressors,
    rowStart,
    rowEnd,
    rowFormat: 'object',
    utf8: options?.utf8,
  })
}

// ---------------------------------------------------------------------------
// Row-group-level batch reading
// ---------------------------------------------------------------------------

/**
 * Read ALL rows from a specific row group.
 *
 * Parquet decompresses an entire row group in one pass anyway, so reading
 * all 256 rows from RG costs the same as reading 5 rows.
 * By caching every frame from the RG we eliminate 50× decompression waste.
 */
export async function readRowGroupRows(
  pf: WaymoParquetFile,
  rowGroupIndex: number,
  columns?: string[],
  options?: { utf8?: boolean },
): Promise<ParquetRow[]> {
  const rg = pf.rowGroups[rowGroupIndex]
  if (!rg) return []
  return readRowRange(pf, rg.rowStart, rg.rowEnd, columns, options)
}

// ---------------------------------------------------------------------------
// Frame-level access helpers
// ---------------------------------------------------------------------------

/**
 * Build a frame index from the master timestamp list (vehicle_pose).
 * Returns a sorted array of timestamps and a Map for O(1) frame lookup.
 */
export function buildFrameIndex(
  poseRows: ParquetRow[],
): {
  timestamps: bigint[]
  frameByTimestamp: Map<bigint, number>
} {
  const timestamps = poseRows
    .map((row) => row['key.frame_timestamp_micros'] as bigint)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const frameByTimestamp = new Map<bigint, number>()
  timestamps.forEach((ts, i) => frameByTimestamp.set(ts, i))

  return { timestamps, frameByTimestamp }
}

/**
 * For a heavy file, find which rows correspond to a given frame timestamp.
 *
 * Strategy: if the file has a known row structure (e.g. camera_image has
 * 5 rows per frame), we can compute the row range directly.
 * Otherwise, we need to scan the timestamp column — but this only needs
 * to be done once at startup by reading just the key columns.
 */
export interface FrameRowIndex {
  /** Map from frame timestamp → { rowStart, rowEnd } in the heavy file */
  byTimestamp: Map<bigint, { rowStart: number; rowEnd: number }>
}

/**
 * Build a frame-to-row mapping for a heavy Parquet file.
 * Reads ONLY the key columns (tiny: just timestamps + sensor names),
 * not the actual data columns.
 */
export async function buildHeavyFileFrameIndex(
  pf: WaymoParquetFile,
): Promise<FrameRowIndex> {
  // Read only key columns — this is small even for 995 rows
  const keyRows = await readAllRows(pf, [
    'key.segment_context_name',
    'key.frame_timestamp_micros',
  ])

  const byTimestamp = new Map<bigint, { rowStart: number; rowEnd: number }>()

  for (let i = 0; i < keyRows.length; i++) {
    const ts = keyRows[i]['key.frame_timestamp_micros'] as bigint
    const existing = byTimestamp.get(ts)
    if (existing) {
      // Expand range (multiple sensors per frame)
      existing.rowEnd = i + 1
    } else {
      byTimestamp.set(ts, { rowStart: i, rowEnd: i + 1 })
    }
  }

  return { byTimestamp }
}

/**
 * Read frame data from a heavy file using the pre-built frame index.
 */
export async function readFrameData(
  pf: WaymoParquetFile,
  frameIndex: FrameRowIndex,
  timestamp: bigint,
  columns?: string[],
): Promise<ParquetRow[]> {
  const range = frameIndex.byTimestamp.get(timestamp)
  if (!range) return []
  return readRowRange(pf, range.rowStart, range.rowEnd, columns)
}

// ---------------------------------------------------------------------------
// Waymo component classification
// ---------------------------------------------------------------------------

/** Components that should be lazy-loaded per frame */
export const HEAVY_COMPONENTS = new Set([
  'camera_image',
  'lidar',
  'lidar_pose',
])

/** Check if a component needs lazy loading */
export function isHeavyComponent(component: string): boolean {
  return HEAVY_COMPONENTS.has(component)
}
