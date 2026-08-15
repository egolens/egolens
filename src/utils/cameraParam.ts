/**
 * Resolve the `camera=` URL parameter to a camera id.
 *
 * Three names have accumulated around this one idea:
 *   `cam=<id>`      — numeric, what Share links write, applied since forever
 *   `camera=<name>` — documented as "initial camera POV", parsed, and until
 *                     now never applied by anything
 *   `cameras=all|false` — a different axis entirely (strip visibility)
 *
 * `camera` is the human-writable spelling of `cam`, so it accepts whatever a
 * person would plausibly type: the panel label (`FRONT`, `REAR LEFT`), the
 * dataset's own channel name (`ring_front_center`, `CAM_FRONT`), the short
 * POV label, or the numeric id. Matching ignores case, spaces, underscores
 * and hyphens, which is what makes `REAR LEFT`, `rear_left` and `rear-left`
 * the same request.
 *
 * Resolution needs the active dataset's manifest, so it happens after load —
 * URL parsing runs before any dataset exists.
 */

import type { DatasetManifest } from '../types/dataset'

/** Lowercase, drop everything that is not a letter or digit. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * @returns the camera id, or null when the input matches no camera in this
 *   dataset (the caller warns; an unknown camera must never fail a load).
 */
export function resolveCameraParam(
  input: string,
  manifest: Pick<DatasetManifest, 'cameraSensors' | 'cameraPovLabels' | 'cameraAliases'>,
): number | null {
  const wanted = normalize(input)
  if (wanted.length === 0) return null

  // A bare number is the `cam=` spelling — accept it, but only if it names a
  // camera this dataset actually has
  if (/^\d+$/.test(input.trim())) {
    const id = Number(input.trim())
    return manifest.cameraSensors.some((c) => c.id === id) ? id : null
  }

  for (const cam of manifest.cameraSensors) {
    if (normalize(cam.label) === wanted) return cam.id
    const pov = manifest.cameraPovLabels[cam.id]
    if (pov && normalize(pov) === wanted) return cam.id
  }

  for (const [name, id] of Object.entries(manifest.cameraAliases ?? {})) {
    if (normalize(name) === wanted && manifest.cameraSensors.some((c) => c.id === id)) return id
  }

  return null
}
