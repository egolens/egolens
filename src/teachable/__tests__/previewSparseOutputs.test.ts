import { describe, expect, it } from 'vitest'
import { graphOutputTimestampsV1, sparseOutputDiagnosticsV1 } from '../authoring/BrowserGraphPreviewRuntime'

describe('sparse output observability', () => {
  const timestampsMicros = Array.from({ length: 10 }, (_, index) => 1_000_000n + BigInt(index) * 100_000n)

  it('names the timeline frames that carry an output missing from every sampled frame', () => {
    const outputs = new Map<string, unknown>([
      ['lidarSegmentation', { kind: 'range-image-segmentation-plan', availableTimestamps: new Set([timestampsMicros[2], timestampsMicros[7]]) }],
      ['cameraSegmentation', { kind: 'camera-segmentation', byTimestamp: new Map([[timestampsMicros[4], [{}]], [timestampsMicros[6], []]]) }],
      ['boxes3d', { kind: 'boxes3d', byTimestamp: new Map(timestampsMicros.map((timestamp) => [timestamp, [{}]])) }],
    ])
    const diagnostics = sparseOutputDiagnosticsV1({
      outputs, timelineUnit: 'us', timestampsMicros, sampledFrames: [0, 5, 9],
      capabilitySamples: {
        timeline: [1, 1, 1], lidarSegmentation: [0, 0, 0], cameraSegmentation: [0, 0, 0], boxes3d: [3, 2, 1], pointClouds: [10, 10, 10],
      },
    })
    expect(diagnostics.map((entry) => entry.source)).toEqual(['lidarSegmentation', 'cameraSegmentation'])
    expect(diagnostics.every((entry) => entry.severity === 'info' && entry.code === 'OUTPUT_ABSENT_ON_SAMPLED_FRAMES')).toBe(true)
    expect(diagnostics[0].hint).toContain('2 of 10 timeline frames, for example [2, 7]')
    // Empty record lists do not count as presence.
    expect(diagnostics[1].hint).toContain('1 of 10 timeline frames, for example [4]')
  })

  it('converts source timestamp units and reports outputs without any index', () => {
    const outputs = new Map<string, unknown>([
      ['keypoints3d', { kind: 'keypoints', byTimestamp: new Map([[timestampsMicros[3] * 1_000n, [{}]]]) }],
      ['cameraImages', { kind: 'parquet-camera-plan' }],
    ])
    const diagnostics = sparseOutputDiagnosticsV1({
      outputs, timelineUnit: 'ns', timestampsMicros, sampledFrames: [0],
      capabilitySamples: { keypoints3d: [0], cameraImages: [0] },
    })
    expect(diagnostics[0].hint).toContain('for example [3]')
    expect(diagnostics[1].hint).toContain('exposes no timestamp index')
    expect(graphOutputTimestampsV1(null)).toBeNull()
    expect(graphOutputTimestampsV1({ kind: 'x' })).toBeNull()
  })

  it('stays silent when an output appears on at least one sampled frame', () => {
    const diagnostics = sparseOutputDiagnosticsV1({
      outputs: new Map(), timelineUnit: 'us', timestampsMicros, sampledFrames: [0, 9],
      capabilitySamples: { lidarSegmentation: [0, 4], trajectories: [0, 0] },
    })
    expect(diagnostics).toEqual([])
  })
})
