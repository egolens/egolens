import { describe, expect, it } from 'vitest'
import { canRenderReviewThumbnailsV1, projectPointsToCameraV1, renderReviewThumbnailV1 } from '../authoring/reviewThumbnails'
import type { NormalizedCameraCalibrationV1, NormalizedFrameV1, NormalizedPointCloudV1 } from '../runtime/normalizedScene'

// Camera at ego origin looking along +x: optical z = ego x, optical x = -ego y, optical y = -ego z.
const calibration: NormalizedCameraCalibrationV1 = {
  sensorId: 'cam', frameId: 'cam-frame', width: 400, height: 200,
  intrinsics: [100, 100, 200, 100], distortionModel: 'none', distortion: [],
  egoFromCamera: new Float64Array([0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1]),
}
const cloud = (values: number[], frameId = 'ego'): NormalizedPointCloudV1 => ({
  sensorId: 'lidar', frameId, values: new Float32Array(values), pointCount: values.length / 3, stride: 3, attributes: ['x', 'y', 'z'],
} as NormalizedPointCloudV1)

describe('review thumbnails', () => {
  it('projects ego points through the optical pinhole model and drops points behind or outside the image', () => {
    const projected = projectPointsToCameraV1([cloud([
      10, 0, 0, // straight ahead → principal point
      10, -5, 0, // to the right (ego -y) → u > cx
      10, 0, 5, // up (ego +z) → v < cy
      -10, 0, 0, // behind the camera → dropped
      1, 40, 0, // far outside the image → dropped
    ])], calibration)
    expect(projected.count).toBe(3)
    expect([...projected.u]).toEqual([200, 250, 200])
    expect([...projected.v]).toEqual([100, 100, 50])
    expect([...projected.depth]).toEqual([10, 10, 10])
  })

  it('ignores point clouds that are not expressed in the ego frame and subsamples large clouds', () => {
    expect(projectPointsToCameraV1([cloud([10, 0, 0], 'lidar-top-frame')], calibration).count).toBe(0)
    const many = Array.from({ length: 300 }, (_, index) => [10 + (index % 7), (index % 5) - 2, 0]).flat()
    expect(projectPointsToCameraV1([cloud(many)], calibration, 100).count).toBeLessThanOrEqual(100)
  })

  it('returns null instead of rasterizing when the environment has no image decoding', async () => {
    expect(canRenderReviewThumbnailsV1()).toBe(false)
    const frame = { index: 0, cameraImages: [{ sensorId: 'cam', calibrationId: 'cam', encodedBytes: new ArrayBuffer(0), mimeType: 'image/png' }], pointClouds: [] } as unknown as NormalizedFrameV1
    expect(await renderReviewThumbnailV1(frame, 'cam', new Map([['cam', calibration]]))).toBeNull()
  })
})
