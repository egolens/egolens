import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { canonicalize } from './oracle-receipts.mjs'

export const COUNTED_BROWSER_BOUNDARY_SCHEMA = 'egolens-counted-browser-boundary-v1'
export const COUNTED_BROWSER_RUN_SCHEMA = 'egolens-counted-browser-boundary-run-v1'
export const COUNTED_BROWSER_OBSERVATION_SCHEMA = 'egolens-counted-browser-boundary-observation-v1'
export const COUNTED_BROWSER_RUNTIME = 'macos-seatbelt-deny-default'
export const COUNTED_BROWSER_NETWORK_POLICY = 'exact-app-and-source-loopback-only'
export const COUNTED_BROWSER_AMBIENT_FILE_POLICY = 'deny-except-system-runtime-and-fresh-state'
export const COUNTED_BROWSER_DEBUG_PORT_POLICY = 'chrome-selected-port-zero'
export const COUNTED_BROWSER_CHROME_REQUIREMENT = 'identifier "com.google.Chrome" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"'
export const COUNTED_BROWSER_REQUIRED_CHECKS = Object.freeze([
  'ambient-file-read-denied',
  'app-loopback-allowed',
  'external-network-denied',
  'forbidden-loopback-denied',
])

const HASH = /^sha256:[0-9a-f]{64}$/u
const CAPABILITY_PATH = /^\/access\/([0-9a-f]{64})\/(?:source\/|catalog\.json$|recipe\.json$|share\.json$)/u
const SEATBELT_PARAMETERS = Object.freeze([
  'APP_REMOTE_ENDPOINT', 'BROWSER_PROFILE', 'BROWSER_PROFILE_REAL', 'CHROME_ROOT',
  'RUNTIME_SCRATCH', 'RUNTIME_SCRATCH_REAL', 'SOURCE_REAL_ROOT',
  'SOURCE_REMOTE_ENDPOINT', 'SOURCE_ROOT', 'SYSTEM_SOCKET_REAL_ROOT', 'SYSTEM_SOCKET_ROOT',
])

export function boundaryHashV1(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

export function countedBrowserSeatbeltArgumentsV1(profile, parameters, command) {
  if (!path.isAbsolute(profile) || !Array.isArray(command) || command.length === 0
    || canonicalize(Object.keys(parameters).sort()) !== canonicalize([...SEATBELT_PARAMETERS].sort())) {
    throw new Error('Invalid counted browser Seatbelt invocation')
  }
  const definitions = Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right, 'en'))
    .flatMap(([name, value]) => {
      if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/u.test(value)) {
        throw new Error(`Invalid counted browser Seatbelt parameter: ${name}`)
      }
      return ['-D', `${name}=${value}`]
    })
  return [...definitions, '-f', profile, ...command]
}

export function endpointForOriginV1(origin) {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !url.port) {
    throw new Error('Counted browser origins must be exact 127.0.0.1 HTTP origins with explicit ports')
  }
  const port = Number(url.port)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('Counted browser origin port is outside the unprivileged TCP range')
  }
  // Seatbelt network filters accept only `*` or `localhost` as the host, so the
  // exact loopback origin is expressed as a localhost:port endpoint.
  return `localhost:${port}`
}

function protectedSourceUrl(raw, label) {
  const url = new URL(raw)
  endpointForOriginV1(url.origin)
  if (url.username || url.password || url.hash || !CAPABILITY_PATH.test(url.pathname)) {
    throw new Error(`${label} is not a capability-protected loopback source URL`)
  }
  return url
}

