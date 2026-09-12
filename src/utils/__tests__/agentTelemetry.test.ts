// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { detectWebMcpAgentV1 } from '../../teachable/authoring/agentDetection'
import { installAgentTelemetry } from '../agentTelemetry'
import { trackTeaching } from '../teachableTelemetry'

vi.mock('../../teachable/authoring/agentDetection', () => ({ detectWebMcpAgentV1: vi.fn() }))
vi.mock('../teachableTelemetry', () => ({ trackTeaching: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('observes late Codex injection without counting focus or rechecks as new visits', () => {
  vi.useFakeTimers()
  vi.mocked(detectWebMcpAgentV1).mockReturnValue({ available: false, kind: 'unknown', chatLocation: null })
  const dispose = installAgentTelemetry()
  vi.advanceTimersByTime(2000)
  expect(trackTeaching).toHaveBeenCalledTimes(1)
  vi.mocked(detectWebMcpAgentV1).mockReturnValue({ available: true, kind: 'codex', chatLocation: 'sidebar-left' })
  vi.advanceTimersByTime(1000)
  window.dispatchEvent(new Event('focus'))
  window.dispatchEvent(new Event('egolens:check-webmcp'))
  vi.advanceTimersByTime(30000)
  expect(trackTeaching).toHaveBeenCalledTimes(3)
  expect(trackTeaching).toHaveBeenCalledWith('codex_visit', { agent: 'codex', available: 1 })
  dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not call a generic WebMCP browser Codex', () => {
  vi.useFakeTimers()
  vi.mocked(detectWebMcpAgentV1).mockReturnValue({ available: true, kind: 'chrome', chatLocation: null })
  const dispose = installAgentTelemetry()
  vi.advanceTimersByTime(31000)
  expect(trackTeaching).toHaveBeenCalledExactlyOnceWith('browser_context', { agent: 'chrome', available: 1 })
  dispose()
})
