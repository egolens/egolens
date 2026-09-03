import { useState } from 'react'
import { colors } from '../../theme'
import { TEACH_PROMPT_V1, useWebMcpAgentV1 } from '../../teachable/authoring/agentDetection'

/**
 * Tells the person what to say to the agent that has discovered this page's
 * WebMCP tools, and where that agent's chat is. Rendered only when a host is
 * detected, so a plain browser never sees it.
 */
export default function AgentPromptHint({ compact = false }: { compact?: boolean }) {
  const agent = useWebMcpAgentV1()
  const [copied, setCopied] = useState(false)
  if (!agent.available) {
    // No WebMCP host: say what would make this folder readable and where to get one.
    const link = (href: string, label: string) => (
      <a href={href} target="_blank" rel="noreferrer" style={{ color: colors.accentBlue, textDecoration: 'underline' }}>{label}</a>
    )
    return (
      <div data-testid="agent-cta" style={{ marginTop: compact ? 8 : 14, padding: '10px 12px', borderRadius: 10, border: `1px solid ${colors.border}`, background: colors.bgSurface, fontSize: 12, lineHeight: 1.6, color: colors.textSecondary }}>
        <strong style={{ color: colors.textPrimary }}>No adapter yet, and no agent is attached to this page.</strong> Teachable Lens lets an agent teach EgoLens to read this format by writing a portable recipe while you review the rendering.
        Open this page in a browser that exposes WebMCP tools to its agent: the {link('https://openai.com/codex/', 'Codex app')} (in-app browser, chat on the left), the {link('https://chatgpt.com/download', 'ChatGPT app')} browser, or {link('https://developer.chrome.com/docs/ai/webmcp', 'Chrome 146+ with WebMCP enabled')} (chrome://flags/#enable-webmcp-testing). Then ask: “{TEACH_PROMPT_V1}”
      </div>
    )
  }
  const name = agent.kind === 'codex' ? 'Codex' : agent.kind === 'chatgpt' ? 'ChatGPT' : 'your agent'
  const where = agent.chatLocation === 'sidebar-left' ? ' in the chat sidebar on the left' : agent.chatLocation === 'app' ? ' in the chat' : ''
  const copy = () => {
    void navigator.clipboard?.writeText(TEACH_PROMPT_V1).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <div data-testid="agent-prompt-hint" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: compact ? 8 : 14, padding: '10px 12px', borderRadius: 10, border: `1px solid ${colors.accentBlue}`, background: colors.bgSurface }}>
      {agent.chatLocation === 'sidebar-left' && <span aria-hidden style={{ fontSize: 18, color: colors.accentBlue }}>←</span>}
      <div style={{ flex: 1, minWidth: 220, fontSize: 12, lineHeight: 1.5, color: colors.textSecondary }}>
        <strong style={{ color: colors.textPrimary }}>{name} can see this page's tools.</strong> Ask {name}{where}:
        <div style={{ marginTop: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: colors.textPrimary }}>“{TEACH_PROMPT_V1}”</div>
      </div>
      <button onClick={copy} style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgOverlay, color: colors.textPrimary, cursor: 'pointer', fontSize: 12 }}>
        {copied ? 'Copied' : 'Copy prompt'}
      </button>
    </div>
  )
}
