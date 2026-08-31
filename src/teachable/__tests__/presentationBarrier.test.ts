// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { areCameraViewsPresentedV1 } from '../conformance/presentationBarrier'

afterEach(() => {
  document.body.replaceChildren()
})

function addCamera(cameraId: number, frameIndex?: number) {
  const camera = document.createElement('div')
  camera.dataset.egolensCameraId = String(cameraId)
  if (frameIndex !== undefined) camera.dataset.egolensCameraFrameIndex = String(frameIndex)
  document.body.append(camera)
}

describe('camera presentation barrier', () => {
  it('requires at least one decoded camera view', () => {
    expect(areCameraViewsPresentedV1([], 4)).toBe(false)
  })

  it('rejects missing, undecoded, and stale camera views', () => {
    addCamera(2, 19)
    addCamera(3)

    expect(areCameraViewsPresentedV1([2, 3], 19)).toBe(false)
    expect(areCameraViewsPresentedV1([2], 20)).toBe(false)
    expect(areCameraViewsPresentedV1([2, 4], 19)).toBe(false)
  })

  it('accepts only when every requested camera shows the requested frame', () => {
    addCamera(2, 19)
    addCamera(3, 19)

    expect(areCameraViewsPresentedV1([2, 3], 19)).toBe(true)
  })
})
