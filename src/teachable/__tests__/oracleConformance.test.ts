import { describe, expect, it, vi } from 'vitest'
import {
  captureSceneConformanceArtifactV1,
  createOracleBundleV1,
  sha256CanonicalJsonV1,
  verifyOracleBundleV1,
  verifySceneConformanceArtifactV1,
  type PerceptualReferenceV1,
  type SceneConformanceArtifactV1,
} from '../conformance/oracleArtifacts'
import {
  judgeSceneConformanceV1,
  verifyOracleJudgeReceiptHashV1,
} from '../conformance/oracleJudge'
import type {
  NormalizedCapabilityV1,
  NormalizedFrameV1,
  NormalizedSceneV1,
} from '../runtime/normalizedScene'

const PERCEPTUAL: PerceptualReferenceV1 = {
  id: 'front-camera-frame-0',
  sha256: `sha256-${'a'.repeat(64)}`,
  width: 320,
  height: 180,
}

const PRODUCER_COMMIT = 'a42f658e27fce118789d3648e2612f5d25b99488'
const SOURCE_FINGERPRINT = `sha256-${'c'.repeat(64)}`

function makeScene(value = 1, dispose = vi.fn()): NormalizedSceneV1 {
  const frame: NormalizedFrameV1 = {
    index: 0,
    timestampMicros: 100n,
    worldFromEgo: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    pointClouds: [{
      sensorId: 'top',
      frameId: 'ego',
      values: new Float32Array([value, 2, 3]),
      pointCount: 1,
      stride: 3,
      attributes: ['x', 'y', 'z'],
    }],
    radarPointClouds: [],
    cameraImages: [],
    boxes3d: [],
    boxes2d: [],
    keypoints3d: [],
    keypoints2d: [],
    lidarSegmentation: [],
    cameraSegmentation: [],
  }
  return {
    manifest: {
      id: 'implementation-private-id',
      name: 'Implementation-private name',
      nominalFrameRate: 10,
      sensors: [{ id: 'top', rendererId: 1, label: 'TOP', modality: 'lidar', frameId: 'ego', color: '#ffffff' }],
      taxonomies: [],
      pointAttributes: [
        { id: 'x', storage: 'float32' },
        { id: 'y', storage: 'float32' },
        { id: 'z', storage: 'float32' },
      ],
      pointLayout: { interleavedAttributes: ['x', 'y', 'z'], colorModes: ['distance'] },
      capabilities: new Set<NormalizedCapabilityV1>(['timeline', 'pointClouds']),
    },
    index: { timestampsMicros: [100n], segments: [{ id: 'private-segment-id', firstFrame: 0, frameCount: 1 }] },
    relations: {
      staticTransforms: [],
      cameraCalibrations: new Map(),
      trajectories: new Map(),
      box2dToBox3d: new Map(),
    },
    loadFrame: async () => frame,
    dispose,
  }
}

async function capture(
  value = 1,
  options: {
    requiredCapabilities?: readonly NormalizedCapabilityV1[]
    perceptualReferences?: readonly PerceptualReferenceV1[]
    dispose?: ReturnType<typeof vi.fn>
  } = {},
): Promise<SceneConformanceArtifactV1> {
  return captureSceneConformanceArtifactV1(
    async () => makeScene(value, options.dispose),
    {
      datasetId: 'waymo',
      caseId: 'fixture-case',
      provenance: {
        generatorCommit: PRODUCER_COMMIT,
        runtimeId: 'legacy-test-build',
        sourceFingerprint: SOURCE_FINGERPRINT,
        capturedAt: '2026-08-30T00:00:00.000Z',
      },
      requiredCapabilities: options.requiredCapabilities ?? ['timeline', 'pointClouds'],
      frameIndices: [0],
      sampleValuesPerBuffer: 3,
      perceptualReferences: options.perceptualReferences ?? [PERCEPTUAL],
    },
  )
}

async function bundle(artifact: SceneConformanceArtifactV1) {
  return createOracleBundleV1(artifact, {
    generatorCommit: PRODUCER_COMMIT,
    legacyRuntimeId: 'legacy-test-build',
    sourceFingerprint: SOURCE_FINGERPRINT,
    generatedAt: '2026-08-30T00:00:00.000Z',
  })
}

