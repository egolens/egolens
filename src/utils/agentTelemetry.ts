import { detectWebMcpAgentV1 } from '../teachable/authoring/agentDetection'
import { trackTeaching } from './teachableTelemetry'

/** Page-lifetime capability observations, not proof that an agent called a tool. */
export function installAgentTelemetry(): () => void {
  let last = ''
  let codexReported = false
  const check = () => {
    const agent = detectWebMcpAgentV1()
    const key = `${agent.kind}:${agent.available}`
    if (key === last) return
    last = key
    trackTeaching('browser_context', { agent: agent.kind, available: Number(agent.available) })
    // An event name is queryable even before GA4 custom dimensions are registered.
    if (agent.kind === 'codex' && !codexReported) {
      codexReported = true
      trackTeaching('codex_visit', { agent: 'codex', available: 1 })
    }
  }
  check()
  let attempts = 0
  const timer = setInterval(() => {
    check()
    if (++attempts >= 30) clearInterval(timer)
  }, 1000)
  const visible = () => { if (document.visibilityState === 'visible') check() }
  window.addEventListener('focus', check)
  window.addEventListener('egolens:check-webmcp', check)
  document.addEventListener('visibilitychange', visible)
  return () => {
    clearInterval(timer)
    window.removeEventListener('focus', check)
    window.removeEventListener('egolens:check-webmcp', check)
    document.removeEventListener('visibilitychange', visible)
  }
}
