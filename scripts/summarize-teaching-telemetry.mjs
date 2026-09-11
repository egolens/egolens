// Usage: node scripts/summarize-teaching-telemetry.mjs exported-batch.json [...]
import { readFileSync } from 'node:fs'
const cases = new Map()
for (const path of process.argv.slice(2)) {
  for (const record of JSON.parse(readFileSync(path, 'utf8')).records ?? []) {
    if (!cases.has(record.case_id)) cases.set(record.case_id, new Map())
    cases.get(record.case_id).set(record.sequence, record)
  }
}
for (const [id, records] of cases) {
  console.log(`\nCase ${id}`)
  for (const r of [...records.values()].sort((a, b) => a.sequence - b.sequence)) {
    const p = r.props
    console.log(`${r.sequence}. ${r.event} ${p.tool ?? ''} ${p.outcome ?? p.phase ?? ''} revision=${p.revision_id ?? 'unassigned'} parent=${p.parent_id ?? 'none'}`)
    if (p.capability) console.log(`   Review: ${p.capability} ${p.issue ?? ''}`)
    if (r.detail?.codes?.length) console.log(`   Diagnostics: ${r.detail.codes.join(', ')}`)
    for (const c of r.detail?.changes ?? []) console.log(`   ${c.change}: ${c.operator}; params=${c.parameters.join(',') || 'none'}; inputs changed=${Boolean(c.inputs_changed)}`)
  }
}
