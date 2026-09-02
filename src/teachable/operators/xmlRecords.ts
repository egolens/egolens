/**
 * Bounded XML reader: a small tokenizer builds a plain tree (elements,
 * attributes, text) and `recordPath` selects which repeated element becomes
 * one record. Child elements with scalar text become fields, repeated
 * children become arrays, attributes are prefixed with '@'. Enough for
 * KITTI tracklets and similar annotation exports without a DOM.
 */
export interface XmlRecordsParamsV1 {
  /** Slash-separated element path whose matches become records, e.g. "tracklets/item". */
  readonly recordPath: string
  readonly maxRecords?: number
  readonly maxDepth?: number
  readonly numeric?: boolean
}

interface XmlNode {
  readonly name: string
  readonly attributes: Record<string, string>
  readonly children: XmlNode[]
  text: string
}

const DEFAULT_MAX_RECORDS = 1_000_000
const DEFAULT_MAX_DEPTH = 64
const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    attributes[match[1]!] = decodeEntities(match[2] ?? match[3] ?? '')
  }
  return attributes
}

export function parseXmlTreeV1(text: string, maxDepth = DEFAULT_MAX_DEPTH): XmlNode {
  const root: XmlNode = { name: '', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const tag = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/gu
  let last = 0
  for (const match of text.matchAll(tag)) {
    const current = stack[stack.length - 1]!
    current.text += decodeEntities(text.slice(last, match.index))
    last = match.index + match[0].length
    if (match[1] !== undefined) { current.text += match[1]; continue }
    if (match[0].startsWith('<!--') || match[0].startsWith('<?') || match[0].startsWith('<!DOCTYPE')) continue
    if (match[2] !== undefined) {
      if (stack.length < 2 || current.name !== match[2]) throw new Error(`XML_MALFORMED: unexpected closing tag </${match[2]}>`)
      stack.pop()
      continue
    }
    const node: XmlNode = { name: match[3]!, attributes: parseAttributes(match[4] ?? ''), children: [], text: '' }
    current.children.push(node)
    if (match[5] !== '/') {
      if (stack.length > maxDepth) throw new Error(`XML_MALFORMED: nesting deeper than ${maxDepth}`)
      stack.push(node)
    }
  }
  if (stack.length !== 1) throw new Error(`XML_MALFORMED: unclosed element <${stack[stack.length - 1]!.name}>`)
  return root
}

function coerce(value: string, numeric: boolean): string | number {
  const trimmed = value.trim()
  if (!numeric || trimmed.length === 0) return trimmed
  const number = Number(trimmed)
  return Number.isFinite(number) && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/iu.test(trimmed) ? number : trimmed
}

function recordOf(node: XmlNode, numeric: boolean): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.attributes)) record[`@${key}`] = coerce(value, numeric)
  const groups = new Map<string, XmlNode[]>()
  for (const child of node.children) groups.set(child.name, [...(groups.get(child.name) ?? []), child])
  for (const [name, children] of groups) {
    const values = children.map((child) => (child.children.length === 0 && Object.keys(child.attributes).length === 0
      ? coerce(child.text, numeric)
      : recordOf(child, numeric)))
    record[name] = values.length === 1 ? values[0] : values
  }
  if (node.children.length === 0 && node.text.trim().length > 0 && Object.keys(node.attributes).length > 0) record.text = coerce(node.text, numeric)
  return record
}

export function decodeXmlRecordsV1(text: string, params: XmlRecordsParamsV1): Record<string, unknown>[] {
  const path = params.recordPath.split('/').map((segment) => segment.trim()).filter((segment) => segment.length > 0)
  if (path.length === 0) throw new Error('xml records need a recordPath such as "tracklets/item"')
  const maxRecords = params.maxRecords ?? DEFAULT_MAX_RECORDS
  const numeric = params.numeric !== false
  const root = parseXmlTreeV1(text, params.maxDepth)
  let level: XmlNode[] = [root]
  for (const segment of path) level = level.flatMap((node) => node.children.filter((child) => child.name === segment))
  if (level.length > maxRecords) throw new Error(`xml records exceed maxRecords ${maxRecords}`)
  return level.map((node) => recordOf(node, numeric))
}