describe('hidden oracle conformance artifacts', () => {
  it('uses the same canonical hash contract as the isolated Node judge', async () => {
    expect(await sha256CanonicalJsonV1({ z: [3, '한글', true], a: { n: null, value: 1.25 } }))
      .toBe('sha256-9fd43762a11e86d2c326684ff7e8bb29beaf2b394d60315a84b4fd6dbd37b991')
  })

  it('captures deterministic observations and always disposes the scene', async () => {
    const dispose = vi.fn()
    const first = await capture(1, { dispose })
    const second = await capture(1)

    expect(first).toEqual(second)
    expect(dispose).toHaveBeenCalledOnce()
    expect(await verifySceneConformanceArtifactV1(first)).toBe(true)
    const oracle = await bundle(first)
    expect(await verifyOracleBundleV1(oracle)).toBe(true)
  })

  it('returns a valid receipt without returning hidden expected values', async () => {
    const oracle = await bundle(await capture())
    const receipt = await judgeSceneConformanceV1(oracle, await capture(), {
      judgeVersion: 'test-v1',
      judgedAt: '2026-08-30T01:00:00.000Z',
    })

    expect(receipt.passed).toBe(true)
    expect(receipt.candidateGeneratorCommit).toBe(PRODUCER_COMMIT)
    expect(receipt.checks).toHaveLength(6)
    expect(await verifyOracleJudgeReceiptHashV1(receipt)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain('samples')
    expect(receipt).not.toHaveProperty('structural')
    expect(receipt).not.toHaveProperty('numeric')
    expect(receipt).not.toHaveProperty('perceptual')
  })

  it('detects numeric and perceptual drift using mismatch pointers only', async () => {
    const oracle = await bundle(await capture())
    const changedPerceptual = { ...PERCEPTUAL, sha256: `sha256-${'b'.repeat(64)}` }
    const receipt = await judgeSceneConformanceV1(
      oracle,
      await capture(9, { perceptualReferences: [changedPerceptual] }),
      { judgeVersion: 'test-v1', judgedAt: '2026-08-30T01:00:00.000Z' },
    )

    expect(receipt.passed).toBe(false)
    expect(receipt.checks.find((check) => check.name === 'numeric')).toMatchObject({ passed: false })
    expect(receipt.checks.find((check) => check.name === 'perceptual')).toMatchObject({ passed: false })
    expect(receipt.checks.flatMap((check) => check.mismatchPaths)).toContain('/perceptual/0/sha256')
    expect(receipt.checks.flatMap((check) => check.mismatchPaths).some((path) => path.startsWith('/numeric/'))).toBe(true)
  })

  it('rejects tampering and insufficient coverage', async () => {
    const oracle = await bundle(await capture())
    const candidate = await capture(1, { requiredCapabilities: ['timeline'] })
    const tampered = {
      ...candidate,
      artifactHash: `sha256-${'0'.repeat(64)}`,
    }
    const receipt = await judgeSceneConformanceV1(oracle, tampered, {
      judgeVersion: 'test-v1',
      judgedAt: '2026-08-30T01:00:00.000Z',
    })

    expect(receipt.passed).toBe(false)
    expect(receipt.checks.find((check) => check.name === 'integrity')).toMatchObject({ passed: false })
    expect(receipt.checks.find((check) => check.name === 'coverage')).toMatchObject({ passed: false })
  })

  it('rejects a candidate captured from a different source case', async () => {
    const oracle = await bundle(await capture())
    const candidate = await capture()
    const changed = {
      ...candidate,
      provenance: {
        ...candidate.provenance,
        sourceFingerprint: `sha256-${'d'.repeat(64)}`,
      },
    }
    const rehashed = {
      ...changed,
      artifactHash: await sha256CanonicalJsonV1(JSON.parse(JSON.stringify((({ artifactHash: _, ...value }) => value)(changed)))),
    }
    const receipt = await judgeSceneConformanceV1(oracle, rehashed, {
      judgeVersion: 'test-v1',
      judgedAt: '2026-08-30T01:00:00.000Z',
    })

    expect(receipt.checks.find((check) => check.name === 'target')).toMatchObject({ passed: false })
  })
})
