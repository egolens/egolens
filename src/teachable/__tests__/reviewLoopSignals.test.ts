/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest'
import { sensorSamplesV1 } from '../authoring/BrowserGraphPreviewRuntime'
import { inspectSourceInventoryV1, leadingJsonArrayRecordsV1 } from '../authoring/inspection'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import type { NormalizedFrameV1 } from '../runtime/normalizedScene'

function frame(overrides: Partial<NormalizedFrameV1>): NormalizedFrameV1 {
  return {
    index: 0, timestampMicros: 0n, worldFromEgo: null,
    pointClouds: [], radarPointClouds: [], cameraImages: [], boxes3d: [], boxes2d: [],
    keypoints3d: [], keypoints2d: [], lidarSegmentation: [], cameraSegmentation: [],
    ...overrides,
  } as NormalizedFrameV1
}

describe('review loop signals', () => {
  it('reports per-sensor evidence on the sampled frames so an unbound sensor is visible', () => {
    const frames = [
      frame({ pointClouds: [{ sensorId: 'LIDAR_TOP', pointCount: 100 } as never], cameraImages: [{ sensorId: 'CAM_FRONT' } as never] }),
      frame({ pointClouds: [{ sensorId: 'LIDAR_TOP', pointCount: 90 } as never] }),
    ]
    expect(sensorSamplesV1([
      { id: 'LIDAR_TOP', modality: 'lidar' }, { id: 'CAM_FRONT', modality: 'camera' }, { id: 'CAM_BACK', modality: 'camera' }, { id: 'RADAR_FRONT', modality: 'radar' },
    ], frames)).toEqual({ LIDAR_TOP: [100, 90], CAM_FRONT: [1, 0], CAM_BACK: [0, 0], RADAR_FRONT: [0, 0] })
  })

  it('extracts complete leading array records from a text prefix', () => {
    const text = '[{"a":1,"s":"x,]{"},{"a":2,"nested":[1,{"b":"}"}]},{"a":3'
    expect(leadingJsonArrayRecordsV1(text, 8)).toEqual({ records: [{ a: 1, s: 'x,]{' }, { a: 2, nested: [1, { b: '}' }] }], complete: false })
    expect(leadingJsonArrayRecordsV1('[1, 2, 3]', 8)).toEqual({ records: [1, 2, 3], complete: true })
    expect(leadingJsonArrayRecordsV1('[{"a":1},{"a":2},{"a":3}]', 2)).toEqual({ records: [{ a: 1 }, { a: 2 }], complete: false })
    expect(() => leadingJsonArrayRecordsV1('{"a":1}', 8)).toThrow(/top-level JSON array/u)
  })

  it('samples a JSON file larger than maxBytes through the public inspect tool', async () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ token: `t${index}`, timestamp: 1_000_000 + index, filename: `samples/LIDAR_TOP/${index}.bin` }))
    const body = JSON.stringify(rows)
    const inventory = new SourceInventoryV1([['v1.0-mini/sample_data.json', new File([body], 'sample_data.json', { lastModified: 1 })]], { sessionId: 'sample' })
    await expect(inspectSourceInventoryV1(inventory, { mode: 'json', path: 'v1.0-mini/sample_data.json', maxBytes: 4096 })).rejects.toThrow(/complete file/u)
    const result = await inspectSourceInventoryV1(inventory, { mode: 'json-sample', path: 'v1.0-mini/sample_data.json', maxBytes: 4096, maxValues: 3 })
    expect(result.truncated).toBe(true)
    expect(result.data).toMatchObject({ byteLength: body.length, recordCount: 3, records: rows.slice(0, 3) })
  })
})
