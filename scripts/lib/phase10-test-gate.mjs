import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  phase10BytesHashV1,
  phase10HashV1,
  phase10VerifierDependencyClosureV1,
} from './phase10-evidence.mjs'
import {
  PHASE10_RESIDUAL_AUDIT_NESTED,
  phase10CleanupContainedResidualsV1,
  phase10ContainedEnvironmentV1,
  phase10ContainmentTokenV1,
  phase10ResidualAuditModeV1,
} from './phase10-process-containment.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERIFIER_ROOT = path.resolve(HERE, '../..')
const FIXED_GIT = '/usr/bin/git'
const FIXED_SANDBOX = '/usr/bin/sandbox-exec'
const TEST_PROFILE = path.join(VERIFIER_ROOT, 'scripts/phase10-reviewed-test.sb')
const HARNESS_PROFILE = path.join(VERIFIER_ROOT, 'scripts/phase10-reviewed-harness.sb')
const VITEST_CONFIG = path.join(VERIFIER_ROOT, 'scripts/phase10-reviewed-vitest.config.mjs')
const VITEST_CLI = path.join(VERIFIER_ROOT, 'node_modules/vitest/vitest.mjs')
const NEGATIVE_TEST = 'src/teachable/__tests__/phase10NegativeGate.test.ts'
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const MAX_OUTPUT = 64 * 1024 * 1024
const TIMEOUT_MS = 10 * 60 * 1000

const BOUNDARY_PROBE = String.raw`
const fs = require('node:fs'); const net = require('node:net'); const {spawnSync} = require('node:child_process');
const [candidate, verifier, home, tracked] = process.argv.slice(1); const results = {};
// Only a Seatbelt EPERM proves a denial. ENOENT, a missing interface, or a
// timeout would otherwise let an unenforced boundary pass on a host that
// simply lacks the file or the network.
try { fs.readFileSync(candidate + '/.git/HEAD'); results.candidate = false } catch (error) { results.candidate = error.code === 'EPERM' }
try { fs.readdirSync(home); results.home = false } catch (error) { results.home = error.code === 'EPERM' }
for (const [name, filename] of Object.entries({verifierWrite: verifier + '/package.json', trackedWrite: tracked})) {
  try { fs.writeFileSync(filename, 'tamper'); results[name] = false } catch (error) { results[name] = error.code === 'EPERM' }
}
const escaped = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, env: {}, stdio: 'ignore'}); results.detachedExecDenied = escaped.error?.code === 'EPERM';
const socket = net.connect({host: '1.1.1.1', port: 443}); let finished = false; let timer;
const done = value => { if (finished) return; finished = true; clearTimeout(timer); results.externalNetwork = value; socket.destroy(); process.stdout.write(JSON.stringify(results)) };
socket.once('connect', () => done(false)); socket.once('error', (error) => done(error.code === 'EPERM')); timer = setTimeout(() => done(false), 2000);
`

const GIT_ENVIRONMENT = Object.freeze({
  HOME: '/var/empty',
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
})

