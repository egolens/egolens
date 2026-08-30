import { decodeNpzUint16V1 } from '../teachable/operators/binaryReaders'

/**
 * Compatibility wrapper for the renderer worker. The executable implementation
 * is the bounded, dataset-neutral archive.npz_array@1 operator.
 */
export function parseNpzUint16(buffer: ArrayBuffer, signal?: AbortSignal): Promise<Uint16Array> {
  return decodeNpzUint16V1(buffer, {}, signal)
}
