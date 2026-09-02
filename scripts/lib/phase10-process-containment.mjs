import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const PHASE10_CONTAINMENT_ENV = 'EGOLENS_BUILD_CONTAINMENT_TOKEN'

export function phase10ContainmentTokenV1() {
  return `egolens-phase10-${randomUUID()}`
}

export function phase10ContainedEnvironmentV1(environment, token) {
  if (!/^egolens-phase10-[0-9a-f-]{36}$/u.test(token)) throw new Error('Invalid Phase 10 containment token')
  return { ...environment, [PHASE10_CONTAINMENT_ENV]: token }
}

export const PHASE10_RESIDUAL_AUDIT_PS = 'ps-environment-scan'
export const PHASE10_RESIDUAL_AUDIT_NESTED = 'process-group-nested'

let residualAuditMode = null

/**
 * `/bin/ps` is set-user-ID on macOS and the kernel refuses to execute set-id
 * binaries from a sandboxed process. A gate that is itself running inside a
 * containment (only the evidence-harness gate nests other gates) therefore
 * cannot scan process environments; it audits its detached process group
 * instead. Outside a containment the environment scan is mandatory.
 */
export function phase10ResidualAuditModeV1() {
  if (residualAuditMode) return residualAuditMode
  try {
    execFileSync('/bin/ps', ['-o', 'pid=', '-p', String(process.pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    residualAuditMode = PHASE10_RESIDUAL_AUDIT_PS
  } catch (error) {
    if (error?.code === 'EPERM' && typeof process.env[PHASE10_CONTAINMENT_ENV] === 'string') {
      residualAuditMode = PHASE10_RESIDUAL_AUDIT_NESTED
    } else {
      throw new Error('Residual process audit requires an executable /bin/ps outside any containment')
    }
  }
  return residualAuditMode
}

export function phase10ContainedPidsV1(token, { exclude = [process.pid] } = {}) {
  const output = execFileSync('/bin/ps', ['eww', '-axo', 'pid=,command='], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  })
  const excluded = new Set(exclude)
  return [...new Set(output.split('\n').flatMap((line) => {
    if (!line.includes(token)) return []
    const match = /^\s*(\d+)\s/u.exec(line)
    if (!match) return []
    const pid = Number(match[1])
    return Number.isSafeInteger(pid) && pid > 1 && !excluded.has(pid) ? [pid] : []
  }))]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cleanupNestedProcessGroup(processGroup) {
  if (!Number.isSafeInteger(processGroup) || processGroup <= 1) {
    throw new Error('Nested residual audit requires the detached process group of the contained run')
  }
  const alive = () => {
    try {
      process.kill(-processGroup, 0)
      return true
    } catch (error) {
      // EPERM means a member still exists but is not signalable by us.
      return error?.code === 'EPERM'
    }
  }
  // Let the SIGKILL already sent to the group settle before judging.
  for (let attempt = 0; attempt < 50 && alive(); attempt += 1) await sleep(20)
  if (!alive()) return []
  try { process.kill(-processGroup, 'SIGKILL') } catch { /* already exited */ }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!alive()) return [processGroup]
    await sleep(20)
  }
  throw new Error('Sandboxed Phase 10 tool left a residual detached descendant')
}

export async function phase10CleanupContainedResidualsV1(token, options = {}) {
  if (phase10ResidualAuditModeV1() === PHASE10_RESIDUAL_AUDIT_NESTED) {
    // The nested caller's own boundary probe must have proved that detached
    // re-execution is denied inside its profile; otherwise a descendant could
    // leave the group unseen. The gate records this audit mode in its evidence.
    return cleanupNestedProcessGroup(options.processGroup)
  }
  const found = phase10ContainedPidsV1(token, options)
  for (const pid of found) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const remaining = phase10ContainedPidsV1(token, options)
    if (remaining.length === 0) return found
    await sleep(20)
  }
  throw new Error('Sandboxed Phase 10 tool left a residual detached descendant')
}
