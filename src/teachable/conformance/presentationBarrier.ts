export interface CameraViewQueryRootV1 {
  querySelector(selector: string): Element | null
}

/**
 * True only after every requested camera JPEG has decoded and its view has
 * committed the requested frame. Store state alone is insufficient because
 * the camera panel intentionally keeps the previous blob URL visible while a
 * replacement image decodes.
 */
export function areCameraViewsPresentedV1(
  cameraIds: Iterable<number>,
  frameIndex: number,
  root: CameraViewQueryRootV1 = document,
): boolean {
  const ids = [...cameraIds]
  if (ids.length === 0) return false
  return ids.every((cameraId) => (
    root.querySelector(`[data-egolens-camera-id="${cameraId}"]`)
      ?.getAttribute('data-egolens-camera-frame-index') === String(frameIndex)
  ))
}
