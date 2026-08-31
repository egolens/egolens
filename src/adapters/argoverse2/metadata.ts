import { argoverse2Recipe } from './manifest'

/** Transport-only AV2 hosting manifest retained until SourceCatalogV1 replaces it in 10.P5. */
export interface AV2Manifest {
  version: 1
  dataset: 'argoverse2'
  log_id: string
  num_frames: number
  frames: AV2ManifestFrame[]
}

export interface AV2ManifestFrame {
  readonly timestamp_ns: string
  readonly cameras: Record<string, string>
}

/** Content-blind path discovery used by the legacy URL host, never scene execution. */
export function discoverAV2FramesFromManifest(
  manifest: AV2Manifest,
  sensorNameToId: Readonly<Record<string, number>>,
  ringCameraNames: readonly string[],
): {
  lidarTimestamps: bigint[]
  cameraFilesByFrame: Map<number, { cameraId: number; filename: string }[]>
} {
  const lidarTimestamps = manifest.frames.map((frame) => BigInt(frame.timestamp_ns))
  const cameraFilesByFrame = new Map<number, { cameraId: number; filename: string }[]>()
  const maxDelta = BigInt(argoverse2Recipe.pipelines.cameraImages.nodes[0].params?.maxDeltaNs as number)
  for (let frameIndex = 0; frameIndex < manifest.frames.length; frameIndex += 1) {
    const frame = manifest.frames[frameIndex]
    const images: { cameraId: number; filename: string }[] = []
    for (const camera of ringCameraNames) {
      const cameraId = sensorNameToId[camera]
      const timestamp = frame.cameras[camera]
      if (cameraId === undefined || !timestamp) continue
      const cameraTimestamp = BigInt(timestamp)
      const delta = cameraTimestamp >= lidarTimestamps[frameIndex]
        ? cameraTimestamp - lidarTimestamps[frameIndex]
        : lidarTimestamps[frameIndex] - cameraTimestamp
      if (delta <= maxDelta) images.push({ cameraId, filename: `sensors/cameras/${camera}/${timestamp}.jpg` })
    }
    cameraFilesByFrame.set(frameIndex, images)
  }
  return { lidarTimestamps, cameraFilesByFrame }
}
