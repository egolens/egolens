/**
 * Type declarations for upng-js — lightweight PNG encoder/decoder.
 *
 * Used for camera_segmentation: Waymo encodes panoptic labels as uint16 PNG
 * images. Browser's native createImageBitmap() downcasts to 8-bit, losing
 * the instance ID precision. upng-js preserves the full bit depth.
 */
declare module 'upng-js' {
  interface Image {
    width: number
    height: number
    depth: number // bits per channel (1, 2, 4, 8, 16)
    ctype: number // color type (0=grayscale, 2=RGB, 3=indexed, 4=gray+alpha, 6=RGBA)
    tabs: Record<string, unknown>
    frames: Array<{
      rect: { x: number; y: number; width: number; height: number }
      delay: number
      dispose: number
      blend: number
    }>
    /** Raw pixel data buffer. For 16-bit depth, each channel is 2 bytes (big-endian). */
    data: ArrayBuffer
  }

  /** Decode a PNG file. Returns metadata + raw pixel buffer. */
  function decode(buffer: ArrayBuffer): Image

  /**
   * Decode and convert to 8-bit RGBA regardless of source depth.
   * Returns an ArrayBuffer of width×height×4 bytes.
   */
  function toRGBA8(img: Image): ArrayBuffer[]

  /** Encode RGBA frames into a PNG (or APNG if multiple frames). */
  function encode(
    imgs: ArrayBuffer[],
    w: number,
    h: number,
    cnum: number,
    dels?: number[],
    forbidPlte?: boolean,
  ): ArrayBuffer
}
