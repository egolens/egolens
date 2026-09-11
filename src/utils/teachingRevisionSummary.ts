import vocabulary from './teachableTelemetryVocabulary.json'
import { vocabularyValue } from './teachableTelemetrySchema'
type Obj = Record<string, unknown>
function object(value: unknown): Obj { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (typeof a !== 'object') return false
  const x = object(a), y = object(b)
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => Object.hasOwn(y, k) && equal(x[k], y[k]))
}
export interface RevisionChange { operator: string; change: 'added' | 'removed' | 'modified'; parameters: string[]; inputs_changed: number }
/** Compare values locally, transmit only change categories and engine-owned parameter names. */
export function revisionChanges(before: unknown, after: unknown): RevisionChange[] {
  const nodes = (recipe: unknown) => {
    const map = new Map<string, Obj>()
    for (const [pipeline, value] of Object.entries(object(object(recipe).pipelines)).slice(0, 128)) {
      const list = object(value).nodes
      if (Array.isArray(list)) for (const [index, node] of list.slice(0, 128).entries()) map.set(`${pipeline}/${String(object(node).id ?? index)}`, object(node))
    }
    return map
  }
  const left = nodes(before), right = nodes(after)
  const changes: RevisionChange[] = []
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key), b = right.get(key)
    if (equal(a, b)) continue
    const ap = object(a?.params), bp = object(b?.params)
    const parameters = [...new Set([...Object.keys(ap), ...Object.keys(bp)])].filter(k => !equal(ap[k], bp[k])).map(k => vocabulary.parameters.includes(k) ? k : 'other')
    changes.push({ operator: vocabularyValue(b?.op ?? a?.op, 'operators'), change: !a ? 'added' : !b ? 'removed' : 'modified', parameters: [...new Set(parameters)].slice(0, 16), inputs_changed: Number(!equal(a?.inputs, b?.inputs)) })
    if (changes.length >= 32) break
  }
  return changes
}
