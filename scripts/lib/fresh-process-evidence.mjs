import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { phase10HashV1 } from './phase10-evidence.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function createFreshProcessWorkspaceV1(prefix = 'egolens-phase10-') {
  const profileDir = await mkdtemp(path.join(tmpdir(), prefix))
  return {
    profileDir,
    processNonce: randomUUID(),
    profileNonce: randomUUID(),
    profileMode: 'empty',
    startedAt: new Date().toISOString(),
  }
}

async function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return true
  const exited = new Promise((resolve) => processHandle.once('exit', () => resolve(true)))
  return Promise.race([exited, delay(timeoutMs).then(() => false)])
}

export async function closeFreshProcessWorkspaceV1(workspace, processHandle, options = {}) {
  const terminateMs = options.terminateMs ?? 5_000
  if (!(await waitForExit(processHandle, 0))) {
    processHandle.kill('SIGTERM')
    if (!(await waitForExit(processHandle, terminateMs))) {
      processHandle.kill('SIGKILL')
      await waitForExit(processHandle, terminateMs)
    }
  }
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    throw new Error('Fresh process exit was not observed')
  }
  await rm(workspace.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  try {
    await access(workspace.profileDir)
    throw new Error('Fresh process user-data directory was not removed')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const payload = {
    processNonce: workspace.processNonce,
    profileNonce: workspace.profileNonce,
    profileMode: workspace.profileMode,
    startedAt: workspace.startedAt,
    stoppedAt: new Date().toISOString(),
    processExitObserved: true,
    userDataDirectoryCreatedFresh: true,
    userDataDirectoryRemoved: true,
  }
  return { ...payload, evidenceHash: phase10HashV1(payload) }
}

export function validateFreshProcessEvidenceSetV1(runs) {
  const processNonces = new Set()
  const profileNonces = new Set()
  for (const run of runs) {
    if (!run.processExitObserved || !run.userDataDirectoryCreatedFresh || !run.userDataDirectoryRemoved
      || run.profileMode !== 'empty' || Date.parse(run.stoppedAt) < Date.parse(run.startedAt)) {
      throw new Error('Invalid fresh-process lifecycle evidence')
    }
    const expected = phase10HashV1({
      processNonce: run.processNonce,
      profileNonce: run.profileNonce,
      profileMode: run.profileMode,
      startedAt: run.startedAt,
      stoppedAt: run.stoppedAt,
      processExitObserved: run.processExitObserved,
      userDataDirectoryCreatedFresh: run.userDataDirectoryCreatedFresh,
      userDataDirectoryRemoved: run.userDataDirectoryRemoved,
    })
    if (run.evidenceHash !== expected) throw new Error('Fresh-process evidence hash mismatch')
    if (processNonces.has(run.processNonce) || profileNonces.has(run.profileNonce)) {
      throw new Error('Fresh-process evidence reused a process or profile nonce')
    }
    processNonces.add(run.processNonce)
    profileNonces.add(run.profileNonce)
  }
  return true
}
