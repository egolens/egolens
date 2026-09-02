import { useRef, useState, useSyncExternalStore } from 'react'
import { colors, fonts, radius, alpha } from '../../theme'
import type { TeachableAuthoringSessionV1 } from '../../teachable/authoring/AuthoringSession'
import { downloadRecipeArtifactV1 } from '../../teachable/authoring/portability'
import { teachableAuthoringSession } from '../../teachable/authoring/browserSession'
import type { HumanReviewCapabilityV1 } from '../../teachable/authoring/review'
import { authoringPreviewStoreV1 } from '../../teachable/authoring/previewStore'
import { fetchRemoteRecipeV1 } from '../../teachable/share/RecipeTransport'

function shortHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 15)}…${hash.slice(-8)}` : '—'
}

function Pill({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'good' | 'warning' }) {
  const color = tone === 'good' ? colors.accent : tone === 'warning' ? colors.warning : colors.textSecondary
  return <span style={{ padding: '3px 8px', border: `1px solid ${alpha(color, 0.5)}`, borderRadius: 999, color, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em' }}>{children}</span>
}

export default function TeachableLensPanel({
  session = teachableAuthoringSession,
}: { session?: TeachableAuthoringSessionV1 }) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const preview = useSyncExternalStore(authoringPreviewStoreV1.subscribe, authoringPreviewStoreV1.getSnapshot, authoringPreviewStoreV1.getSnapshot)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [remoteRecipeUrl, setRemoteRecipeUrl] = useState('')
  const [remoteRecipeHash, setRemoteRecipeHash] = useState('')
  const inventory = state.inventory
  const reviewed = new Map(state.reviews.map((review) => [review.capability, review]))

  const importRecipe = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setLocalError(null)
    try {
      const result = await session.importArtifact(file)
      if (!result.ok) setLocalError(result.diagnostics.map((item) => `${item.code}: ${item.hint}`).join('\n'))
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const importRemoteRecipe = async () => {
    setBusy(true)
    setLocalError(null)
    try {
      const verified = await fetchRemoteRecipeV1(remoteRecipeUrl.trim(), remoteRecipeHash.trim())
      const result = await session.applyRevision(verified.recipe)
      if (!result.ok) setLocalError(result.diagnostics.map((item) => `${item.code}: ${item.hint}`).join('\n'))
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const review = (capability: HumanReviewCapabilityV1, verdict: 'accepted' | 'rejected') => {
    const frames = state.validation?.presentedFrames[capability] ?? []
    try {
      session.submitHumanReview({
        capability,
        frameIndices: frames,
        verdict,
        ...(verdict === 'rejected' ? { issue: 'other' as const } : {}),
      })
      setLocalError(null)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    }
  }

  const finalize = async () => {
    setBusy(true)
    try {
      await session.finalize()
      setLocalError(null)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 20px', fontFamily: fonts.sans }}>
      <div style={{ width: 'min(920px, 100%)', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', color: state.agentEngaged ? colors.accent : colors.accentBlue }}>
              {state.agentEngaged ? 'CODEX IS TEACHING EGOLENS' : 'TEACHABLE LENS · READY FOR CODEX'}
            </div>
            <h2 style={{ margin: '6px 0 4px', fontSize: 24 }}>Unknown dataset retained locally</h2>
            <p style={{ margin: 0, color: colors.textSecondary, fontSize: 13, lineHeight: 1.6 }}>
              {inventory?.entries.length ?? 0} authorized files are available for bounded inspection. Raw evidence stays in this browser session.
            </p>
          </div>
          <button onClick={() => session.revoke()} style={{ padding: '7px 11px', borderRadius: radius.sm, border: `1px solid ${colors.border}`, background: colors.bgSurface, color: colors.textSecondary, cursor: 'pointer' }}>
            Choose another folder
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {[
            { title: 'Codex proposed', value: state.currentArtifact?.identity.name ?? 'Waiting for a recipe', tone: state.currentArtifact ? 'good' as const : 'default' as const },
            { title: 'EgoLens validated', value: state.validation ? `${state.validation.capabilities.length} output capabilities` : state.phase === 'capability-gap' ? 'Capability gap found' : 'Not yet', tone: state.validation ? 'good' as const : state.phase === 'capability-gap' ? 'warning' as const : 'default' as const },
            { title: 'You reviewed', value: state.validation ? `${state.reviews.filter((item) => item.verdict === 'accepted').length} / ${state.validation.requiredReview.length} accepted` : 'No review requested', tone: state.exportReady ? 'good' as const : 'default' as const },
          ].map((card) => (
            <div key={card.title} style={{ padding: 14, background: colors.bgSurface, border: `1px solid ${colors.border}`, borderRadius: radius.md }}>
              <div style={{ fontSize: 10, color: colors.textDim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{card.title}</div>
              <div style={{ marginTop: 7, fontSize: 13, color: card.tone === 'good' ? colors.accent : card.tone === 'warning' ? colors.warning : colors.textPrimary }}>{card.value}</div>
            </div>
          ))}
        </div>

        {preview && state.currentArtifact && (
          <div style={{ padding: 16, background: alpha(colors.accentBlue, 0.08), border: `1px solid ${alpha(colors.accentBlue, 0.35)}`, borderRadius: radius.md }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: colors.accentBlue }}>Visible validated preview</div>
            <div style={{ marginTop: 8, fontSize: 12, color: colors.textSecondary }}>
              {preview.frameCount} timeline frames · sampled {preview.sampledFrames.join(', ')} · timestamps {preview.sampledTimestampsMicros.join(', ')} µs
            </div>
            {preview.capabilitySamples && <div style={{ marginTop: 8, fontSize: 11, color: colors.textDim, lineHeight: 1.6 }}>
              {Object.entries(preview.capabilitySamples).map(([capability, counts]) => `${capability}: [${counts.join(', ')}]`).join(' · ')}
            </div>}
          </div>
        )}

        <div style={{ padding: 16, background: colors.bgSurface, border: `1px solid ${colors.border}`, borderRadius: radius.md }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Portable recipe</div>
              <div style={{ color: colors.textDim, fontSize: 11, marginTop: 4 }}>Current recipe: {shortHash(state.currentRecipeHash)}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input ref={fileInput} type="file" accept=".json,.egolens-adapter.json,application/json" hidden onChange={(event) => void importRecipe(event.target.files?.[0])} />
              <button disabled={busy} onClick={() => fileInput.current?.click()} style={{ padding: '8px 12px', borderRadius: radius.sm, border: `1px solid ${colors.border}`, background: colors.bgOverlay, color: colors.textPrimary, cursor: busy ? 'wait' : 'pointer' }}>Import JSON</button>
              {state.phase === 'review' && <button disabled={busy} onClick={() => void finalize()} style={{ padding: '8px 12px', borderRadius: radius.sm, border: `1px solid ${colors.accent}`, background: alpha(colors.accent, 0.12), color: colors.accent, cursor: busy ? 'wait' : 'pointer' }}>Finalize</button>}
              {state.exportReady && state.currentArtifact && <button onClick={() => downloadRecipeArtifactV1(state.currentArtifact!)} style={{ padding: '8px 12px', borderRadius: radius.sm, border: 0, background: colors.accent, color: colors.textOnAccent, fontWeight: 700, cursor: 'pointer' }}>Export JSON</button>}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) minmax(220px, 1fr) auto', gap: 8, marginTop: 12 }}>
            <input
              aria-label="Remote recipe URL"
              type="url"
              value={remoteRecipeUrl}
              onChange={(event) => setRemoteRecipeUrl(event.target.value)}
              placeholder="https://…/adapter.json"
              style={{ minWidth: 0, padding: '8px 10px', borderRadius: radius.sm, border: `1px solid ${colors.border}`, background: colors.bgOverlay, color: colors.textPrimary }}
            />
            <input
              aria-label="Expected recipe hash"
              value={remoteRecipeHash}
              onChange={(event) => setRemoteRecipeHash(event.target.value)}
              placeholder="sha256:…"
              style={{ minWidth: 0, padding: '8px 10px', borderRadius: radius.sm, border: `1px solid ${colors.border}`, background: colors.bgOverlay, color: colors.textPrimary, fontFamily: fonts.mono }}
            />
            <button
              disabled={busy || !remoteRecipeUrl.trim() || !remoteRecipeHash.trim()}
              onClick={() => void importRemoteRecipe()}
              style={{ padding: '8px 12px', borderRadius: radius.sm, border: `1px solid ${colors.border}`, background: colors.bgOverlay, color: colors.textPrimary, cursor: busy ? 'wait' : 'pointer' }}
            >Import URL</button>
          </div>
        </div>

        {state.validation && state.validation.requiredReview.length > 0 && (
          <div style={{ padding: 16, background: colors.bgSurface, border: `1px solid ${colors.border}`, borderRadius: radius.md }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Capability-aware human review</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {state.validation.requiredReview.map((capability) => {
                const existing = reviewed.get(capability)
                const frames = state.validation?.presentedFrames[capability] ?? []
                return <div key={capability} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', padding: '8px 0', borderTop: `1px solid ${colors.borderSubtle}` }}>
                  <div><span style={{ fontSize: 12, fontWeight: 600 }}>{capability}</span><span style={{ marginLeft: 8, color: colors.textDim, fontSize: 10 }}>frames {frames.join(', ')}</span></div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {existing && <Pill tone={existing.verdict === 'accepted' ? 'good' : 'warning'}>{existing.verdict}</Pill>}
                    <button aria-label={`Accept ${capability}`} aria-pressed={existing?.verdict === 'accepted'} onClick={() => review(capability, 'accepted')} style={{ border: `1px solid ${colors.border}`, background: 'transparent', color: colors.accent, borderRadius: radius.sm, cursor: 'pointer' }}>Accept</button>
                    <button aria-label={`Reject ${capability}`} aria-pressed={existing?.verdict === 'rejected'} onClick={() => review(capability, 'rejected')} style={{ border: `1px solid ${colors.border}`, background: 'transparent', color: colors.danger, borderRadius: radius.sm, cursor: 'pointer' }}>Reject</button>
                  </div>
                </div>
              })}
            </div>
          </div>
        )}

        {(localError || state.diagnostics.length > 0) && (
          <div style={{ padding: 14, whiteSpace: 'pre-wrap', background: alpha(colors.danger, 0.08), border: `1px solid ${alpha(colors.danger, 0.4)}`, color: colors.danger, borderRadius: radius.md, fontSize: 11, lineHeight: 1.5 }}>
            {localError ?? state.diagnostics.map((item) => `${item.code}: ${item.hint}`).join('\n')}
          </div>
        )}

        <div style={{ padding: 14, background: colors.bgOverlay, borderRadius: radius.md, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: colors.textSecondary, fontSize: 12 }}>After reviewing a preview, ask Codex to use your feedback.</span>
          <button onClick={() => {
            void navigator.clipboard.writeText('Revise the adapter using my latest Teachable Lens review.')
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }} style={{ padding: '7px 10px', borderRadius: radius.sm, border: `1px solid ${colors.border}`, background: colors.bgSurface, color: colors.textPrimary, cursor: 'pointer' }}>
            {copied ? 'Copied' : 'Copy revision prompt'}
          </button>
        </div>
      </div>
    </div>
  )
}