function git(repository, argv, binary = false) {
  return execFileSync(FIXED_GIT, [
    '-c', 'core.hooksPath=/dev/null', '-C', repository, ...argv,
  ], {
    encoding: binary ? undefined : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: GIT_ENVIRONMENT,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function trackedTests(repository, commit, scope) {
  const paths = git(repository, ['ls-tree', '-r', '--name-only', '-z', commit, '--', 'src'], true)
    .toString('utf8').split('\0').filter((entry) => TEST_PATH.test(entry)).sort()
  return scope === 'negative' ? paths.filter((entry) => entry === NEGATIVE_TEST) : paths
}

async function exactTrackedContentManifest(repository, commit) {
  const records = git(repository, ['ls-tree', '-r', '-z', commit], true)
    .toString('utf8').split('\0').filter(Boolean)
  const files = []
  for (const record of records) {
    const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/u.exec(record)
    if (!match) throw new Error(`Reviewed test boundary rejects non-regular tracked entries: ${record}`)
    const relativePath = match[2]
    const filename = path.join(repository, relativePath)
    const details = await lstat(filename)
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Candidate tracked entry is not a regular file: ${relativePath}`)
    }
    const [actual, committed] = await Promise.all([
      readFile(filename),
      Promise.resolve(git(repository, ['show', `${commit}:${relativePath}`], true)),
    ])
    if (!actual.equals(committed)) throw new Error(`Candidate tracked bytes differ from ${commit}: ${relativePath}`)
    files.push({ path: relativePath, bytes: actual.length, sha256: phase10BytesHashV1(actual) })
  }
  return { files, manifestHash: phase10HashV1({ version: 1, files }) }
}

async function stageContentManifest(stage, relative = '') {
  const files = []
  const entries = (await readdir(path.join(stage, relative), { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  for (const entry of entries) {
    if (!relative && entry.name === 'node_modules') continue
    const child = relative ? `${relative}/${entry.name}` : entry.name
    const filename = path.join(stage, child)
    const details = await lstat(filename)
    if (details.isSymbolicLink()) throw new Error(`Candidate test stage contains a symbolic link: ${child}`)
    if (details.isDirectory()) files.push(...await stageContentManifest(stage, child))
    else if (details.isFile()) {
      const bytes = await readFile(filename)
      files.push({ path: child, bytes: bytes.length, sha256: phase10BytesHashV1(bytes) })
    } else throw new Error(`Candidate test stage contains a non-regular entry: ${child}`)
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function testManifest(repository, commit, scope) {
  const paths = trackedTests(repository, commit, scope)
  if (scope === 'negative' && (paths.length !== 1 || paths[0] !== NEGATIVE_TEST)) {
    throw new Error('Candidate is missing the exact reviewed Phase 10 negative test')
  }
  if (scope === 'regression' && paths.length < 1) throw new Error('Candidate regression test manifest is empty')
  const files = paths.map((relativePath) => {
    const bytes = git(repository, ['show', `${commit}:${relativePath}`], true)
    return { path: relativePath, bytes: bytes.length, sha256: phase10BytesHashV1(bytes) }
  })
  return { files, manifestHash: phase10HashV1({ version: 1, files }) }
}

function assertSameManifest(candidate, reviewed, scope) {
  if (candidate.manifestHash !== reviewed.manifestHash
    || JSON.stringify(candidate.files) !== JSON.stringify(reviewed.files)) {
    throw new Error(`Candidate ${scope} tests do not match the reviewed verifier test bytes`)
  }
}

async function exactCandidate(candidateRepository, expectedCommit) {
  const resolved = path.resolve(String(candidateRepository))
  const canonical = await realpath(resolved)
  const details = await lstat(resolved)
  if (canonical !== resolved || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('--candidate-repository must be a canonical non-symlink directory')
  }
  if (canonical === VERIFIER_ROOT
    || canonical.startsWith(`${VERIFIER_ROOT}${path.sep}`)
    || VERIFIER_ROOT.startsWith(`${canonical}${path.sep}`)) {
    throw new Error('Candidate repository and reviewed verifier checkout must be disjoint')
  }
  if (path.resolve(git(canonical, ['rev-parse', '--show-toplevel']).trim()) !== canonical) {
    throw new Error('--candidate-repository must be the exact repository root')
  }
  const head = git(canonical, ['rev-parse', 'HEAD']).trim()
  const dirty = git(canonical, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
  if (head !== expectedCommit || dirty) throw new Error('Test gate requires a clean exact candidate checkout')
  const content = await exactTrackedContentManifest(canonical, expectedCommit)
  return { root: canonical, sourceTreeHash: content.manifestHash, files: content.files }
}

async function fixedRuntime() {
  if (process.platform !== 'darwin') throw new Error('Reviewed Phase 10 tests require macOS Seatbelt')
  const esbuild = await realpath(path.join(VERIFIER_ROOT, 'node_modules/.bin/esbuild'))
  const [sandbox, profile, harnessProfile, node, vitest, modules, esbuildInfo] = await Promise.all([
    lstat(FIXED_SANDBOX), lstat(TEST_PROFILE), lstat(HARNESS_PROFILE), lstat(await realpath(process.execPath)),
    lstat(VITEST_CLI), lstat(path.join(VERIFIER_ROOT, 'node_modules')),
    lstat(esbuild),
  ])
  if (!sandbox.isFile() || !profile.isFile() || !harnessProfile.isFile() || !node.isFile()
    || !vitest.isFile() || !esbuildInfo.isFile() || !modules.isDirectory()) {
    throw new Error('Reviewed Phase 10 test runtime is incomplete')
  }
  return {
    node: await realpath(process.execPath),
    nodeModules: await realpath(path.join(VERIFIER_ROOT, 'node_modules')),
    esbuild,
    // Per-user Darwin temporary root used by Apple's xcrun shim behind
    // /usr/bin/git; the harness profile admits only its xcrun cache names.
    systemTempRoot: await realpath(os.tmpdir()),
  }
}

function sandboxArguments(profile, runtime, candidateStage, writeRoot, command) {
  const parameters = {
    NODE_RUNTIME_ROOT: path.dirname(runtime.node),
    NODE_BINARY: runtime.node,
    ESBUILD_BINARY: runtime.esbuild,
    VERIFIER_ROOT,
    CANDIDATE_STAGE_ROOT: candidateStage,
    WRITE_ROOT: writeRoot,
    SYSTEM_TEMP_ROOT: runtime.systemTempRoot,
  }
  return [
    '-f', profile,
    ...Object.entries(parameters).flatMap(([name, value]) => ['-D', `${name}=${value}`]),
    ...command,
  ]
}

function runEnvironment(runRoot, runtime) {
  return {
    HOME: path.join(runRoot, 'home'),
    TMPDIR: path.join(runRoot, 'tmp'),
    XDG_CACHE_HOME: path.join(runRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(runRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(runRoot, 'xdg-data'),
    PATH: `${path.dirname(runtime.node)}:/usr/bin:/bin`,
    LANG: 'C',
    LC_ALL: 'C',
    CI: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ESBUILD_BINARY_PATH: runtime.esbuild,
  }
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
  try { child.kill('SIGKILL') } catch { /* already exited */ }
}

async function runContained(command, options) {
  const token = phase10ContainmentTokenV1()
  let child
  let stdout = ''
  let stderr = ''
  try {
    const completed = await new Promise((resolve, reject) => {
      child = spawn(FIXED_SANDBOX, sandboxArguments(
        options.profile,
        options.runtime,
        options.candidateStage,
        options.writeRoot,
        command,
      ), {
        cwd: options.cwd,
        env: phase10ContainedEnvironmentV1(options.env, token),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let settled = false
      let timer
      const finish = (callback) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killGroup(child)
        callback()
      }
      const append = (current, chunk) => {
        if (Buffer.byteLength(current) + chunk.length > MAX_OUTPUT) {
          finish(() => reject(new Error('Reviewed test output exceeded its bounded limit')))
          return current
        }
        return current + chunk.toString('utf8')
      }
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
      child.once('error', (error) => finish(() => reject(error)))
      child.once('close', (code, signal) => finish(() => resolve({ code, signal })))
      timer = setTimeout(() => finish(() => reject(new Error('Reviewed test run timed out'))), TIMEOUT_MS)
    })
    const residualPids = await phase10CleanupContainedResidualsV1(token, { processGroup: child.pid })
    return { ...completed, stdout, stderr, residualPids }
  } catch (error) {
    if (child) killGroup(child)
    await phase10CleanupContainedResidualsV1(token, { processGroup: child?.pid })
    throw error
  }
}

async function createRunRoot() {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'egolens-phase10-test-gate-'))
  await chmod(root, 0o700)
  const writeRoot = path.join(root, 'runtime')
  await mkdir(writeRoot, { mode: 0o700 })
  await Promise.all(['home', 'tmp', 'xdg-cache', 'xdg-config', 'xdg-data']
    .map((name) => mkdir(path.join(writeRoot, name), { mode: 0o700 })))
  return { root, writeRoot }
}

async function stageCandidate(candidate, expectedCommit, runRoot, runtime) {
  const stage = path.join(runRoot, 'candidate')
  const archivePath = path.join(runRoot, 'candidate.tar')
  await mkdir(stage, { mode: 0o700 })
  git(candidate, ['archive', '--format=tar', '--output', archivePath, expectedCommit])
  const extracted = spawnSync('/usr/bin/tar', ['-x', '-f', archivePath, '-C', stage], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: GIT_ENVIRONMENT,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (extracted.error) throw extracted.error
  if (extracted.status !== 0) throw new Error(`Could not stage exact candidate archive: ${extracted.stderr}`)
  await rm(archivePath, { force: true })
  const stagedFiles = await stageContentManifest(stage)
  const expected = await exactTrackedContentManifest(candidate, expectedCommit)
  if (JSON.stringify(stagedFiles) !== JSON.stringify(expected.files)) {
    throw new Error('Fresh candidate test archive does not match the exact committed bytes')
  }
  await symlink(runtime.nodeModules, path.join(stage, 'node_modules'), 'dir')
  return stage
}

async function removeStage(_candidate, stage) {
  if (!stage) return
  await rm(path.join(stage, 'node_modules'), { force: true })
}

export async function runPhase10ReviewedGateV1({
  candidateRepository,
  expectedCommit,
  kind,
  expectedVerifierDependencyClosureHash,
  expectedVerifierNodeRuntimeHash,
}) {
  if (!['negative', 'regression', 'harness'].includes(kind)) throw new Error('Unknown reviewed test gate kind')
  const runtime = await fixedRuntime()
  const candidate = await exactCandidate(candidateRepository, expectedCommit)
  const verifierCommit = git(VERIFIER_ROOT, ['rev-parse', 'HEAD']).trim()
  const verifierPreContent = await exactTrackedContentManifest(VERIFIER_ROOT, verifierCommit)
  const verifierPreSourceTreeHash = verifierPreContent.manifestHash
  const verifierPreStatus = git(VERIFIER_ROOT, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
  if (verifierPreStatus) throw new Error('Reviewed verifier checkout became dirty before the test run')
  const dependencyPre = await phase10VerifierDependencyClosureV1()
  const nodeRuntimePreHash = phase10BytesHashV1(await readFile(runtime.node))
  if (dependencyPre.closureHash !== expectedVerifierDependencyClosureHash
    || nodeRuntimePreHash !== expectedVerifierNodeRuntimeHash) {
    throw new Error('Reviewed verifier dependency closure changed before the test run')
  }
  const scope = kind === 'harness' ? null : kind
  const reviewedManifest = scope ? testManifest(VERIFIER_ROOT, verifierCommit, scope) : null
  const candidateManifest = scope ? testManifest(candidate.root, expectedCommit, scope) : null
  if (scope) assertSameManifest(candidateManifest, reviewedManifest, scope)
  const harnessFiles = ['scripts/phase10-evidence.node.mjs', 'scripts/phase6-benchmark-summary.node.mjs']
  const harnessManifest = kind === 'harness'
    ? {
        files: await Promise.all(harnessFiles.map(async (relativePath) => {
          const bytes = await readFile(path.join(VERIFIER_ROOT, relativePath))
          return { path: relativePath, bytes: bytes.length, sha256: phase10BytesHashV1(bytes) }
        })),
      }
    : null
  if (harnessManifest) harnessManifest.manifestHash = phase10HashV1({ version: 1, files: harnessManifest.files })
  const { root: runRoot, writeRoot } = await createRunRoot()
  let stage = null
  const startedAt = new Date().toISOString()
  const freshRunId = randomUUID()
  try {
    stage = await stageCandidate(candidate.root, expectedCommit, runRoot, runtime)
    const probe = await runContained([
      runtime.node, '-e', BOUNDARY_PROBE,
      candidate.root, VERIFIER_ROOT, os.homedir(), path.join(stage, 'package.json'),
    ], {
      runtime, candidateStage: stage, writeRoot, cwd: stage,
      env: runEnvironment(writeRoot, runtime),
      profile: TEST_PROFILE,
    })
    if (probe.code !== 0) throw new Error(`Reviewed test boundary probe failed: ${probe.stderr.slice(-2000)}`)
    const probeResult = JSON.parse(probe.stdout)
    if (probe.residualPids.length !== 0
      || Object.values(probeResult).some((passed) => passed !== true)) {
      throw new Error(`Reviewed test boundary probe mismatch: ${JSON.stringify({
        ...probeResult,
        residualProcessCount: probe.residualPids.length,
      })}`)
    }
    const residualAudit = phase10ResidualAuditModeV1()
    if (residualAudit === PHASE10_RESIDUAL_AUDIT_NESTED && (kind === 'harness' || probeResult.detachedExecDenied !== true)) {
      // Only the reviewed test profile makes the process-group audit complete
      // (its probe just proved that no descendant can detach); the harness
      // profile allows child execution and must be audited with /bin/ps.
      throw new Error('Nested residual audit is admissible only for the reviewed test profile')
    }
    const resultFile = path.join(writeRoot, kind === 'harness' ? 'harness.tap' : `${kind}.json`)
    const logicalCommand = kind === 'harness'
      ? ['node', '--test', '--test-reporter=tap', ...harnessFiles]
      : [
          'node', 'node_modules/vitest/vitest.mjs', 'run',
          ...(kind === 'negative' ? [NEGATIVE_TEST] : []),
          '--root', '<candidate-stage>', '--config', 'scripts/phase10-reviewed-vitest.config.mjs',
          '--configLoader', 'runner', '--pool=threads', '--no-cache', '--reporter=json', '--outputFile', '<result>',
        ]
    const command = kind === 'harness'
      ? [runtime.node, '--test', '--test-reporter=tap', ...harnessFiles.map((entry) => path.join(VERIFIER_ROOT, entry))]
      : [
          runtime.node, VITEST_CLI, 'run',
          ...(kind === 'negative' ? [NEGATIVE_TEST] : []),
          '--root', stage, '--config', VITEST_CONFIG, '--configLoader', 'runner',
          '--pool=threads', '--no-cache', '--reporter=json', '--outputFile', resultFile,
        ]
    const completed = await runContained(command, {
      runtime, candidateStage: stage, writeRoot,
      cwd: kind === 'harness' ? VERIFIER_ROOT : stage,
      env: runEnvironment(writeRoot, runtime),
      profile: kind === 'harness' ? HARNESS_PROFILE : TEST_PROFILE,
    })
    if (completed.code !== 0) {
      let reportFailure = ''
      if (kind !== 'harness') {
        try {
          const failed = JSON.parse(await readFile(resultFile, 'utf8'))
          reportFailure = JSON.stringify({
            success: failed.success,
            numFailedTestSuites: failed.numFailedTestSuites,
            numFailedTests: failed.numFailedTests,
            failures: (failed.testResults ?? []).filter((suite) => suite.status === 'failed'
              || (suite.assertionResults ?? []).some((entry) => entry.status === 'failed'))
              .map((suite) => ({
                name: path.basename(suite.name ?? ''),
                message: suite.message,
                assertions: (suite.assertionResults ?? []).filter((entry) => entry.status === 'failed')
                  .map((entry) => ({ title: entry.fullName ?? entry.title, messages: entry.failureMessages })),
              })),
          })
        } catch { /* fall back to bounded process output */ }
      }
      throw new Error(`Reviewed ${kind} test run failed: ${(reportFailure || completed.stderr || completed.stdout).slice(-8000)}`)
    }
    if (completed.residualPids.length !== 0) {
      throw new Error(`Reviewed ${kind} test run spawned a detached residual process`)
    }
    const resultBytes = kind === 'harness'
      ? Buffer.from(completed.stdout)
      : await readFile(resultFile)
    const candidatePostContent = await exactTrackedContentManifest(candidate.root, expectedCommit)
    const candidatePostSourceTreeHash = candidatePostContent.manifestHash
    const candidatePostHead = git(candidate.root, ['rev-parse', 'HEAD']).trim()
    const candidatePostStatus = git(candidate.root, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
    const verifierPostContent = await exactTrackedContentManifest(VERIFIER_ROOT, verifierCommit)
    const verifierPostSourceTreeHash = verifierPostContent.manifestHash
    const verifierPostHead = git(VERIFIER_ROOT, ['rev-parse', 'HEAD']).trim()
    const verifierPostStatus = git(VERIFIER_ROOT, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
    if (candidatePostHead !== expectedCommit || candidatePostStatus
      || candidatePostSourceTreeHash !== candidate.sourceTreeHash) {
      throw new Error('Candidate repository changed during the reviewed test run')
    }
    const dependencyPost = await phase10VerifierDependencyClosureV1()
    const nodeRuntimePostHash = phase10BytesHashV1(await readFile(runtime.node))
    if (dependencyPost.closureHash !== expectedVerifierDependencyClosureHash
      || nodeRuntimePostHash !== expectedVerifierNodeRuntimeHash
      || verifierPostHead !== verifierCommit || verifierPostStatus
      || verifierPostSourceTreeHash !== verifierPreSourceTreeHash) {
      throw new Error('Verifier checkout changed during the reviewed test run')
    }
    const stagedPostFiles = await stageContentManifest(stage)
    if (JSON.stringify(stagedPostFiles) !== JSON.stringify(candidate.files)) {
      throw new Error('Candidate staged source bytes changed during the reviewed test run')
    }
    return {
      resultBytes,
      execution: {
        runner: 'egolens-phase10-reviewed-test-runner-v1',
        freshRunId,
        startedAt,
        finishedAt: new Date().toISOString(),
        commandHash: phase10HashV1({ version: 1, command: logicalCommand }),
        resultHash: phase10BytesHashV1(resultBytes),
        testManifestHash: (candidateManifest ?? harnessManifest).manifestHash,
        candidatePreSourceTreeHash: candidate.sourceTreeHash,
        candidatePostSourceTreeHash,
        verifierPreSourceTreeHash,
        verifierPostSourceTreeHash,
        candidateRepositoryClean: true,
        verifierCheckoutClean: true,
        sandbox: 'macos-seatbelt-deny-default',
        network: 'loopback-only',
        externalNetworkDenied: true,
        protectedRootsDenied: true,
        trackedSourceWriteDenied: true,
        detachedChildExecDenied: true,
        residualAudit,
        residualProcessCount: completed.residualPids.length,
      },
      testSourceHash: candidateManifest?.files[0]?.sha256 ?? null,
    }
  } finally {
    await removeStage(candidate.root, stage)
    await rm(runRoot, { recursive: true, force: true })
  }
}
