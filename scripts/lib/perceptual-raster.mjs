import { createHash } from 'node:crypto'
import UPNG from 'upng-js'

const GRID_SIZE = 32
const COLOR_STEP = 4

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/**
 * Hash a stable low-frequency raster signature instead of raw compositor PNG
 * bytes. The box filter removes isolated GPU rounding noise while preserving
 * camera content, overlays, viewport geometry, and broad colour changes.
 */
export function perceptualRasterSha256V1(pngBytes) {
  const decoded = UPNG.decode(exactArrayBuffer(pngBytes))
  const frames = UPNG.toRGBA8(decoded)
  if (frames.length !== 1) throw new Error('Perceptual references must be single-frame PNGs.')
  const rgba = new Uint8Array(frames[0])
  const signature = Buffer.alloc(GRID_SIZE * GRID_SIZE * 3)
  let output = 0

  for (let gridY = 0; gridY < GRID_SIZE; gridY += 1) {
    const y0 = Math.floor(gridY * decoded.height / GRID_SIZE)
    const y1 = Math.max(y0 + 1, Math.floor((gridY + 1) * decoded.height / GRID_SIZE))
    for (let gridX = 0; gridX < GRID_SIZE; gridX += 1) {
      const x0 = Math.floor(gridX * decoded.width / GRID_SIZE)
      const x1 = Math.max(x0 + 1, Math.floor((gridX + 1) * decoded.width / GRID_SIZE))
      const sums = [0, 0, 0]
      let count = 0
      for (let y = y0; y < Math.min(y1, decoded.height); y += 1) {
        for (let x = x0; x < Math.min(x1, decoded.width); x += 1) {
          const pixel = (y * decoded.width + x) * 4
          sums[0] += rgba[pixel]
          sums[1] += rgba[pixel + 1]
          sums[2] += rgba[pixel + 2]
          count += 1
        }
      }
      for (const sum of sums) signature[output++] = Math.round((sum / count) / COLOR_STEP)
    }
  }

  const digest = createHash('sha256')
    .update(`egolens-perceptual-raster-v1\0${decoded.width}x${decoded.height}\0`)
    .update(signature)
    .digest('hex')
  return `sha256-${digest}`
}
