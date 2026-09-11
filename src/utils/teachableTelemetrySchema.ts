/** Shared ingestion allowlist: never serialize tool input/output directly. */
export const TELEMETRY_EVENTS = ['intro_open', 'intro_try', 'preset_select', 'sample_zip', 'load_start', 'load_success', 'load_error', 'recipe_import', 'source_selected', 'recognized', 'render_saved', 'edit_recipe', 'session_start', 'phase_change', 'human_review', 'seal', 'tool_call', 'session_end', 'export_recipe', 'setup_check'] as const
export type TeachingEvent = typeof TELEMETRY_EVENTS[number]
export const ENUMS: Record<string, readonly string[]> = {
  tool: ['inspect', 'get_contract', 'get_state', 'apply_revision', 'finalize'],
  phase: ['idle', 'inspecting', 'validating', 'review', 'finalized', 'capability-gap', 'revoked'],
  outcome: ['success', 'failure', 'accepted', 'rejected', 'started'],
  source: ['local', 'remote', 'file', 'url', 'unknown'],
  mode: ['inventory', 'metadata', 'bytes', 'text', 'json', 'json-sample', 'table-schema'],
  issue: ['upside-down', 'mirrored', 'wrong-scale', 'drift', 'misaligned', 'out-of-sync', 'wrong-labels', 'other'],
  capability: ['timeline', 'egoPoses', 'pointClouds', 'cameraImages', 'boxes3d', 'boxes2d', 'projection', 'segmentation', 'keypoints'],
  sample: ['001', '002'],
  agent: ['codex', 'chatgpt', 'chrome', 'unknown'],
  extension: ['.json', '.pkl', '.gz', '.parquet', '.feather', '.arrow', '.jpg', '.jpeg', '.png', '.bin', '.pcd', '.npz', '.csv', '.xml', '.txt', 'other'],
}
const NUMBERS = new Set(['sequence', 'revision', 'duration_ms', 'file_count', 'sensor_count', 'match_count', 'node_count', 'column_count', 'row_count', 'frame_count', 'truncated', 'available', 'size_bucket'])
export interface TeachingRecord {
  event: TeachingEvent
  case_id: string
  sequence: number
  props: Record<string, string | number>
  detail?: { operators?: string[]; codes?: string[]; shape?: string; changes?: RevisionChange[] }
}
// Populated from checked-in engine vocabulary, not from customer text.
import vocabulary from './teachableTelemetryVocabulary.json'
import type { RevisionChange } from './teachingRevisionSummary'
export function vocabularyValue(value: unknown, kind: 'operators' | 'codes'): string {
  return typeof value === 'string' && vocabulary[kind].includes(value) ? value : 'other'
}
export function sanitizeProps(input: Record<string, unknown>): Record<string, string | number> {
  const output: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(input)) {
    if (ENUMS[key]?.includes(String(value))) output[key] = String(value)
    else if (NUMBERS.has(key) && typeof value === 'number' && Number.isFinite(value)) output[key] = Math.max(0, Math.min(1e9, Math.round(value)))
    else if (['revision_id', 'parent_id', 'flow_id'].includes(key) && typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)) output[key] = value
    else if (key === 'build' && typeof value === 'string' && /^(?:[a-f0-9]{7,40}|development)$/.test(value)) output[key] = value
    else if (key === 'code') output[key] = vocabularyValue(value, 'codes')
  }
  return output
}
/** Shape only: no object keys, string values, numeric values, or file paths. */
export function valueShape(value: unknown, depth = 0): string {
  if (depth > 4) return '…'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})[${value.slice(0, 8).map(v => valueShape(v, depth + 1)).join(',')}]`.slice(0, 1024)
  if (typeof value === 'object') return `object(${Object.keys(value).length}){${Object.values(value).slice(0, 16).map(v => valueShape(v, depth + 1)).join(',')}}`.slice(0, 1024)
  return ['string', 'number', 'boolean', 'undefined'].includes(typeof value) ? typeof value : 'other'
}
export function validateRecord(value: unknown): TeachingRecord | null {
  if (!value || typeof value !== 'object') return null
  const r = value as TeachingRecord
  if (!TELEMETRY_EVENTS.includes(r.event) || !/^[a-f0-9-]{36}$/.test(r.case_id) || !Number.isInteger(r.sequence) || r.sequence < 1 || r.sequence > 500) return null
  if (!r.props || typeof r.props !== 'object' || Array.isArray(r.props)) return null
  const props = sanitizeProps(r.props)
  if (JSON.stringify(props) !== JSON.stringify(r.props)) return null
  const detail: TeachingRecord['detail'] = {}
  if (r.detail) {
    if (typeof r.detail !== 'object') return null
    for (const key of ['operators', 'codes'] as const) {
      const list = r.detail[key]
      if (list !== undefined) {
        if (!Array.isArray(list) || list.length > 64 || list.some(v => v !== 'other' && vocabularyValue(v, key) !== v)) return null
        detail[key] = list
      }
    }
    if (r.detail.changes !== undefined) {
      if (!Array.isArray(r.detail.changes) || r.detail.changes.length > 32) return null
      const changes: RevisionChange[] = []
      for (const c of r.detail.changes) {
        if (!c || typeof c !== 'object' || (c.operator !== 'other' && vocabularyValue(c.operator, 'operators') !== c.operator) || !['added', 'removed', 'modified'].includes(c.change) || ![0, 1].includes(c.inputs_changed)) return null
        if (!Array.isArray(c.parameters) || c.parameters.length > 16 || c.parameters.some(p => p !== 'other' && !vocabulary.parameters.includes(p))) return null
        changes.push({ operator: c.operator, change: c.change, parameters: c.parameters, inputs_changed: c.inputs_changed })
      }
      detail.changes = changes
    }
    if (r.detail.shape !== undefined) {
      if (typeof r.detail.shape !== 'string' || r.detail.shape.length > 1024 || !/^(?:array|object|string|number|boolean|undefined|null|other|…|[0-9()[\]{},])+$/.test(r.detail.shape)) return null
      detail.shape = r.detail.shape
    }
  }
  return { event: r.event, case_id: r.case_id, sequence: r.sequence, props, ...(r.detail ? { detail } : {}) }
}