export function countedSourceBoundaryV1(rawAppUrl, sourceMode) {
  const appUrl = new URL(rawAppUrl)
  endpointForOriginV1(appUrl.origin)
  if (sourceMode === 'local-directory-input') {
    if (appUrl.searchParams.has('share') || appUrl.searchParams.get('shareVersion') === '1') {
      throw new Error('Local counted browser URL unexpectedly contains a portable transport')
    }
    return Object.freeze({ sourceOrigin: null, capability: null, allowedPaths: null })
  }
  if (sourceMode === 'portable-share') {
    const share = protectedSourceUrl(appUrl.searchParams.get('share') ?? '', 'share URL')
    const match = CAPABILITY_PATH.exec(share.pathname)
    if (!match || share.pathname !== `/access/${match[1]}/share.json`) {
      throw new Error('Referenced share URL is not the exact protected descriptor path')
    }
    return Object.freeze({
      sourceOrigin: share.origin,
      capability: match[1],
      allowedPaths: Object.freeze({
        share: share.pathname,
        catalog: `/access/${match[1]}/catalog.json`,
        recipe: `/access/${match[1]}/recipe.json`,
        sourceRoot: `/access/${match[1]}/source/`,
      }),
    })
  }
  if (sourceMode !== 'remote-url' || appUrl.searchParams.get('shareVersion') !== '1') {
    throw new Error('Counted remote mode requires the inline v1 transport')
  }
  const source = protectedSourceUrl(appUrl.searchParams.get('data') ?? '', 'remote source root')
  const catalog = protectedSourceUrl(appUrl.searchParams.get('catalog') ?? '', 'remote catalog URL')
  const recipe = protectedSourceUrl(appUrl.searchParams.get('recipe') ?? '', 'remote recipe URL')
  const matches = [source, catalog, recipe].map((url) => CAPABILITY_PATH.exec(url.pathname))
  const capability = matches[0]?.[1]
  if (!capability || matches.some((match) => match?.[1] !== capability)
    || source.origin !== catalog.origin || source.origin !== recipe.origin
    || source.pathname !== `/access/${capability}/source/`
    || catalog.pathname !== `/access/${capability}/catalog.json`
    || recipe.pathname !== `/access/${capability}/recipe.json`) {
    throw new Error('Inline transport does not use one exact protected source capability')
  }
  return Object.freeze({
    sourceOrigin: source.origin,
    capability,
    allowedPaths: Object.freeze({
      share: null,
      catalog: catalog.pathname,
      recipe: recipe.pathname,
      sourceRoot: source.pathname,
    }),
  })
}

export function makeBoundaryEnvironmentV1({
  profileTemplateHash,
  sourceMode,
  appOrigin,
  sourceOrigin,
  localSourceRootCommitment,
  browserBinary,
}) {
  if (!HASH.test(profileTemplateHash) || !HASH.test(localSourceRootCommitment)) {
    throw new Error('Counted browser boundary commitments are invalid')
  }
  endpointForOriginV1(appOrigin)
  if (sourceOrigin !== null) endpointForOriginV1(sourceOrigin)
  const sourceAccess = sourceMode === 'local-directory-input'
    ? 'exact-local-root-read-only'
    : 'protected-source-loopback-only'
  if ((sourceAccess === 'exact-local-root-read-only') !== (sourceOrigin === null)) {
    throw new Error('Counted browser source access and origin disagree')
  }
  validateOfficialChromeIdentityV1(browserBinary)
  const payload = {
    schema: COUNTED_BROWSER_BOUNDARY_SCHEMA,
    runtime: COUNTED_BROWSER_RUNTIME,
    enforcement: 'deny-default',
    sourceMode,
    sourceAccess,
    localSourceRootCommitment,
    appOrigin,
    sourceOrigin,
    networkPolicy: COUNTED_BROWSER_NETWORK_POLICY,
    ambientFilePolicy: COUNTED_BROWSER_AMBIENT_FILE_POLICY,
    debugPortPolicy: COUNTED_BROWSER_DEBUG_PORT_POLICY,
    profileTemplateHash,
    browserBinary,
    requiredChecks: [...COUNTED_BROWSER_REQUIRED_CHECKS],
    passed: true,
  }
  return Object.freeze({ ...payload, boundaryHash: boundaryHashV1(payload) })
}

