import { useEffect, useState } from 'react'

export type WebMcpAgentKindV1 = 'codex' | 'chatgpt' | 'chrome' | 'unknown'

export interface WebMcpAgentV1 {
  readonly available: boolean
  readonly kind: WebMcpAgentKindV1
  /** Where the agent's chat lives relative to the page, for the affordance copy. */
  readonly chatLocation: 'sidebar-left' | 'app' | null
}

function ownAndPrototypeKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  const keys = new Set<string>(Object.getOwnPropertyNames(value))
  let proto = Object.getPrototypeOf(value)
  for (let depth = 0; proto && proto !== Object.prototype && depth < 3; depth += 1) {
    for (const key of Object.getOwnPropertyNames(proto)) keys.add(key)
    proto = Object.getPrototypeOf(proto)
  }
  return [...keys]
}

/**
 * Which WebMCP host is driving this page. Codex's in-app browser exposes
 * codex-prefixed fields on navigator.modelContext; Chrome's native
 * implementation lives on document.modelContext; ChatGPT's browser identifies
 * itself in the user agent. The result only changes wording on the page.
 */
export function detectWebMcpAgentV1(win: Window & typeof globalThis = window): WebMcpAgentV1 {
  const navigatorContext = (win.navigator as Navigator & { modelContext?: unknown }).modelContext
  const documentContext = (win.document as Document & { modelContext?: unknown }).modelContext
  const codex = ownAndPrototypeKeys(navigatorContext).some((key) => key.toLowerCase().startsWith('codex'))
    || ownAndPrototypeKeys(documentContext).some((key) => key.toLowerCase().startsWith('codex'))
  if (codex) return { available: true, kind: 'codex', chatLocation: 'sidebar-left' }
  const available = Boolean(navigatorContext) || Boolean(documentContext)
  if (!available) return { available: false, kind: 'unknown', chatLocation: null }
  if (/ChatGPT/iu.test(win.navigator.userAgent)) return { available: true, kind: 'chatgpt', chatLocation: 'app' }
  return { available: true, kind: 'chrome', chatLocation: null }
}

/** Re-detects a few times after mount because hosts inject the context late. */
export function useWebMcpAgentV1(): WebMcpAgentV1 {
  const [agent, setAgent] = useState<WebMcpAgentV1>(() => (typeof window === 'undefined' ? { available: false, kind: 'unknown', chatLocation: null } : detectWebMcpAgentV1()))
  useEffect(() => {
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      const next = detectWebMcpAgentV1()
      setAgent((current) => (current.available === next.available && current.kind === next.kind ? current : next))
      if (next.available || attempts >= 10) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])
  return agent
}

export const TEACH_PROMPT_V1 = 'Teach EgoLens this dataset.'
