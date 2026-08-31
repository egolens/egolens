import { describe, expect, it } from 'vitest'
import { AV2_RING_CAMERA_NAMES, AV2_SENSOR_NAME_TO_ID } from '../manifest'
import { discoverAV2FramesFromManifest, type AV2Manifest } from '../metadata'

describe('AV2 transport-only manifest discovery', () => {
  const manifest: AV2Manifest = {
    version: 1,
    dataset: 'argoverse2',
    log_id: 'url-test-log',
    num_frames: 2,
    frames: [
      { timestamp_ns: '1000000000', cameras: { ring_front_center: '999000000', ring_front_left: '998000000' } },
      { timestamp_ns: '2000000000', cameras: { ring_front_center: '1999000000', ring_front_left: '1998000000' } },
    ],
  }

  it('enumerates unchanged lidar and camera paths without parsing payloads', () => {
    const discovered = discoverAV2FramesFromManifest(manifest, AV2_SENSOR_NAME_TO_ID, AV2_RING_CAMERA_NAMES)
    expect(discovered.lidarTimestamps).toEqual([1_000_000_000n, 2_000_000_000n])
    expect(discovered.cameraFilesByFrame.get(0)).toContainEqual({
      cameraId: 4, filename: 'sensors/cameras/ring_front_center/999000000.jpg',
    })
  })

  it('omits camera samples outside the recipe-declared join tolerance', () => {
    const outside: AV2Manifest = {
      ...manifest,
      frames: [{ timestamp_ns: '1000000000', cameras: { ring_front_center: '900000000' } }],
      num_frames: 1,
    }
    expect(discoverAV2FramesFromManifest(outside, AV2_SENSOR_NAME_TO_ID, AV2_RING_CAMERA_NAMES).cameraFilesByFrame.get(0)).toEqual([])
  })
})