export function validateBoundaryEnvironmentV1(boundary, expectedSourceMode = null) {
  if (!boundary || boundary.schema !== COUNTED_BROWSER_BOUNDARY_SCHEMA
    || boundary.runtime !== COUNTED_BROWSER_RUNTIME || boundary.enforcement !== 'deny-default'
    || boundary.networkPolicy !== COUNTED_BROWSER_NETWORK_POLICY
    || boundary.ambientFilePolicy !== COUNTED_BROWSER_AMBIENT_FILE_POLICY
    || boundary.debugPortPolicy !== COUNTED_BROWSER_DEBUG_PORT_POLICY
    || !HASH.test(boundary.profileTemplateHash) || !HASH.test(boundary.localSourceRootCommitment)
    || boundary.passed !== true
    || canonicalize(boundary.requiredChecks) !== canonicalize(COUNTED_BROWSER_REQUIRED_CHECKS)
    || boundary.boundaryHash !== boundaryHashV1(without(boundary, 'boundaryHash'))
    || (expectedSourceMode !== null && boundary.sourceMode !== expectedSourceMode)) {
    throw new Error('Invalid counted browser boundary environment')
  }
  endpointForOriginV1(boundary.appOrigin)
  validateOfficialChromeIdentityV1(boundary.browserBinary)
  if (boundary.sourceMode === 'local-directory-input') {
    if (boundary.sourceAccess !== 'exact-local-root-read-only' || boundary.sourceOrigin !== null) {
      throw new Error('Invalid local counted browser source boundary')
    }
  } else if (boundary.sourceAccess !== 'protected-source-loopback-only' || !boundary.sourceOrigin) {
    throw new Error('Invalid remote/share counted browser source boundary')
  } else endpointForOriginV1(boundary.sourceOrigin)
  return true
}

function httpOrigin(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:'
      ? url.origin
      : null
  } catch {
    return 'invalid:'
  }
}

