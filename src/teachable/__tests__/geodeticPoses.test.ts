import { describe, expect, it } from 'vitest'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'
import type { GraphPoseTimelineV1 } from '../runtime/GraphValues'

const geodetic = coreGraphOperatorImplementationsV1['geometry.geodetic_poses']!
const round = (values: ArrayLike<number>) => [...values].map((value) => { const r = Math.round(value * 1000) / 1000; return r === 0 ? 0 : r })

describe('geometry.geodetic_poses', () => {
  it('turns GPS fixes with heading into a pose timeline based on the first fix', async () => {
    // Heading north (yaw 90° from east) and driving 10 m north, then turning to face east.
    const rows = [
      { ts: 0, lat: 49.0, lon: 8.4, alt: 100, roll: 0, pitch: 0, yaw: 90 },
      { ts: 100_000, lat: 49.0 + 10 / 6_378_137 * 180 / Math.PI, lon: 8.4, alt: 100, roll: 0, pitch: 0, yaw: 90 },
      { ts: 200_000, lat: 49.0 + 10 / 6_378_137 * 180 / Math.PI, lon: 8.4, alt: 101, roll: 0, pitch: 0, yaw: 0 },
    ]
    const result = (await geodetic({ rows: { kind: 'records', rows } }, {
      timestampField: 'ts', latitudeField: 'lat', longitudeField: 'lon', altitudeField: 'alt', rollField: 'roll', pitchField: 'pitch', yawField: 'yaw', angleUnit: 'degrees',
    }, {} as never)).poses as GraphPoseTimelineV1
    expect(result.kind).toBe('pose-timeline')
    expect([...result.worldFromEgoByTimestamp.keys()]).toEqual([0n, 100000n, 200000n])
    expect(round(result.worldFromEgoByTimestamp.get(0n)!)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    // 10 m straight ahead in the first pose's frame, same heading.
    expect(round(result.worldFromEgoByTimestamp.get(100000n)!)).toEqual([1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    // Turned 90° clockwise (toward east) and climbed 1 m.
    expect(round(result.worldFromEgoByTimestamp.get(200000n)!)).toEqual([0, 1, 0, 10, -1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1])
  })

  it('is registered with the public contract and requires the position and heading fields', () => {
    const operator = bundledPhase2OperatorRegistry.list().find((entry) => entry.name === 'geometry.geodetic_poses')!
    expect(JSON.stringify(operator.paramsContract)).toMatch(/"required":\["timestampField","latitudeField","longitudeField","yawField"\]/u)
  })
})
