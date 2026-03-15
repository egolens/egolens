/**
 * Unit tests for readJsonFile dual-source (File | string) support.
 *
 * Verifies that:
 * - File input: calls file.text() and parses JSON
 * - String input: uses string directly (pre-fetched JSON text)
 * - Missing file: returns empty array with warning
 * - Both produce identical results for the same JSON content
 */

import { describe, it, expect, vi } from 'vitest'
import { readJsonFile } from '../metadata'

describe('readJsonFile', () => {
  const sampleData = [
    { token: 'abc', name: 'scene-0001' },
    { token: 'def', name: 'scene-0002' },
  ]
  const sampleJson = JSON.stringify(sampleData)

  it('parses JSON from File input', async () => {
    const mockFile = {
      text: vi.fn().mockResolvedValue(sampleJson),
    } as unknown as File

    const map = new Map<string, File | string>([['scene.json', mockFile]])
    const result = await readJsonFile(map, 'scene.json')

    expect(result).toEqual(sampleData)
    expect(mockFile.text).toHaveBeenCalledOnce()
  })

  it('parses JSON from string input (pre-fetched text)', async () => {
    const map = new Map<string, File | string>([['scene.json', sampleJson]])
    const result = await readJsonFile(map, 'scene.json')

    expect(result).toEqual(sampleData)
  })

  it('returns identical results for File and string inputs', async () => {
    const mockFile = {
      text: vi.fn().mockResolvedValue(sampleJson),
    } as unknown as File

    const fileMap = new Map<string, File | string>([['scene.json', mockFile]])
    const stringMap = new Map<string, File | string>([['scene.json', sampleJson]])

    const fromFile = await readJsonFile(fileMap, 'scene.json')
    const fromString = await readJsonFile(stringMap, 'scene.json')

    expect(fromFile).toEqual(fromString)
  })

  it('returns empty array for missing file with console warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new Map<string, File | string>()

    const result = await readJsonFile(map, 'missing.json')

    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing.json'),
    )
    warnSpy.mockRestore()
  })

  it('handles empty JSON array from string', async () => {
    const map = new Map<string, File | string>([['empty.json', '[]']])
    const result = await readJsonFile(map, 'empty.json')
    expect(result).toEqual([])
  })
})
