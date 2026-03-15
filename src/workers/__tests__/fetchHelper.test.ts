/**
 * Unit tests for resolveFileEntry — worker-side fetch helper.
 *
 * Tests cover:
 * - File → ArrayBuffer pass-through
 * - URL string → fetch with success
 * - Retry on 5xx errors (exponential backoff)
 * - No retry on 4xx errors (except 429)
 * - Timeout via AbortSignal.timeout (mocked)
 * - Retry on network error (TypeError)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveFileEntry } from '../fetchHelper'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mockFetch.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveFileEntry', () => {
  describe('File input', () => {
    it('calls file.arrayBuffer() directly without fetch', async () => {
      const mockBuffer = new ArrayBuffer(16)
      const mockFile = { arrayBuffer: vi.fn().mockResolvedValue(mockBuffer) } as unknown as File

      const result = await resolveFileEntry(mockFile)
      expect(result).toBe(mockBuffer)
      expect(mockFile.arrayBuffer).toHaveBeenCalledOnce()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('URL string input — success', () => {
    it('fetches URL and returns ArrayBuffer on 200', async () => {
      const mockBuffer = new ArrayBuffer(32)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer),
      })

      const result = await resolveFileEntry('https://example.com/data.feather')
      expect(result).toBe(mockBuffer)
      expect(mockFetch).toHaveBeenCalledOnce()
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/data.feather',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
  })

  describe('URL string input — retry on 5xx', () => {
    it('retries on 500 and succeeds on second attempt', async () => {
      const mockBuffer = new ArrayBuffer(8)
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(mockBuffer),
        })

      const promise = resolveFileEntry('https://example.com/data.feather')
      const result = await promise
      expect(result).toBe(mockBuffer)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('throws after 3 failed attempts on 500', async () => {
      mockFetch
        .mockResolvedValue({ ok: false, status: 500 })

      await expect(resolveFileEntry('https://example.com/data.feather'))
        .rejects.toThrow('HTTP 500')
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })

  describe('URL string input — no retry on 4xx', () => {
    it('throws immediately on 404 without retry', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404 })

      await expect(resolveFileEntry('https://example.com/missing.feather'))
        .rejects.toThrow('HTTP 404')
      expect(mockFetch).toHaveBeenCalledOnce()
    })

    it('throws immediately on 403 without retry', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 403 })

      await expect(resolveFileEntry('https://example.com/secret'))
        .rejects.toThrow('HTTP 403')
      expect(mockFetch).toHaveBeenCalledOnce()
    })

    it('retries on 429 (Too Many Requests)', async () => {
      const mockBuffer = new ArrayBuffer(8)
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(mockBuffer),
        })

      const result = await resolveFileEntry('https://example.com/data.feather')
      expect(result).toBe(mockBuffer)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('URL string input — network error retry', () => {
    it('retries on TypeError (network error) and succeeds', async () => {
      const mockBuffer = new ArrayBuffer(8)
      mockFetch
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(mockBuffer),
        })

      const result = await resolveFileEntry('https://example.com/data.feather')
      expect(result).toBe(mockBuffer)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('throws after 3 network failures', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(resolveFileEntry('https://example.com/data.feather'))
        .rejects.toThrow('Failed to fetch')
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })

  describe('URL string input — timeout', () => {
    it('passes AbortSignal.timeout to fetch', async () => {
      const mockBuffer = new ArrayBuffer(8)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockBuffer),
      })

      await resolveFileEntry('https://example.com/data.feather')

      const callArgs = mockFetch.mock.calls[0]
      expect(callArgs[1]).toHaveProperty('signal')
      expect(callArgs[1].signal).toBeInstanceOf(AbortSignal)
    })
  })
})
