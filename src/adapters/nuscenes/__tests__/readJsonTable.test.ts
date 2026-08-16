/**
 * readJsonTable — reading a metadata table reports WHY it failed.
 *
 * The predecessor returned `[]` with a console warning for anything it could
 * not read, so a missing table, a typo'd filename and a host answering 200 +
 * index.html were indistinguishable: all three produced a blank viewer.
 */

import { describe, it, expect, vi } from 'vitest'
import { readJsonTable } from '../metadata'

const rows = [
  { token: 'abc', name: 'scene-0001' },
  { token: 'def', name: 'scene-0002' },
]
const json = JSON.stringify(rows)

const fileOf = (text: string) =>
  ({ text: vi.fn().mockResolvedValue(text) }) as unknown as File

describe('readJsonTable', () => {
  it('reads a table from a File and from pre-fetched text identically', async () => {
    const file = fileOf(json)
    const fromFile = await readJsonTable(new Map([['scene.json', file]]), 'scene.json')
    const fromText = await readJsonTable(new Map([['scene.json', json]]), 'scene.json')

    expect(fromFile).toEqual({ status: 'ok', rows })
    expect(fromFile).toEqual(fromText)
    expect(file.text).toHaveBeenCalledOnce()
  })

  it('reports a missing table as missing, not as empty', async () => {
    expect(await readJsonTable(new Map(), 'ego_pose.json')).toEqual({ status: 'missing' })
  })

  it('distinguishes a legitimately empty table from a missing one', async () => {
    // v1.0-test ships an empty sample_annotation.json; that is not a failure.
    expect(await readJsonTable(new Map([['a.json', '[]']]), 'a.json'))
      .toEqual({ status: 'ok', rows: [] })
  })

  it('quotes the opening bytes when a host serves HTML instead of the file', async () => {
    const map = new Map([['scene.json', '<!doctype html>\n<html lang="en">\n  <head>']])
    const read = await readJsonTable(map, 'scene.json')

    expect(read.status).toBe('unreadable')
    expect(read.status === 'unreadable' && read.reason).toContain('<!doctype html')
  })

  it('rejects valid JSON that is not a table', async () => {
    const read = await readJsonTable(new Map([['scene.json', '{"token":"abc"}']]), 'scene.json')

    expect(read.status).toBe('unreadable')
    expect(read.status === 'unreadable' && read.reason).toContain('expected a JSON array')
  })

  it('reports an unreadable File rather than throwing', async () => {
    const file = { text: vi.fn().mockRejectedValue(new Error('NotReadableError')) } as unknown as File
    const read = await readJsonTable(new Map([['scene.json', file]]), 'scene.json')

    expect(read.status).toBe('unreadable')
    expect(read.status === 'unreadable' && read.reason).toContain('NotReadableError')
  })

  it('never throws — every outcome is a value the caller can aggregate', async () => {
    const cases: Array<Map<string, File | string>> = [
      new Map(),
      new Map([['x.json', 'not json at all']]),
      new Map([['x.json', '42']]),
      new Map([['x.json', json]]),
    ]
    for (const map of cases) {
      await expect(readJsonTable(map, 'x.json')).resolves.toHaveProperty('status')
    }
  })
})
