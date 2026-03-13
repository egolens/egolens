/**
 * Camera Worker Pool — now a thin alias over the generic WorkerPool.
 *
 * Kept as a separate module for backward compatibility. New code should
 * use `WorkerPool<TInitPayload, CameraBatchResult>` directly.
 */

import { WorkerPool } from './workerPool'
import type { CameraBatchResult } from './types'

// Re-export the generic pool typed for camera usage
export { WorkerPool as CameraWorkerPool }

/** Legacy init options — callers should migrate to inline payload types */
export interface CameraPoolInitOptions {
  cameraUrl: string | File
}

/**
 * Convenience factory: creates a WorkerPool pre-typed for camera batch results.
 */
export function createCameraWorkerPool(
  concurrency: number,
  workerFactory: () => Worker,
): WorkerPool<Record<string, unknown>, CameraBatchResult> {
  return new WorkerPool<Record<string, unknown>, CameraBatchResult>(concurrency, workerFactory)
}
