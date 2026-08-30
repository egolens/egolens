import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError('Canonical JSON rejects unpaired UTF-16 surrogates')
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Canonical JSON rejects unpaired UTF-16 surrogates')
    }
  }
}

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    assertUnicodeScalarString(value)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value !== 'object') throw new TypeError(`Canonical JSON rejects ${typeof value}`)
  return `{${Object.keys(value).sort().map((key) => {
    assertUnicodeScalarString(key)
    if (value[key] === undefined) throw new TypeError('Canonical JSON rejects undefined values')
    return `${JSON.stringify(key)}:${canonicalize(value[key])}`
  }).join(',')}}`
}

export function sha256Canonical(value) {
  return `sha256-${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

function artifactPayload(artifact) {
  const { artifactHash: _artifactHash, ...payload } = artifact
  return payload
}

export function verifyArtifact(artifact) {
  if (!artifact || artifact.kind !== 'egolens-scene-conformance' || artifact.schemaVersion !== 1) return false
  const summaryHash = sha256Canonical({
    structural: artifact.structural,
    numeric: artifact.numeric,
    perceptual: artifact.perceptual,
  })
  return summaryHash === artifact.summaryHash
    && sha256Canonical(artifactPayload(artifact)) === artifact.artifactHash
}

export function verifyBundle(bundle) {
  if (!bundle || bundle.kind !== 'egolens-hidden-oracle' || bundle.schemaVersion !== 1) return false
  const { bundleHash: _bundleHash, ...payload } = bundle
  return verifyArtifact(bundle.artifact) && sha256Canonical(payload) === bundle.bundleHash
}

function escapePointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function mismatchPaths(expected, actual, prefix, limit = 32) {
  if (canonicalize(expected) === canonicalize(actual)) return []
  const paths = []
  const visit = (left, right, path) => {
    if (paths.length >= limit) return
    if (left === undefined || right === undefined) {
      paths.push(path || '/')
      return
    }
    if (canonicalize(left) === canonicalize(right)) return
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length) && paths.length < limit; index++) {
        visit(left[index], right[index], `${path}/${index}`)
      }
      return
    }
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object'
      && !Array.isArray(left) && !Array.isArray(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
      for (const key of keys) {
        visit(left[key], right[key], `${path}/${escapePointer(key)}`)
        if (paths.length >= limit) break
      }
      return
    }
    paths.push(path || '/')
  }
  visit(expected, actual, prefix)
  return paths
}

export function judgeBundle(oracle, candidate, { judgeVersion, judgedAt = new Date().toISOString() }) {
  if (!judgeVersion) throw new Error('judgeVersion is required')
  const targetMatches = canonicalize(oracle.artifact.target) === canonicalize(candidate.target)
  const coveragePaths = mismatchPaths(oracle.artifact.coverage, candidate.coverage, '/coverage')
  const structuralPaths = mismatchPaths(oracle.artifact.structural, candidate.structural, '/structural')
  const numericPaths = mismatchPaths(oracle.artifact.numeric, candidate.numeric, '/numeric')
  const perceptualPaths = mismatchPaths(oracle.artifact.perceptual, candidate.perceptual, '/perceptual')
  const integrity = verifyBundle(oracle) && verifyArtifact(candidate)
  const checks = [
    { name: 'integrity', passed: integrity, mismatchPaths: integrity ? [] : ['/integrity'] },
    { name: 'target', passed: targetMatches, mismatchPaths: targetMatches ? [] : ['/target'] },
    { name: 'coverage', passed: coveragePaths.length === 0, mismatchPaths: coveragePaths },
    { name: 'structural', passed: structuralPaths.length === 0, mismatchPaths: structuralPaths },
    { name: 'numeric', passed: numericPaths.length === 0, mismatchPaths: numericPaths },
    { name: 'perceptual', passed: perceptualPaths.length === 0, mismatchPaths: perceptualPaths },
  ]
  const payload = {
    kind: 'egolens-oracle-judge-receipt',
    schemaVersion: 1,
    target: candidate.target,
    oracleBundleHash: oracle.bundleHash,
    oracleGeneratorCommit: oracle.provenance.generatorCommit,
    oracleLegacyRuntimeId: oracle.provenance.legacyRuntimeId,
    oracleCoverage: oracle.artifact.coverage,
    candidateArtifactHash: candidate.artifactHash,
    judgeVersion,
    judgedAt,
    checks,
    passed: checks.every((check) => check.passed),
  }
  return { ...payload, receiptHash: sha256Canonical(payload) }
}

export function signReceipt(receipt, privateKeyPem, signingKeyId) {
  if (!signingKeyId) throw new Error('signingKeyId is required')
  const signature = sign(null, Buffer.from(canonicalize(receipt)), createPrivateKey(privateKeyPem)).toString('base64')
  return {
    ...receipt,
    signingKeyId,
    signatureAlgorithm: 'Ed25519',
    signature,
  }
}

export function verifySignedReceipt(receipt, publicKeyPem, expectedKeyId) {
  if (!receipt || receipt.kind !== 'egolens-oracle-judge-receipt' || receipt.schemaVersion !== 1) return false
  const { signingKeyId, signatureAlgorithm, signature, ...unsigned } = receipt
  if (signatureAlgorithm !== 'Ed25519' || !signature || signingKeyId !== expectedKeyId) return false
  const { receiptHash: _receiptHash, ...hashPayload } = unsigned
  if (sha256Canonical(hashPayload) !== unsigned.receiptHash) return false
  return verify(
    null,
    Buffer.from(canonicalize(unsigned)),
    createPublicKey(publicKeyPem),
    Buffer.from(signature, 'base64'),
  )
}
