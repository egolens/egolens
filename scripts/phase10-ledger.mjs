#!/usr/bin/env node

import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createDecisionLedgerEntryV1,
  validateDecisionLedgerV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

async function readLedger(filename) {
  try {
    const text = await readFile(filename, 'utf8')
    if (!text.trim()) return []
    return text.trimEnd().split('\n').map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(`Ledger line ${index + 1} is not JSON`)
      }
    })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

const options = parseArgs(process.argv.slice(2))
if (!options.ledger || !options.entry) throw new Error('Usage: phase10-ledger --ledger <ndjson> --entry <json>')
const ledgerPath = path.resolve(options.ledger)
const entries = await readLedger(ledgerPath)
for (const entry of entries) await validatePhase10SchemaV1(entry)
validateDecisionLedgerV1(entries)
const payload = JSON.parse(await readFile(path.resolve(options.entry), 'utf8'))
const entry = createDecisionLedgerEntryV1(entries, payload)
await validatePhase10SchemaV1(entry)
await mkdir(path.dirname(ledgerPath), { recursive: true })
const handle = await open(ledgerPath, 'a', 0o644)
try {
  await handle.writeFile(`${JSON.stringify(entry)}\n`)
  await handle.sync()
} finally {
  await handle.close()
}
process.stdout.write(`${JSON.stringify({
  ledgerId: entry.ledgerId,
  sequence: entry.sequence,
  event: entry.event,
  entryHash: entry.entryHash,
}, null, 2)}\n`)
