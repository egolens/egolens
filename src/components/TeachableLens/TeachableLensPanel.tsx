import { declaredSensorSummaryV1 } from '../../teachable/authoring/sensorConfiguration'
import AgentPromptHint from './AgentPromptHint'
import type { EgoLensAdapterRecipeV1 } from '../../teachable/recipe/types'
import type { SourceInventoryV1 } from '../../teachable/authoring/SourceInventory'
import { revisionRequestTextV1 } from '../../teachable/authoring/revisionRequest'
import { HUMAN_REVIEW_ISSUES_V1, type HumanReviewIssueV1 } from '../../teachable/authoring/review'
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
  onOpenInteractivePreview,
}: {
  session?: TeachableAuthoringSessionV1
  /** Provided by the full viewer only: render the validated recipe against the live inventory in the 3D viewer. */
  onOpenInteractivePreview?: (inventory: SourceInventoryV1, recipe: EgoLensAdapterRecipeV1) => void
}) {
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

  const [issues, setIssues] = useState<Partial<Record<HumanReviewCapabilityV1, HumanReviewIssueV1>>>({})
  const review = (capability: HumanReviewCapabilityV1, verdict: 'accepted' | 'rejected') => {
    const frames = state.validation?.presentedFrames[capability] ?? []
    try {
      session.submitHumanReview({
        capability,
        frameIndices: frames,
        verdict,
        ...(verdict === 'rejected' ? { issue: issues[capability] ?? 'other' } : {}),
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
            {!state.agentEngaged && <AgentPromptHint compact />}
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
            {(!preview.thumbnails || preview.thumbnails.length === 0) && (
              <div data-testid="preview-placeholder" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, border: `1px dashed ${colors.border}`, fontSize: 11, lineHeight: 1.5, color: colors.textDim }}>
                Nothing to look at yet: no camera or LiDAR data is bound on the sampled frames. Camera thumbnails with projected points and a bird's-eye view appear here once cameraImages and pointClouds are bound.
              </div>
            )}
            {preview.thumbnails && preview.thumbnails.length > 0 && (
              <div data-testid="review-thumbnails" style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                {preview.thumbnails.map((thumbnail) => (
                  <figure key={`${thumbnail.frameIndex}:${thumbnail.sensorId}`} style={{ margin: 0 }}>
                    <img src={thumbnail.dataUrl} alt={`${thumbnail.sensorId} frame ${thumbnail.frameIndex} with ${thumbnail.projectedPoints} projected points`} style={{ width: '100%', display: 'block', borderRadius: radius.sm, border: `1px solid ${colors.border}` }} />
                    <figcaption style={{ fontSize: 10, color: colors.textDim, marginTop: 3 }}>{thumbnail.sensorId} · frame {thumbnail.frameIndex} · {thumbnail.projectedPoints} pts</figcaption>
                  </figure>
                ))}
              </div>
            )}
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
              {onOpenInteractivePreview && (state.phase === 'review' || state.phase === 'finalized') && state.currentArtifact && (
                <button
                  disabled={busy}
                  onClick={() => {
                    const liveInventory = session.getInventory()
                    if (liveInventory) onOpenInteractivePreview(liveInventory, state.currentArtifact!)
                  }}
                  title="Render the current validated recipe against this folder in the interactive 3D viewer"
                  style={{ padding: '8px 12px', borderRadius: radius.sm, border: `1px solid ${colors.accentBlue}`, background: alpha(colors.accentBlue, 0.12), color: colors.textPrimary, fontWeight: 700, cursor: 'pointer' }}
                >
                  Open interactive preview
                </button>
              )}
              {state.phase === 'review' && <button disabled={busy} onClick={() => void finalize()} style={{ padding: '8px 12px', borderRadius: radius.sm, border: `1px solid ${colors.accent}`, background: alpha(colors.accent, 0.12), color: colors.accent, cursor: busy ? 'wait' : 'pointer' }}>Finalize</button>}
              {state.exportReady && state.currentArtifact && <button onClick={() => { try { downloadRecipeArtifactV1(state.currentArtifact!); setLocalError(null) } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)) } }} style={{ padding: '8px 12px', borderRadius: radius.sm, border: 0, background: colors.accent, color: colors.textOnAccent, fontWeight: 700, cursor: 'pointer' }}>Export JSON</button>}
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

        {(state.currentArtifact || state.sensorConfiguration) && (
          <div data-testid="declared-sensors" style={{ padding: 14, background: colors.bgSurface, border: `1px solid ${colors.border}`, borderRadius: radius.md }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{state.currentArtifact ? 'Declared sensors' : 'Confirmed sensor layout'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {declaredSensorSummaryV1(state.currentArtifact).map(({ modality, ids }) => {
                const expected = state.sensorConfiguration?.[modality]
                const mismatch = Boolean(state.currentArtifact) && expected !== undefined && expected !== ids.length
                return <div key={modality} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ fontWeight: 600, minWidth: 64 }}>{modality}</span>
                  <span>{state.currentArtifact ? `${ids.length}${expected !== undefined ? ` / ${expected} expected` : ''}` : `${expected ?? 0} expected`}</span>
                  {mismatch && <Pill tone="warning">mismatch</Pill>}
                  <span style={{ color: colors.textDim, fontSize: 10 }}>{state.currentArtifact ? (ids.length > 0 ? ids.map((id) => {
                    const samples = preview?.sensorSamples?.[id]
                    if (!samples) return id
                    const bound = samples.some((value) => value > 0)
                    return `${id}${bound ? ` [${samples.join(', ')}]` : ' (declared, never bound)'}`
                  }).join(' · ') : 'none declared') : 'waiting for a recipe'}</span>
                </div>
              })}
            </div>
          </div>
        )}

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
                    <select aria-label={`Issue for ${capability}`} value={issues[capability] ?? 'other'} onChange={(event) => setIssues({ ...issues, [capability]: event.currentTarget.value as HumanReviewIssueV1 })} style={{ fontSize: 11, background: colors.bgBase, color: colors.textSecondary, border: `1px solid ${colors.border}`, borderRadius: radius.sm }}>
                      {HUMAN_REVIEW_ISSUES_V1.map((issue) => <option key={issue} value={issue}>{issue}</option>)}
                    </select>
                    <button aria-label={`Reject ${capability}`} aria-pressed={existing?.verdict === 'rejected'} onClick={() => review(capability, 'rejected')} style={{ border: `1px solid ${colors.border}`, background: 'transparent', color: colors.danger, borderRadius: radius.sm, cursor: 'pointer' }}>Reject</button>
                  </div>
                </div>
              })}
            </div>
          </div>
        )}

        {state.diagnostics.some((item) => item.severity === 'warning') && (
          <div data-testid="consistency-warnings" style={{ padding: 14, whiteSpace: 'pre-wrap', background: alpha(colors.warning, 0.08), border: `1px solid ${alpha(colors.warning, 0.4)}`, color: colors.warning, borderRadius: radius.md, fontSize: 11, lineHeight: 1.5 }}>
            {state.diagnostics.filter((item) => item.severity === 'warning').map((item) => `${item.code}: ${item.hint}`).join('\n')}
          </div>
        )}

        {(localError || state.diagnostics.some((item) => item.severity === 'error')) && (
          <div style={{ padding: 14, whiteSpace: 'pre-wrap', background: alpha(colors.danger, 0.08), border: `1px solid ${alpha(colors.danger, 0.4)}`, color: colors.danger, borderRadius: radius.md, fontSize: 11, lineHeight: 1.5 }}>
            {localError ?? state.diagnostics.filter((item) => item.severity === 'error').map((item) => `${item.code}: ${item.hint}`).join('\n')}
          </div>
        )}

        <div style={{ padding: 14, background: colors.bgOverlay, borderRadius: radius.md, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: colors.textSecondary, fontSize: 12 }}>After reviewing a preview, ask Codex to use your feedback.</span>
          <button onClick={() => {
            void navigator.clipboard.writeText(revisionRequestTextV1({ reviews: state.reviews, diagnostics: state.diagnostics, currentArtifact: state.currentArtifact, sensorConfiguration: state.sensorConfiguration, sensorSamples: preview?.sensorSamples }))
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
