import { useEffect, useState } from 'react'
import { colors, fonts, radius, alpha } from '../../theme'
import { TEACH_PROMPT_V1, useWebMcpAgentV1, type WebMcpAgentV1 } from '../../teachable/authoring/agentDetection'
import type { AgentActivityV1 } from '../../teachable/authoring/AuthoringSession'
import type { HumanReviewCapabilityV1, HumanReviewIssueV1 } from '../../teachable/authoring/review'

/**
 * Building blocks of the Teachable Lens flow (P0 → teach → review → sealed),
 * implemented from the "Hybrid Prototype" design. Everything here reads from
 * props so the isolated author build can use it without the viewer store.
 */

export const mono = "'SF Mono', Consolas, ui-monospace, Menlo, monospace"

let pulseInjected = false
/** One-time keyframes for the pulsing dots and eyebrows. */
export function usePulseKeyframes(): void {
  useEffect(() => {
    if (pulseInjected || typeof document === 'undefined') return
    pulseInjected = true
    const style = document.createElement('style')
    style.textContent = '@keyframes tl-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } } @keyframes tl-arrive { 0% { background: rgba(56,189,248,0.28); } 100% { background: transparent; } } @media (prefers-reduced-motion: reduce) { .tl-pulse, .tl-arrive { animation: none !important; } }'
    document.head.appendChild(style)
  }, [])
}

export const pulse = (seconds = 1.6): React.CSSProperties => ({ animation: `tl-pulse ${seconds}s ease-in-out infinite` })

export function agentNames(agent: WebMcpAgentV1): { readonly name: string; readonly upper: string; readonly ask: string; readonly where: string } {
  switch (agent.kind) {
    case 'codex': return { name: 'Codex', upper: 'CODEX', ask: 'Ask Codex in the sidebar to start', where: 'in the chat sidebar on the left' }
    case 'chatgpt': return { name: 'ChatGPT', upper: 'CHATGPT', ask: 'Ask ChatGPT in its chat to start', where: 'in the ChatGPT chat' }
    default: return { name: 'your agent', upper: agent.available ? 'AN AGENT' : 'YOUR AGENT', ask: 'Ask your agent to start', where: '' }
  }
}

/** Codex mark rendered as a mask so it takes any color; only for the Codex host. */
export function AgentMark({ agent, size = 14, color = colors.textPrimary }: { agent: WebMcpAgentV1; size?: number; color?: string }) {
  if (agent.kind !== 'codex') return null
  const maskUrl = `url('${import.meta.env.BASE_URL ?? '/'}codex-mono.svg') center / contain no-repeat`
  return <span aria-hidden style={{ display: 'inline-block', width: size, height: size, flexShrink: 0, background: color, WebkitMask: maskUrl, mask: maskUrl }} />
}

