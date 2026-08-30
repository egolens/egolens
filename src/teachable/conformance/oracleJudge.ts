import { canonicalizeJson } from '../recipe/canonicalize'
import type { JsonValue } from '../recipe/types'
import {
  sha256CanonicalJsonV1,
  verifyOracleBundleV1,
  verifySceneConformanceArtifactV1,
  type OracleBundleV1,
  type SceneConformanceArtifactV1,
} from './oracleArtifacts'

export type OracleJudgeCheckNameV1 =
  | 'integrity'
  | 'target'
  | 'coverage'
  | 'structural'
  | 'numeric'
  | 'perceptual'

export interface OracleJudgeCheckV1 {
  readonly name: OracleJudgeCheckNameV1
  readonly passed: boolean
  /** JSON pointers only. Expected oracle values are never returned. */
  readonly mismatchPaths: readonly string[]
}

export interface OracleJudgeReceiptV1 {
  readonly kind: 'egolens-oracle-judge-receipt'
  readonly schemaVersion: 1
  readonly target: SceneConformanceArtifactV1['target']
  readonly oracleBundleHash: string
  readonly oracleGeneratorCommit: string
  readonly oracleLegacyRuntimeId: string
  /** Public capture declaration, not an oracle observation. */
  readonly oracleCoverage: SceneConformanceArtifactV1['coverage']
  readonly candidateArtifactHash: string
  readonly judgeVersion: string
  readonly judgedAt: string
  readonly checks: readonly OracleJudgeCheckV1[]
  readonly passed: boolean
  readonly receiptHash: string
}

export interface SignedOracleJudgeReceiptV1 extends OracleJudgeReceiptV1 {
  readonly signingKeyId: string
  readonly signatureAlgorithm: 'Ed25519'
  readonly signature: string
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function mismatchPaths(left: JsonValue, right: JsonValue, prefix: string, limit = 32): string[] {
  if (canonicalizeJson(left) === canonicalizeJson(right)) return []
  const paths: string[] = []
  const visit = (expected: JsonValue | undefined, actual: JsonValue | undefined, path: string): void => {
    if (paths.length >= limit) return
    if (expected === undefined || actual === undefined) {
      paths.push(path || '/')
      return
    }
    if (canonicalizeJson(expected) === canonicalizeJson(actual)) return
    if (Array.isArray(expected) && Array.isArray(actual)) {
      const length = Math.max(expected.length, actual.length)
      for (let index = 0; index < length && paths.length < limit; index += 1) {
        visit(expected[index], actual[index], `${path}/${index}`)
      }
      return
    }
    if (expected !== null && actual !== null
      && typeof expected === 'object' && typeof actual === 'object'
      && !Array.isArray(expected) && !Array.isArray(actual)) {
      const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
      for (const key of keys) {
        visit(expected[key], actual[key], `${path}/${escapePointer(key)}`)
        if (paths.length >= limit) break
      }
      return
    }
    paths.push(path || '/')
  }
  visit(left, right, prefix)
  return paths
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export async function verifyOracleJudgeReceiptHashV1(receipt: OracleJudgeReceiptV1): Promise<boolean> {
  const { receiptHash: _receiptHash, ...payload } = receipt
  return await sha256CanonicalJsonV1(json(payload)) === receipt.receiptHash
}

/**
 * Trusted one-shot judge. It returns only pass/fail and mismatch pointers; the
 * hidden expected values never cross into the authoring workspace.
 */
export async function judgeSceneConformanceV1(
  oracle: OracleBundleV1,
  candidate: SceneConformanceArtifactV1,
  options: { readonly judgeVersion: string; readonly judgedAt?: string },
): Promise<OracleJudgeReceiptV1> {
  if (!options.judgeVersion) throw new Error('judgeVersion is required.')
  const [oracleIntegrity, candidateIntegrity] = await Promise.all([
    verifyOracleBundleV1(oracle),
    verifySceneConformanceArtifactV1(candidate),
  ])
  const targetMatches = canonicalizeJson(json(oracle.artifact.target)) === canonicalizeJson(json(candidate.target))
  const coveragePaths = mismatchPaths(json(oracle.artifact.coverage), json(candidate.coverage), '/coverage')
  const structuralPaths = mismatchPaths(oracle.artifact.structural, candidate.structural, '/structural')
  const numericPaths = mismatchPaths(oracle.artifact.numeric, candidate.numeric, '/numeric')
  const perceptualPaths = mismatchPaths(json(oracle.artifact.perceptual), json(candidate.perceptual), '/perceptual')
  const checks: OracleJudgeCheckV1[] = [
    { name: 'integrity', passed: oracleIntegrity && candidateIntegrity, mismatchPaths: oracleIntegrity && candidateIntegrity ? [] : ['/integrity'] },
    { name: 'target', passed: targetMatches, mismatchPaths: targetMatches ? [] : ['/target'] },
    { name: 'coverage', passed: coveragePaths.length === 0, mismatchPaths: coveragePaths },
    { name: 'structural', passed: structuralPaths.length === 0, mismatchPaths: structuralPaths },
    { name: 'numeric', passed: numericPaths.length === 0, mismatchPaths: numericPaths },
    { name: 'perceptual', passed: perceptualPaths.length === 0, mismatchPaths: perceptualPaths },
  ]
  const withoutHash = {
    kind: 'egolens-oracle-judge-receipt' as const,
    schemaVersion: 1 as const,
    target: { ...candidate.target },
    oracleBundleHash: oracle.bundleHash,
    oracleGeneratorCommit: oracle.provenance.generatorCommit,
    oracleLegacyRuntimeId: oracle.provenance.legacyRuntimeId,
    oracleCoverage: {
      requiredCapabilities: [...oracle.artifact.coverage.requiredCapabilities],
      frameIndices: [...oracle.artifact.coverage.frameIndices],
      completeTimeline: oracle.artifact.coverage.completeTimeline,
      perceptualReferenceIds: [...oracle.artifact.coverage.perceptualReferenceIds],
    },
    candidateArtifactHash: candidate.artifactHash,
    judgeVersion: options.judgeVersion,
    judgedAt: options.judgedAt ?? new Date().toISOString(),
    checks,
    passed: checks.every((check) => check.passed),
  }
  return {
    ...withoutHash,
    receiptHash: await sha256CanonicalJsonV1(json(withoutHash)),
  }
}
