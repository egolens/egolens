import type { NormalizedFrameV1 } from './normalizedScene'

export interface NormalizedParityIssueV1 {
  readonly path: string
  readonly expected: unknown
  readonly actual: unknown
}

function compareNumbers(
  issues: NormalizedParityIssueV1[],
  path: string,
  expected: ArrayLike<number>,
  actual: ArrayLike<number>,
  tolerance: number,
): void {
  if (expected.length !== actual.length) {
    issues.push({ path: `${path}.length`, expected: expected.length, actual: actual.length })
    return
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (Math.abs(expected[index] - actual[index]) > tolerance) {
      issues.push({ path: `${path}[${index}]`, expected: expected[index], actual: actual[index] })
    }
  }
}

/** Deterministic structural and numeric comparison used before registry cutover. */
export function compareNormalizedFramesV1(
  expected: NormalizedFrameV1,
  actual: NormalizedFrameV1,
  tolerance = 1e-5,
): readonly NormalizedParityIssueV1[] {
  const issues: NormalizedParityIssueV1[] = []
  if (expected.index !== actual.index) issues.push({ path: 'index', expected: expected.index, actual: actual.index })
  if (expected.timestampMicros !== actual.timestampMicros) issues.push({ path: 'timestampMicros', expected: expected.timestampMicros, actual: actual.timestampMicros })
  if (expected.worldFromEgo === null || actual.worldFromEgo === null) {
    if (expected.worldFromEgo !== actual.worldFromEgo) issues.push({ path: 'worldFromEgo', expected: expected.worldFromEgo, actual: actual.worldFromEgo })
  } else {
    compareNumbers(issues, 'worldFromEgo', expected.worldFromEgo, actual.worldFromEgo, tolerance)
  }

  const compareClouds = (key: 'pointClouds' | 'radarPointClouds'): void => {
    if (expected[key].length !== actual[key].length) {
      issues.push({ path: `${key}.length`, expected: expected[key].length, actual: actual[key].length })
      return
    }
    expected[key].forEach((cloud, index) => {
      const candidate = actual[key][index]
      for (const property of ['sensorId', 'frameId', 'pointCount', 'stride'] as const) {
        if (cloud[property] !== candidate[property]) issues.push({ path: `${key}[${index}].${property}`, expected: cloud[property], actual: candidate[property] })
      }
      if (cloud.attributes.join('\0') !== candidate.attributes.join('\0')) {
        issues.push({ path: `${key}[${index}].attributes`, expected: cloud.attributes, actual: candidate.attributes })
      }
      compareNumbers(issues, `${key}[${index}].values`, cloud.values, candidate.values, tolerance)
    })
  }
  compareClouds('pointClouds')
  compareClouds('radarPointClouds')

  if (expected.cameraImages.length !== actual.cameraImages.length) issues.push({ path: 'cameraImages.length', expected: expected.cameraImages.length, actual: actual.cameraImages.length })
  if (expected.boxes3d.length !== actual.boxes3d.length) issues.push({ path: 'boxes3d.length', expected: expected.boxes3d.length, actual: actual.boxes3d.length })
  expected.boxes3d.forEach((box, index) => {
    const candidate = actual.boxes3d[index]
    if (!candidate) return
    if (box.id !== candidate.id) issues.push({ path: `boxes3d[${index}].id`, expected: box.id, actual: candidate.id })
    compareNumbers(issues, `boxes3d[${index}].center`, box.center, candidate.center, tolerance)
    compareNumbers(issues, `boxes3d[${index}].dimensions`, box.dimensions, candidate.dimensions, tolerance)
  })
  if (expected.boxes2d.length !== actual.boxes2d.length) issues.push({ path: 'boxes2d.length', expected: expected.boxes2d.length, actual: actual.boxes2d.length })
  if (expected.lidarSegmentation.length !== actual.lidarSegmentation.length) issues.push({ path: 'lidarSegmentation.length', expected: expected.lidarSegmentation.length, actual: actual.lidarSegmentation.length })
  return issues
}