export function requestAuditV1(network, boundary, sourcePaths = null) {
  validateBoundaryEnvironmentV1(boundary)
  const allowedOrigins = new Set([boundary.appOrigin, ...(boundary.sourceOrigin ? [boundary.sourceOrigin] : [])])
  const observedOrigins = new Set()
  const violations = []
  let httpRequestCount = 0
  for (const request of network) {
    const origin = httpOrigin(request?.url)
    if (origin === null) continue
    httpRequestCount += 1
    observedOrigins.add(origin)
    if (!allowedOrigins.has(origin)) {
      violations.push('origin')
      continue
    }
    const url = new URL(request.url)
    if (origin === boundary.sourceOrigin) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) || url.search || url.hash) {
        violations.push('source-request-shape')
        continue
      }
      if (sourcePaths) {
        const fixed = [sourcePaths.catalog, sourcePaths.recipe, sourcePaths.share].filter(Boolean)
        if (!fixed.includes(url.pathname) && !(sourcePaths.sourceRoot && url.pathname.startsWith(sourcePaths.sourceRoot))) {
          violations.push('source-capability-path')
        }
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Counted browser emitted disallowed network requests: ${[...new Set(violations)].join(', ')}`)
  }
  const payload = {
    allowedOriginCount: allowedOrigins.size,
    observedOrigins: [...observedOrigins].sort(),
    httpRequestCount,
    disallowedRequestCount: 0,
    sourceRequestShapeEnforced: boundary.sourceOrigin !== null,
  }
  return Object.freeze({ ...payload, auditHash: boundaryHashV1(payload) })
}

export function makeBoundaryRunEvidenceV1({
  boundary,
  parametersHash,
  debugPort,
  checks,
  requestAudit,
  browserBinaryIdentityHashBefore,
  browserBinaryIdentityHashAfter,
}) {
  validateBoundaryEnvironmentV1(boundary)
  const sortedChecks = [...checks].sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const payload = {
    schema: COUNTED_BROWSER_RUN_SCHEMA,
    boundaryHash: boundary.boundaryHash,
    profileTemplateHash: boundary.profileTemplateHash,
    parametersHash,
    debugPort,
    debugPortSelectedByChrome: true,
    browserBinaryIdentityHashBefore,
    browserBinaryIdentityHashAfter,
    checks: sortedChecks,
    requestAudit,
    passed: true,
  }
  const evidence = { ...payload, evidenceHash: boundaryHashV1(payload) }
  validateBoundaryRunEvidenceV1(evidence, boundary)
  return Object.freeze(evidence)
}

export function validateBoundaryRunEvidenceV1(evidence, boundary) {
  validateBoundaryEnvironmentV1(boundary)
  const names = evidence?.checks?.map((check) => check.name) ?? []
  if (!evidence || evidence.schema !== COUNTED_BROWSER_RUN_SCHEMA
    || evidence.boundaryHash !== boundary.boundaryHash
    || evidence.profileTemplateHash !== boundary.profileTemplateHash
    || !HASH.test(evidence.parametersHash)
    || !Number.isSafeInteger(evidence.debugPort) || evidence.debugPort < 1024 || evidence.debugPort > 65_535
    || evidence.debugPortSelectedByChrome !== true
    || evidence.browserBinaryIdentityHashBefore !== boundary.browserBinary.identityHash
    || evidence.browserBinaryIdentityHashAfter !== boundary.browserBinary.identityHash
    || evidence.passed !== true
    || canonicalize(names) !== canonicalize(COUNTED_BROWSER_REQUIRED_CHECKS)
    || evidence.checks.some((check) => check?.passed !== true)
    || evidence.requestAudit?.disallowedRequestCount !== 0
    || evidence.requestAudit?.auditHash !== boundaryHashV1(without(evidence.requestAudit, 'auditHash'))
    || evidence.evidenceHash !== boundaryHashV1(without(evidence, 'evidenceHash'))) {
    throw new Error('Invalid counted browser per-run boundary evidence')
  }
  return true
}

export function makeBoundaryObservationV1(mode, artifacts) {
  const expectedSourceMode = mode === 'local'
    ? 'local-directory-input'
    : mode === 'remote' ? 'remote-url' : 'portable-share'
  const boundaries = artifacts.map((artifact) => artifact.environment?.browserBoundary)
  for (const boundary of boundaries) validateBoundaryEnvironmentV1(boundary, expectedSourceMode)
  const templateHashes = new Set(boundaries.map((boundary) => boundary.profileTemplateHash))
  const sourceAccesses = new Set(boundaries.map((boundary) => boundary.sourceAccess))
  const browserBinaryIdentityHashes = new Set(boundaries.map((boundary) => boundary.browserBinary.identityHash))
  if (templateHashes.size !== 1 || sourceAccesses.size !== 1 || browserBinaryIdentityHashes.size !== 1) {
    throw new Error('Counted mode benchmarks used different browser boundary templates')
  }
  const runEvidenceHashes = artifacts.flatMap((artifact) => [
    ...(artifact.warmups ?? []), ...(artifact.samples ?? []),
  ].map((run) => {
    validateBoundaryRunEvidenceV1(run.browserBoundary, artifact.environment.browserBoundary)
    return run.browserBoundary.evidenceHash
  })).sort()
  if (runEvidenceHashes.length === 0 || new Set(runEvidenceHashes).size !== runEvidenceHashes.length) {
    throw new Error('Counted browser boundary evidence is missing or reused')
  }
  const payload = {
    schema: COUNTED_BROWSER_OBSERVATION_SCHEMA,
    runtime: COUNTED_BROWSER_RUNTIME,
    sourceMode: expectedSourceMode,
    sourceAccess: [...sourceAccesses][0],
    networkPolicy: COUNTED_BROWSER_NETWORK_POLICY,
    ambientFilePolicy: COUNTED_BROWSER_AMBIENT_FILE_POLICY,
    debugPortPolicy: COUNTED_BROWSER_DEBUG_PORT_POLICY,
    profileTemplateHash: [...templateHashes][0],
    browserBinaryIdentityHash: [...browserBinaryIdentityHashes][0],
    requiredChecks: [...COUNTED_BROWSER_REQUIRED_CHECKS],
    benchmarkBoundaryHashes: boundaries.map((boundary) => boundary.boundaryHash),
    runEvidenceHashes,
    passed: true,
  }
  return Object.freeze({ ...payload, observationHash: boundaryHashV1(payload) })
}

export function validateBoundaryObservationV1(observation, mode) {
  const expectedSourceMode = mode === 'local'
    ? 'local-directory-input'
    : mode === 'remote' ? 'remote-url' : 'portable-share'
  if (!observation || observation.schema !== COUNTED_BROWSER_OBSERVATION_SCHEMA
    || observation.runtime !== COUNTED_BROWSER_RUNTIME
    || observation.sourceMode !== expectedSourceMode
    || observation.networkPolicy !== COUNTED_BROWSER_NETWORK_POLICY
    || observation.ambientFilePolicy !== COUNTED_BROWSER_AMBIENT_FILE_POLICY
    || observation.debugPortPolicy !== COUNTED_BROWSER_DEBUG_PORT_POLICY
    || !HASH.test(observation.profileTemplateHash)
    || !HASH.test(observation.browserBinaryIdentityHash)
    || canonicalize(observation.requiredChecks) !== canonicalize(COUNTED_BROWSER_REQUIRED_CHECKS)
    || !Array.isArray(observation.benchmarkBoundaryHashes)
    || observation.benchmarkBoundaryHashes.length !== 3
    || observation.benchmarkBoundaryHashes.some((value) => !HASH.test(value))
    || !Array.isArray(observation.runEvidenceHashes) || observation.runEvidenceHashes.length === 0
    || observation.runEvidenceHashes.some((value) => !HASH.test(value))
    || observation.passed !== true
    || observation.observationHash !== boundaryHashV1(without(observation, 'observationHash'))) {
    throw new Error('Invalid counted browser boundary observation')
  }
  return true
}

function without(value, key) {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
}

export function sourceRootCommitmentV1(root) {
  return boundaryHashV1({ kind: 'canonical-source-root', path: path.resolve(root) })
}

export function validateOfficialChromeIdentityV1(identity) {
  if (!identity || identity.schema !== 'egolens-official-chrome-identity-v1'
    || identity.bundleIdentifier !== 'com.google.Chrome'
    || identity.teamIdentifier !== 'EQHXZ8M8AV'
    || identity.designatedRequirement !== COUNTED_BROWSER_CHROME_REQUIREMENT
    || identity.signatureVerification !== 'codesign-deep-requirement-valid'
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(identity.codeDirectoryHash ?? '')
    || !HASH.test(identity.executableHash)
    || !Number.isSafeInteger(identity.executableSize) || identity.executableSize <= 0
    || identity.identityHash !== boundaryHashV1(without(identity, 'identityHash'))) {
    throw new Error('Counted browser is not bound to a valid official Google Chrome identity')
  }
  return true
}

async function fileSha256(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

function codesignField(output, name) {
  const values = output.split('\n')
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1).trim())
  if (values.length !== 1 || !values[0]) throw new Error(`Official Chrome signature lacks one ${name}`)
  return values[0]
}

export async function inspectOfficialChromeIdentityV1(chromeExecutableInput) {
  const chromeExecutablePath = path.resolve(chromeExecutableInput)
  const chromeRootInput = path.resolve(chromeExecutablePath, '../../..')
  const [executableDetails, rootDetails, chromeExecutable, chromeRoot] = await Promise.all([
    lstat(chromeExecutablePath), lstat(chromeRootInput), realpath(chromeExecutablePath), realpath(chromeRootInput),
  ])
  if (executableDetails.isSymbolicLink() || !executableDetails.isFile() || chromeExecutable !== chromeExecutablePath
    || rootDetails.isSymbolicLink() || !rootDetails.isDirectory() || chromeRoot !== chromeRootInput
    || !chromeExecutable.startsWith(`${chromeRoot}${path.sep}`)) {
    throw new Error('Counted Chrome must be the canonical regular executable in its canonical app bundle')
  }
  const requirement = `=${COUNTED_BROWSER_CHROME_REQUIREMENT}`
  const verified = spawnSync('/usr/bin/codesign', [
    '--verify', '--deep', '--requirement', requirement, chromeRoot,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
  if (verified.status !== 0) throw new Error('Counted Chrome failed its official deep code-signature requirement')
  const described = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', chromeRoot], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  })
  if (described.status !== 0) throw new Error('Counted Chrome code-signature identity is unavailable')
  const description = `${described.stdout}\n${described.stderr}`
  const payload = {
    schema: 'egolens-official-chrome-identity-v1',
    bundleIdentifier: codesignField(description, 'Identifier'),
    teamIdentifier: codesignField(description, 'TeamIdentifier'),
    designatedRequirement: COUNTED_BROWSER_CHROME_REQUIREMENT,
    signatureVerification: 'codesign-deep-requirement-valid',
    codeDirectoryHash: codesignField(description, 'CDHash').toLowerCase(),
    executableHash: await fileSha256(chromeExecutable),
    executableSize: executableDetails.size,
  }
  const identity = Object.freeze({ ...payload, identityHash: boundaryHashV1(payload) })
  validateOfficialChromeIdentityV1(identity)
  return identity
}
