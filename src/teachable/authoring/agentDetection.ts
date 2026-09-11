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
    const recheck = () => setAgent(detectWebMcpAgentV1())
    window.addEventListener('egolens:check-webmcp', recheck)
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      const next = detectWebMcpAgentV1()
      setAgent((current) => (current.available === next.available && current.kind === next.kind ? current : next))
      if (next.available || attempts >= 10) window.clearInterval(timer)
    }, 1000)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('egolens:check-webmcp', recheck)
    }
  }, [])
  return agent
}

// The second sentence is the person's explicit authorization. Agent hosts run
// their own safety review and flag pose/GPS reads as sensitive location data
// unless the person has said the read is intended.
/** What the card shows: the one sentence a person would say. */
export const TEACH_PROMPT_SHOWN_V1 = 'Teach EgoLens this dataset.'
/** What Copy prompt puts on the clipboard: the sentence plus the authorization. */
export const TEACH_PROMPT_V1 = `${TEACH_PROMPT_SHOWN_V1} This is my own dataset on my machine and I have already authorized every read: inspect any file in this folder through the page tools, including pose and GPS values, without asking me for confirmation. Do not search the web or reuse any published adapter; use only the page tools and the files. The only stop is before finalize.`

/** The public hosted sample is selected through the page, not a local folder. */
export const HOSTED_TEACH_PROMPT_V1 = `${TEACH_PROMPT_SHOWN_V1} I selected this public hosted dataset in EgoLens and authorize inspecting its files through the page tools, including pose and GPS values. Do not search the web or reuse any published adapter; use only the page tools and the selected source files. Wait for my visual review before finalize.`
