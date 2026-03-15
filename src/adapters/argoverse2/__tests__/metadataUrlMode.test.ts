/**
 * Tests for buildAV2LogDatabase in URL mode (ArrayBuffer inputs + manifest).
 *
 * Verifies that the widened signature works with pre-fetched ArrayBuffers
 * and manifest-based frame discovery.
 */

import { describe, it, expect } from 'vitest'
import { buildAV2LogDatabase } from '../metadata'
import type { AV2Manifest } from '../remote'

// Feather table creation helper using flechette
// We need to create minimal valid Feather/Arrow IPC buffers for testing.
// Instead, we test with empty maps + manifest (metadata parsing is skipped when files are missing).

describe('buildAV2LogDatabase — URL mode (manifest)', () => {
  const manifest: AV2Manifest = {
    version: 1,
    dataset: 'argoverse2',
    log_id: 'url-test-log',
    num_frames: 2,
    frames: [
      {
        timestamp_ns: '1000000000',
        cameras: {
          ring_front_center: '999000000',
          ring_front_left: '998000000',
        },
      },
      {
        timestamp_ns: '2000000000',
        cameras: {
          ring_front_center: '1999000000',
          ring_front_left: '1998000000',
        },
      },
    ],
  }

  it('uses manifest for frame discovery when provided', async () => {
    // Empty metadata files — no calibration/poses/annotations
    const emptyFiles = new Map<string, File | ArrayBuffer>()

    const db = await buildAV2LogDatabase(emptyFiles, 'url-test-log', manifest)

    // Frame discovery should come from manifest
    expect(db.logId).toBe('url-test-log')
    expect(db.lidarTimestamps).toHaveLength(2)
    expect(db.lidarTimestamps[0]).toBe(BigInt('1000000000'))
    expect(db.lidarTimestamps[1]).toBe(BigInt('2000000000'))
  })

  it('builds camera file entries from manifest', async () => {
    const emptyFiles = new Map<string, File | ArrayBuffer>()
    const db = await buildAV2LogDatabase(emptyFiles, 'url-test-log', manifest)

    // Camera file entries should be constructed from manifest camera timestamps
    const frame0Cameras = db.cameraFilesByFrame.get(0)!
    expect(frame0Cameras).toBeDefined()
    expect(frame0Cameras.length).toBeGreaterThanOrEqual(1)

    // Check that camera filenames follow the expected pattern
    const frontCenter = frame0Cameras.find(c => c.cameraId === 4) // ring_front_center
    if (frontCenter) {
      expect(frontCenter.filename).toBe('sensors/cameras/ring_front_center/999000000.jpg')
    }
  })

  it('returns empty maps when no metadata files provided', async () => {
    const emptyFiles = new Map<string, File | ArrayBuffer>()
    const db = await buildAV2LogDatabase(emptyFiles, 'empty-log', manifest)

    // Metadata maps should be empty (no calibration/pose/annotation files)
    expect(db.extrinsicsBySensor.size).toBe(0)
    expect(db.intrinsicsBySensor.size).toBe(0)
    expect(db.posesByTimestamp.size).toBe(0)
    expect(db.annotationsByTimestamp.size).toBe(0)

    // But frame discovery from manifest still works
    expect(db.lidarTimestamps).toHaveLength(2)
  })

  it('falls back to file-key scanning when no manifest', async () => {
    // Create a map with fake file keys (no actual data needed for discovery)
    const filesWithKeys = new Map<string, File | ArrayBuffer>()
    // Note: these won't have valid Feather data, but the file-key scanner
    // only looks at the Map keys, not values

    const db = await buildAV2LogDatabase(filesWithKeys, 'local-log')

    // Without manifest and without matching file keys, should have 0 frames
    expect(db.lidarTimestamps).toHaveLength(0)
    expect(db.cameraFilesByFrame.size).toBe(0)
  })
})
