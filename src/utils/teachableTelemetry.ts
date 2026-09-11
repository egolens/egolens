import { revisionChanges } from './teachingRevisionSummary'
import { getDeployment } from './analyticsBootstrap'
import { sanitizeProps, valueShape, vocabularyValue, type TeachingEvent, type TeachingRecord } from './teachableTelemetrySchema'
let caseId = ''
let flowId = ''
let acceptedRevisionId: string | undefined
export function teachingRevisionContext(before: unknown, after: unknown) {
  return { revision_id: crypto.randomUUID(), parent_id: acceptedRevisionId, changes: revisionChanges(before, after) }
}
export function acceptTeachingRevision(id: string) { acceptedRevisionId = id }
let sequence = 0
const queue: TeachingRecord[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let installed = false
const endpoint = import.meta.env.VITE_TEACHABLE_TELEMETRY_ENDPOINT as string | undefined
function enabled() { return typeof window !== 'undefined' && import.meta.env.VITE_ANALYTICS_DISABLED !== 'true' }
export function beginTeachingCase() { if (!enabled()) return; flushTeachingTelemetry(); caseId = crypto.randomUUID(); sequence = 0; acceptedRevisionId = undefined }
export function trackTeaching(event: TeachingEvent, input: Record<string, unknown> = {}, detail?: TeachingRecord['detail']) {
  if (!enabled()) return
  try {
    if (!caseId) caseId = crypto.randomUUID()
    if (!flowId) flowId = crypto.randomUUID()
    if (sequence >= 500) return
    const props = sanitizeProps({ build: import.meta.env.VITE_BUILD_ID || 'development', revision_id: acceptedRevisionId, flow_id: flowId, ...input })
    const record: TeachingRecord = { event, case_id: caseId, sequence: ++sequence, props, ...(detail ? { detail } : {}) }
    window.gtag?.('event', `tl_${event}`, { ...props, case_id: caseId, flow_id: flowId, sequence, deployment: getDeployment() })
    if (!endpoint) return
    queue.push(record)
    if (!installed) {
      installed = true
      window.addEventListener('pagehide', flushTeachingTelemetry)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTeachingTelemetry() })
    }
    if (queue.length >= 8) flushTeachingTelemetry()
    else if (!timer) timer = setTimeout(flushTeachingTelemetry, 3000)
  } catch { /* Observability must never interrupt data loading or teaching. */ }
}
export function flushTeachingTelemetry() {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!endpoint || !queue.length) return
  const records: TeachingRecord[] = []
  while (queue.length && records.length < 8) {
    const candidate = [...records, queue[0]]
    if (new TextEncoder().encode(JSON.stringify({ version: 1, records: candidate })).length > 15 * 1024) {
      if (!records.length) queue.shift()
      break
    }
    records.push(queue.shift()!)
  }
  if (queue.length) timer = setTimeout(flushTeachingTelemetry, 1000)
  if (!records.length) return
  // At most 8 bounded structural records per request. No retry storm/offline storage.
  void fetch(endpoint, { method: 'POST', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, records }), keepalive: true }).catch(() => {})
}
export function trackTeachingTool(tool: string, input: Record<string, unknown>, result: unknown, duration: number, revision: number, failed = false, revisionContext?: ReturnType<typeof teachingRevisionContext>) {
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  const codes = Array.isArray(r.diagnostics) ? r.diagnostics.slice(0, 64).map(d => vocabularyValue(d?.code, 'codes')) : []
  const recipe = input.recipe as { pipelines?: Record<string, { nodes?: { op?: string }[] }> } | undefined
  const nodes = recipe?.pipelines && typeof recipe.pipelines === 'object' ? Object.values(recipe.pipelines).flatMap(p => Array.isArray(p?.nodes) ? p.nodes : []).slice(0, 64) : []
  const operators = nodes.map(n => vocabularyValue(n?.op, 'operators'))
  const ext = typeof input.path === 'string' ? input.path.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() : undefined
  trackTeaching('tool_call', { tool, mode: input.mode, extension: ext, duration_ms: duration, revision, phase: r.phase, outcome: failed || r.ok === false ? 'failure' : 'success', code: codes[0], node_count: nodes.length, ...(revisionContext ? { revision_id: revisionContext.revision_id, parent_id: revisionContext.parent_id } : {}) }, {
    ...(revisionContext ? { changes: revisionContext.changes } : {}),
    ...(codes.length ? { codes } : {}), ...(operators.length ? { operators } : {}),
    ...(tool === 'inspect' ? { shape: valueShape(r.data) } : {}),
  })
  if (revisionContext && r.ok === true) acceptTeachingRevision(revisionContext.revision_id)
}