export function StatTile({ label, value, sub, subColor }: { label: string; value: string; sub: string; subColor?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '10px 12px', background: colors.bgSurface, border: `1px solid ${colors.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: colors.textDim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ marginTop: 4, fontFamily: mono, fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 10, color: subColor ?? colors.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
    </div>
  )
}

export interface MeterSegment { readonly cap: string; readonly state: 'accepted' | 'rejected' | 'pending' | 'unbound' }
export function CapabilityMeter({ segments }: { segments: readonly MeterSegment[] }) {
  if (segments.length === 0) return null
  return (
    <div data-testid="capability-meter" style={{ display: 'flex', gap: 3 }}>
      {segments.map((segment) => (
        <div key={segment.cap} title={`${segment.cap}: ${segment.state}`} style={{ flex: 1, height: 5, borderRadius: 999, background: segment.state === 'accepted' ? colors.accent : segment.state === 'rejected' ? colors.danger : segment.state === 'pending' ? colors.accentBlue : colors.bgHover }} />
      ))}
    </div>
  )
}

function formatMs(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s` }

export function ActivityFeed({ activity, validating, agent, waitingForReview, maxRows, compact }: {
  activity: readonly AgentActivityV1[]
  validating?: boolean
  agent: WebMcpAgentV1
  waitingForReview?: boolean
  maxRows?: number
  compact?: boolean
}) {
  const names = agentNames(agent)
  // Newest first: the person watches what the agent is doing now, so the
  // latest call must land at the top instead of below the fold.
  const rows = [...(maxRows ? activity.slice(-maxRows) : activity)].reverse()
  const newestAt = activity[activity.length - 1]?.at
  const color = (kind: AgentActivityV1['kind']) => kind === 'bad' ? colors.danger : kind === 'ok' ? colors.accent : colors.textSecondary
  const revisionIndex = new Map<AgentActivityV1, number>()
  let n = 0
  for (const entry of activity) if (entry.tool === 'apply_revision') { n += 1; revisionIndex.set(entry, n) }
  return (
    <div data-testid="agent-activity">
      <div style={{ fontSize: 10, fontWeight: 700, color: colors.textDim, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: compact ? 6 : 10 }}>Agent activity</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 9, maxHeight: compact ? 96 : 260, overflowY: 'auto', fontFamily: mono, fontSize: 11, lineHeight: 1.45, WebkitMaskImage: 'linear-gradient(to bottom, #000 82%, transparent)', maskImage: 'linear-gradient(to bottom, #000 82%, transparent)', paddingBottom: 12 }}>
        {rows.length === 0 && !validating && (
          <div style={{ color: colors.textDim }}>{agent.available ? `No tool calls yet — waiting for ${names.name}.` : 'No agent attached to this page yet.'}</div>
        )}
        {validating && (
          <div className="tl-pulse" style={{ display: 'flex', gap: 10, alignItems: 'baseline', ...pulse() }}>
            <span style={{ color: colors.textDim, flexShrink: 0, width: 40 }}>now</span>
            <div><span style={{ color: colors.warning, fontWeight: 700 }}>apply_revision</span><div style={{ color: colors.textSecondary }}>compile → bind → sample frames → checks</div></div>
          </div>
        )}
        {waitingForReview && !validating && (
          <div className="tl-pulse" style={{ display: 'flex', gap: 10, alignItems: 'baseline', ...pulse() }}>
            <span style={{ color: colors.textDim, flexShrink: 0, width: 40 }}>now</span>
            <div><span style={{ color: colors.textSecondary, fontWeight: 700 }}>get_state</span><div style={{ color: colors.textSecondary }}>{names.name === 'your agent' ? 'Your agent is waiting for your review' : `${names.name} is waiting for your review`}</div></div>
          </div>
        )}
        {rows.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className={entry.at === newestAt ? 'tl-arrive' : undefined} style={{ display: 'flex', gap: 10, alignItems: 'baseline', borderRadius: 6, margin: '0 -4px', padding: '0 4px', ...(entry.at === newestAt ? { animation: 'tl-arrive 1.4s ease-out 1' } : {}) }}>
            <span style={{ color: colors.textDim, flexShrink: 0, width: 40, fontVariantNumeric: 'tabular-nums' }}>{formatMs(entry.ms)}</span>
            <div style={{ minWidth: 0 }}>
              <span style={{ color: entry.kind === 'ok' ? colors.accent : colors.accentBlue, fontWeight: 700 }}>{entry.tool}</span>
              {(entry.arg || revisionIndex.has(entry)) && <span style={{ color: colors.textDim }}> {revisionIndex.has(entry) ? `#${revisionIndex.get(entry)}` : ''}{entry.arg ? ` ${entry.arg}` : ''}</span>}
              <div style={{ color: color(entry.kind), overflowWrap: 'anywhere' }}>{entry.result}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Card offering the one-line prompt, or the no-host call to action. */
export function AgentAskCard({ agent, onPromptCopied }: { agent: WebMcpAgentV1; onPromptCopied?: () => void }) {
  const [copied, setCopied] = useState(false)
  const names = agentNames(agent)
  const copy = () => {
    void navigator.clipboard?.writeText(TEACH_PROMPT_V1).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) })
    onPromptCopied?.()
  }
  if (!agent.available) {
    const tile = (href: string, title: string, sub: string, monoSub = false, mark = false) => (
      <a href={href} target="_blank" rel="noreferrer" style={{ display: 'block', padding: 12, border: `1px solid ${colors.border}`, borderRadius: 10, background: colors.bgBase, textDecoration: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>{mark && <AgentMark agent={{ available: true, kind: 'codex', chatLocation: 'sidebar-left' }} />}<span style={{ fontSize: 12, fontWeight: 700, color: colors.textPrimary }}>{title}</span></div>
        <div style={{ marginTop: 5, fontSize: monoSub ? 10 : 11, lineHeight: 1.5, color: colors.textDim, fontFamily: monoSub ? mono : undefined }}>{sub}</div>
      </a>
    )
    return (
      <div data-testid="agent-cta" style={{ marginTop: 28, padding: 20, border: `1px solid ${colors.border}`, borderRadius: 14, background: colors.bgSurface }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: colors.textDim }} /><span style={{ fontSize: 13, fontWeight: 700 }}>No WebMCP host detected</span></div>
        <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6, color: colors.textSecondary }}>This page's teaching tools are registered, but no agent is listening — this browser doesn't expose WebMCP. Open egolens.org in one of these, then drop the folder again:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 12 }}>
          {tile('https://openai.com/codex/', 'Codex app', 'In-app browser, chat sidebar on the left', false, true)}
          {tile('https://chatgpt.com/download', 'ChatGPT app', 'Built-in browser, no flags needed')}
          {tile('https://developer.chrome.com/docs/ai/webmcp', 'Chrome 146+', 'chrome://flags/#enable-webmcp-testing', true)}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: colors.textDim }}>Once connected, ask: <span style={{ fontFamily: mono, color: colors.textSecondary }}>“{TEACH_PROMPT_V1}”</span></div>
      </div>
    )
  }
  return (
    <div data-testid="agent-prompt-hint" style={{ marginTop: 28, padding: 20, border: `1px solid ${colors.accentBlue}`, borderRadius: 14, background: alpha(colors.accentBlue, 0.06), display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      {agent.chatLocation === 'sidebar-left' && <span aria-hidden style={{ fontSize: 22, color: colors.accentBlue }}>←</span>}
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700 }}><AgentMark agent={agent} size={15} />{names.ask}</div>
        <div style={{ marginTop: 7, fontFamily: mono, fontSize: 14, color: colors.textPrimary }}>“{TEACH_PROMPT_V1}”</div>
        <div style={{ marginTop: 6, fontSize: 11, color: colors.textDim }}>Teaching starts on its first tool call — you review everything before it's saved.</div>
      </div>
      <button onClick={copy} style={{ padding: '11px 16px', borderRadius: 8, border: 0, background: colors.accentBlue, color: '#000', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>{copied ? 'Copied' : 'Copy prompt'}</button>
    </div>
  )
}

/** The issues that make sense for each capability (the prototype's per-capability lists). */
export function issuesForCapability(capability: HumanReviewCapabilityV1): readonly HumanReviewIssueV1[] {
  switch (capability) {
    case 'timeline': return ['out-of-sync', 'other']
    case 'egoPoses': return ['drift', 'other']
    case 'pointClouds': return ['mirrored', 'upside-down', 'wrong-scale', 'other']
    case 'cameraImages': return ['mirrored', 'upside-down', 'out-of-sync', 'other']
    case 'boxes3d': return ['misaligned', 'wrong-scale', 'drift', 'wrong-labels', 'other']
    case 'boxes2d': return ['misaligned', 'wrong-scale', 'wrong-labels', 'other']
    case 'projection': return ['misaligned', 'out-of-sync', 'other']
    case 'segmentation': return ['wrong-labels', 'other']
    case 'keypoints': return ['misaligned', 'wrong-labels', 'other']
    default: return ['other']
  }
}

export function useAgent(): WebMcpAgentV1 { return useWebMcpAgentV1() }

export const stageFont = fonts.sans
export const stageRadius = radius
