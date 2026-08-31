import { createHash } from 'node:crypto'
import UPNG from 'upng-js'

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function perceptualRasterSha256(pngBytes, { version, gridSize, colorStep, integerAverage }) {
  const decoded = UPNG.decode(exactArrayBuffer(pngBytes))
  const frames = UPNG.toRGBA8(decoded)
  if (frames.length !== 1) throw new Error('Perceptual references must be single-frame PNGs.')
  const rgba = new Uint8Array(frames[0])
  const signature = Buffer.alloc(gridSize * gridSize * 3)
  let output = 0

  for (let gridY = 0; gridY < gridSize; gridY += 1) {
    const y0 = Math.floor(gridY * decoded.height / gridSize)
    const y1 = Math.max(y0 + 1, Math.floor((gridY + 1) * decoded.height / gridSize))
    for (let gridX = 0; gridX < gridSize; gridX += 1) {
      const x0 = Math.floor(gridX * decoded.width / gridSize)
      const x1 = Math.max(x0 + 1, Math.floor((gridX + 1) * decoded.width / gridSize))
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
      for (const sum of sums) {
        const average = sum / count
        signature[output++] = Math.round((integerAverage ? Math.round(average) : average) / colorStep)
      }
    }
  }

  const digest = createHash('sha256')
    .update(`egolens-perceptual-raster-${version}\0${decoded.width}x${decoded.height}\0`)
    .update(signature)
    .digest('hex')
  return `sha256-${digest}`
}

/**
 * Phase 6 receipt-compatible signature. Do not change this algorithm: the
 * protected oracle corpus is immutable and compares these hashes exactly.
 */
export function perceptualRasterSha256V1(pngBytes) {
  return perceptualRasterSha256(pngBytes, {
    version: 'v1', gridSize: 32, colorStep: 4, integerAverage: false,
  })
}

/**
 * Transport-parity signature for Phase 10. The wider spatial average and
 * two-stage channel quantization ignore sparse ±1 compositor rounding while
 * retaining viewport geometry, camera content, and broad overlay changes.
 */
export function perceptualRasterSha256V2(pngBytes) {
  return perceptualRasterSha256(pngBytes, {
    version: 'v2', gridSize: 16, colorStep: 4, integerAverage: true,
  })
}
