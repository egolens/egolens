import { describe, expect, it } from 'vitest'
import { detectWebMcpAgentV1 } from '../authoring/agentDetection'

const fakeWindow = (navigatorContext: unknown, documentContext: unknown, userAgent = 'Mozilla/5.0') =>
  ({ navigator: { modelContext: navigatorContext, userAgent }, document: { modelContext: documentContext } }) as unknown as Window & typeof globalThis

describe('detectWebMcpAgentV1', () => {
  it('recognizes Codex by codex-prefixed fields on navigator.modelContext', () => {
    expect(detectWebMcpAgentV1(fakeWindow({ registerTool() {}, codexSessionId: 'x' }, undefined))).toEqual({ available: true, kind: 'codex', chatLocation: 'sidebar-left' })
  })
  it('recognizes Chrome native WebMCP and ChatGPT by user agent', () => {
    expect(detectWebMcpAgentV1(fakeWindow(undefined, { registerTool() {} })).kind).toBe('chrome')
    expect(detectWebMcpAgentV1(fakeWindow(undefined, { registerTool() {} }, 'ChatGPT/1.0')).kind).toBe('chatgpt')
  })
  it('reports no agent in a plain browser', () => {
    expect(detectWebMcpAgentV1(fakeWindow(undefined, undefined)).available).toBe(false)
  })
})
