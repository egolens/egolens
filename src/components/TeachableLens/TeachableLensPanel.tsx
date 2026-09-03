import { useRef, useState, useSyncExternalStore } from 'react'
import { colors, radius, alpha } from '../../theme'
import type { EgoLensAdapterRecipeV1 } from '../../teachable/recipe/types'
import type { SourceInventoryV1 } from '../../teachable/authoring/SourceInventory'
import type { TeachableAuthoringSessionV1 } from '../../teachable/authoring/AuthoringSession'
import type { FinalizedArtifactRecordV1 } from '../../teachable/authoring/persistence'
import type { HumanReviewCapabilityV1, HumanReviewIssueV1 } from '../../teachable/authoring/review'
import { inferSensorConfigurationV1, type SensorConfigurationV1 } from '../../teachable/authoring/sensorConfiguration'
import { revisionRequestTextV1 } from '../../teachable/authoring/revisionRequest'
import { downloadRecipeArtifactV1 } from '../../teachable/authoring/portability'
import { teachableAuthoringSession } from '../../teachable/authoring/browserSession'
import { authoringPreviewStoreV1 } from '../../teachable/authoring/previewStore'
import { fetchRemoteRecipeV1 } from '../../teachable/share/RecipeTransport'
import SensorLayoutConfirm from './SensorLayoutConfirm'
import { ActivityFeed, AgentAskCard, AgentMark, CapabilityMeter, StatTile, agentNames, issuesForCapability, mono, pulse, useAgent, usePulseKeyframes, type MeterSegment } from './stages'

export interface TeachableLensPanelProps {
  session?: TeachableAuthoringSessionV1
  /** Docked beside the live viewer (review stage): render only the aside. */
  docked?: boolean
  /** Provided by the full viewer only: render a recipe against the live inventory in the 3D viewer. */
  onRenderDataset?: (inventory: SourceInventoryV1, recipe: EgoLensAdapterRecipeV1) => void
  /** Recipes finalized earlier in this browser that match the dropped folder. */
  savedRecipes?: readonly FinalizedArtifactRecordV1[]
  /** Ask the host to leave the authoring flow (drop zone). */
  onLeave?: () => void
}

const capabilityCount = (state: ReturnType<TeachableAuthoringSessionV1['getState']>) => state.validation?.requiredReview.length ?? 0

export default function TeachableLensPanel({ session = teachableAuthoringSession, docked = false, onRenderDataset, savedRecipes = [], onLeave }: TeachableLensPanelProps) {
  usePulseKeyframes()
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const preview = useSyncExternalStore(authoringPreviewStoreV1.subscribe, authoringPreviewStoreV1.getSnapshot, authoringPreviewStoreV1.getSnapshot)
  const agent = useAgent()
  const [localError, setLocalError] = useState<string | null>(null)

  const stage: 'p0' | 'teach' | 'review' | 'sealed' = state.phase === 'finalized'
    ? 'sealed'
    : state.currentArtifact && state.validation ? 'review' : state.agentEngaged ? 'teach' : 'p0'

  const liveInventory = session.getInventory()
  const renderDataset = () => {
    if (onRenderDataset && liveInventory && state.currentArtifact) onRenderDataset(liveInventory, state.currentArtifact)
  }

  if (stage === 'p0') {
    return <P0Stage session={session} state={state} agent={agent} savedRecipes={savedRecipes} onRenderSaved={(record) => { if (onRenderDataset && liveInventory) onRenderDataset(liveInventory, record.artifact) }} onLeave={onLeave} />
  }
  if (stage === 'sealed' && !docked) {
    return <SealedStage session={session} state={state} onRenderDataset={onRenderDataset ? renderDataset : undefined} onLeave={onLeave} error={localError} setError={setLocalError} />
  }
  const aside = (
    <ReviewDock
      session={session}
      state={state}
      preview={preview}
      agent={agent}
      stage={stage === 'sealed' ? 'review' : stage}
      error={localError}
      setError={setLocalError}
    />
  )
  if (docked) return aside
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', background: colors.bgDeep, backgroundImage: `linear-gradient(${alpha(colors.border, 0.6)} 1px, transparent 1px), linear-gradient(90deg, ${alpha(colors.border, 0.6)} 1px, transparent 1px)`, backgroundSize: '64px 64px', backgroundPosition: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="tl-pulse" style={{ width: 10, height: 10, borderRadius: 999, background: colors.accent, margin: '0 auto', ...pulse() }} />
          <div style={{ marginTop: 14, fontSize: 14, fontWeight: 600, color: colors.textSecondary }}>Nothing rendered yet</div>
          <div style={{ marginTop: 4, fontSize: 12, color: colors.textDim }}>The first validated revision will appear here automatically.</div>
        </div>
      </div>
      <div style={{ width: 'min(460px, 42vw)', flexShrink: 0, borderLeft: `1px solid ${colors.border}`, display: 'flex', minHeight: 0 }}>{aside}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// P0 — "A wild format appeared!"
// ---------------------------------------------------------------------------

function P0Stage({ session, state, agent, savedRecipes, onRenderSaved, onLeave }: {
  session: TeachableAuthoringSessionV1
  state: ReturnType<TeachableAuthoringSessionV1['getState']>
  agent: ReturnType<typeof useAgent>
  savedRecipes: readonly FinalizedArtifactRecordV1[]
  onRenderSaved: (record: FinalizedArtifactRecordV1) => void
  onLeave?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const inventory = session.getInventory()
  const configuration = state.sensorConfiguration ?? (state.inventory ? inferSensorConfigurationV1(state.inventory) : { lidar: 0, radar: 0, camera: 0 })
  const [draft, setDraft] = useState<SensorConfigurationV1>(configuration)
  const names = (modality: 'camera' | 'lidar' | 'radar') => configuration.names?.[modality] ?? []
  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'grid', placeItems: 'center', padding: '32px 24px' }}>
      <div style={{ width: 'min(820px, 100%)' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="tl-pulse" style={{ fontFamily: mono, color: colors.accent, fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', ...pulse(2.2) }}>A WILD FORMAT APPEARED!</div>
          <h2 style={{ margin: '10px 0 6px', fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em' }}>EgoLens doesn't know this format yet</h2>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: colors.textSecondary }}>Teach it once — your agent writes the adapter, you approve the render.<br />Files never leave this browser.</p>
        </div>

        {savedRecipes.length > 0 && (
          <div data-testid="saved-recipes" style={{ marginTop: 24, padding: '14px 16px', borderRadius: 14, border: `1px solid ${colors.accent}`, background: alpha(colors.accent, 0.06) }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>EgoLens already knows this layout</div>
            <div style={{ margin: '4px 0 10px', color: colors.textSecondary, fontSize: 12, lineHeight: 1.5 }}>A recipe finalized in this browser matches these files. Render with it now, or teach a new one below.</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {savedRecipes.slice(0, 3).map((record) => (
                <button key={record.recipeHash} onClick={() => onRenderSaved(record)} style={{ padding: '9px 13px', borderRadius: 8, border: 0, background: colors.accent, color: colors.textOnAccent, fontWeight: 700, cursor: 'pointer' }}>
                  Render with “{record.artifact.identity.name}” · {new Date(record.finalizedAt).toLocaleDateString()}
                </button>
              ))}
            </div>
          </div>
        )}

        <AgentAskCard agent={agent} />

        <div style={{ marginTop: 12, padding: '12px 16px', border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.bgSurface }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>Detected sensors <span style={{ fontWeight: 400, color: colors.textDim }}>— correct this if it's wrong</span></div>
              <div style={{ marginTop: 6, fontFamily: mono, fontSize: 12, color: colors.textSecondary, overflowWrap: 'anywhere' }}>
                camera <strong style={{ color: colors.textPrimary }}>{configuration.camera}</strong> · lidar <strong style={{ color: colors.textPrimary }}>{configuration.lidar}</strong> · radar <strong style={{ color: colors.textPrimary }}>{configuration.radar}</strong>
                <span style={{ color: colors.textDim }}> — {[...names('camera'), ...names('lidar'), ...names('radar')].join(', ') || 'no ids inferred'}</span>
              </div>
            </div>
            <button onClick={() => setEditing((value) => !value)} style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.textSecondary, fontSize: 12, cursor: 'pointer' }}>{editing ? 'Close' : 'Edit'}</button>
          </div>
          {editing && inventory && (
            <SensorLayoutConfirm
              key={JSON.stringify(configuration)}
              inventory={inventory}
              configuration={draft}
              onChange={setDraft}
              onConfirm={() => { session.start(inventory, { sensorConfiguration: draft }); setEditing(false) }}
            />
          )}
        </div>

        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'center', gap: 16, fontSize: 12, color: colors.textDim }}>
          <span>{state.inventory?.entries.length ?? 0} files authorized · stays in this browser</span>
          {onLeave && <button onClick={() => { session.revoke(); onLeave() }} style={{ background: 'none', border: 0, padding: 0, color: colors.accentBlue, textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>Choose another folder</button>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Teach + Review dock
// ---------------------------------------------------------------------------

function ReviewDock({ session, state, preview, agent, stage, error, setError }: {
  session: TeachableAuthoringSessionV1
  state: ReturnType<TeachableAuthoringSessionV1['getState']>
  preview: ReturnType<typeof authoringPreviewStoreV1.getSnapshot>
  agent: ReturnType<typeof useAgent>
  stage: 'teach' | 'review'
  error: string | null
  setError: (value: string | null) => void
}) {
  const names = agentNames(agent)
  const required = state.validation?.requiredReview ?? []
  const reviewed = new Map(state.reviews.map((review) => [review.capability, review]))
  const accepted = required.filter((cap) => reviewed.get(cap)?.verdict === 'accepted').length
  const rejected = required.filter((cap) => reviewed.get(cap)?.verdict === 'rejected').length
  const total = capabilityCount(state)
  const [selected, setSelected] = useState<HumanReviewCapabilityV1 | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<HumanReviewCapabilityV1, HumanReviewIssueV1>>>({})
  const [notes, setNotes] = useState<Partial<Record<HumanReviewCapabilityV1, string>>>({})
  const [copiedRevision, setCopiedRevision] = useState(false)
  const [busy, setBusy] = useState(false)
  const selectedCap = selected && required.includes(selected) ? selected : required[0] ?? null
  const validating = state.phase === 'validating'
  const lastRejection = [...state.activity].reverse().find((entry) => entry.tool === 'apply_revision' && entry.kind === 'bad')
  const lastApplyPassed = [...state.activity].reverse().find((entry) => entry.tool === 'apply_revision')?.kind === 'ok'
  const title = state.agentEngaged ? `${names.upper} IS TEACHING EGOLENS` : `TEACHABLE LENS · READY FOR ${names.upper}`
  const titleColor = state.agentEngaged ? colors.accent : colors.accentBlue

  const submit = (capability: HumanReviewCapabilityV1, verdict: 'accepted' | 'rejected') => {
    const frames = state.validation?.presentedFrames[capability] ?? []
    const note = (notes[capability] ?? '').trim()
    try {
      session.submitHumanReview({
        capability, frameIndices: frames, verdict,
        ...(verdict === 'rejected' ? { issue: note ? 'other' : (drafts[capability] ?? issuesForCapability(capability)[0] ?? 'other'), ...(note ? { note } : {}) } : {}),
      })
      setError(null)
      if (verdict === 'accepted') {
        const next = required.find((cap) => cap !== capability && !reviewed.has(cap))
        if (next) setSelected(next)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const finalize = async () => {
    setBusy(true)
    try { await session.finalize(); setError(null) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }
  const copyRevision = () => {
    void navigator.clipboard?.writeText(revisionRequestTextV1({ reviews: state.reviews, diagnostics: state.diagnostics, currentArtifact: state.currentArtifact, sensorConfiguration: state.sensorConfiguration, sensorSamples: preview?.sensorSamples }))
    setCopiedRevision(true)
    window.setTimeout(() => setCopiedRevision(false), 1500)
  }
  const meter: MeterSegment[] = required.length > 0
    ? required.map((cap) => ({ cap, state: reviewed.get(cap)?.verdict ?? 'pending' }))
    : Array.from({ length: 7 }, (_, index) => ({ cap: `slot ${index + 1}`, state: 'unbound' as const }))

  return (
    <aside data-testid="authoring-dock" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: colors.bgBase, minHeight: 0 }}>
      <div style={{ padding: '16px 16px 12px', borderBottom: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {stage === 'teach' && <span className="tl-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: titleColor, ...pulse() }} />}
          <AgentMark agent={agent} size={13} color={titleColor} />
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', color: titleColor }}>{title}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <StatTile label="Revision" value={state.revisionCount > 0 ? `#${state.revisionCount}` : '—'} sub={validating ? 'validating…' : state.revisionCount === 0 ? 'waiting' : lastApplyPassed ? 'passed' : 'rejected'} subColor={validating ? colors.warning : lastApplyPassed ? colors.accent : state.revisionCount === 0 ? colors.textDim : colors.danger} />
          <StatTile label="Inspections" value={String(state.inspectionCount)} sub="files read" />
          <StatTile label="Capabilities" value={`${total > 0 ? accepted : 0} / ${total}`} sub={total === 0 ? 'none bound yet' : accepted === total ? 'all accepted' : `${total} bound`} subColor={total > 0 && accepted === total ? colors.accent : undefined} />
        </div>
        {stage === 'review' && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Review the rendering</span>
            <span style={{ fontFamily: mono, fontSize: 12, color: colors.textSecondary }}>{total} / {total} bound · {accepted} accepted{rejected ? ` · ${rejected} rejected` : ''}</span>
          </div>
        )}
        <div style={{ marginTop: 10 }}><CapabilityMeter segments={meter} /></div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', minHeight: 0 }}>
        {stage === 'teach' ? (
          <ActivityFeed activity={state.activity} validating={validating} agent={agent} />
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <ActivityFeed activity={state.activity} validating={validating} agent={agent} waitingForReview={rejected === 0 && accepted < total} maxRows={3} compact />
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.textDim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Your review</div>
            <div style={{ marginTop: 6, fontSize: 12, color: colors.textSecondary }}>Judge each capability against the render — orbit, scrub, jump into cameras.</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
              {required.map((cap) => {
                const verdict = reviewed.get(cap)?.verdict
                const tone = verdict === 'accepted' ? colors.accent : verdict === 'rejected' ? colors.danger : colors.textSecondary
                const active = selectedCap === cap
                return (
                  <span key={cap} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999, border: `1px solid ${verdict ? tone : colors.border}`, background: verdict ? alpha(tone, 0.08) : 'transparent', outline: active ? `1px solid ${colors.accentBlue}` : 'none', outlineOffset: 2 }}>
                    <button onClick={() => setSelected(cap)} aria-pressed={active} style={{ padding: '6px 4px 6px 10px', border: 0, background: 'transparent', color: tone, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{verdict === 'accepted' ? '✓' : verdict === 'rejected' ? '✕' : '·'} {cap}</button>
                    <button aria-label={`Accept ${cap}`} aria-pressed={verdict === 'accepted'} title={`Accept ${cap}`} onClick={() => submit(cap, 'accepted')} style={{ border: 0, background: 'transparent', color: verdict === 'accepted' ? colors.accent : colors.textDim, cursor: 'pointer', padding: '4px 3px', fontSize: 11 }}>✓</button>
                    <button aria-label={`Reject ${cap}`} aria-pressed={verdict === 'rejected'} title={`Reject ${cap}`} onClick={() => submit(cap, 'rejected')} style={{ border: 0, background: 'transparent', color: verdict === 'rejected' ? colors.danger : colors.textDim, cursor: 'pointer', padding: '4px 8px 4px 3px', fontSize: 11 }}>✕</button>
                  </span>
                )
              })}
            </div>
            {selectedCap && (
              <div style={{ marginTop: 14, padding: 14, borderRadius: 12, border: `1px solid ${reviewed.get(selectedCap)?.verdict === 'rejected' ? colors.danger : colors.border}`, background: colors.bgSurface }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{selectedCap}</span>
                  <span style={{ fontFamily: mono, fontSize: 10, color: colors.textDim }}>frames {(state.validation?.presentedFrames[selectedCap] ?? []).join(', ')}{preview?.capabilitySamples?.[selectedCap === 'segmentation' ? 'lidarSegmentation' : selectedCap] ? ` · [${preview.capabilitySamples[selectedCap === 'segmentation' ? 'lidarSegmentation' : selectedCap]!.join(', ')}]` : ''}</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: colors.textSecondary }}>If you reject — what looks wrong?</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
                  {issuesForCapability(selectedCap).map((issue) => {
                    const on = (drafts[selectedCap] ?? issuesForCapability(selectedCap)[0]) === issue
                    return <button key={issue} aria-label={`Issue for ${selectedCap}: ${issue}`} aria-pressed={on} onClick={() => setDrafts({ ...drafts, [selectedCap]: issue })} style={{ padding: '4px 9px', borderRadius: 999, border: `1px solid ${on ? colors.danger : colors.border}`, color: on ? colors.danger : colors.textSecondary, fontSize: 11, background: on ? alpha(colors.danger, 0.12) : 'transparent', cursor: 'pointer' }}>{issue}</button>
                  })}
                </div>
                <input value={notes[selectedCap] ?? ''} onChange={(event) => setNotes({ ...notes, [selectedCap]: event.currentTarget.value })} placeholder="…or describe it in your own words" aria-label={`Note for ${selectedCap}`} style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgBase, color: colors.textPrimary, fontSize: 12, outline: 'none' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={() => submit(selectedCap, 'accepted')} style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${colors.accent}`, background: alpha(colors.accent, 0.1), color: colors.accent, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Accept</button>
                  <button onClick={() => submit(selectedCap, 'rejected')} style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${colors.danger}`, background: 'transparent', color: colors.danger, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{(notes[selectedCap] ?? '').trim() ? 'Reject with note' : `Reject — ${drafts[selectedCap] ?? issuesForCapability(selectedCap)[0]}`}</button>
                </div>
              </div>
            )}
            {preview?.thumbnails && preview.thumbnails.length > 0 && (
              <details style={{ marginTop: 14 }}>
                <summary style={{ fontSize: 11, color: colors.textDim, cursor: 'pointer' }}>Sampled thumbnails ({preview.thumbnails.length})</summary>
                <div data-testid="review-thumbnails" style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6 }}>
                  {preview.thumbnails.map((thumbnail) => (
                    <figure key={`${thumbnail.frameIndex}:${thumbnail.sensorId}`} style={{ margin: 0 }}>
                      <img src={thumbnail.dataUrl} alt={`${thumbnail.sensorId} frame ${thumbnail.frameIndex} with ${thumbnail.projectedPoints} projected points`} style={{ width: '100%', display: 'block', borderRadius: radius.sm }} />
                      <figcaption style={{ fontSize: 9, color: colors.textDim, marginTop: 2 }}>{thumbnail.sensorId} · f{thumbnail.frameIndex} · {thumbnail.projectedPoints} pts</figcaption>
                    </figure>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
        {state.diagnostics.some((item) => item.severity === 'warning') && (
          <div data-testid="consistency-warnings" style={{ marginTop: 14, padding: 10, whiteSpace: 'pre-wrap', background: alpha(colors.warning, 0.08), border: `1px solid ${alpha(colors.warning, 0.4)}`, color: colors.warning, borderRadius: 8, fontSize: 11, lineHeight: 1.5 }}>
            {state.diagnostics.filter((item) => item.severity === 'warning').map((item) => `${item.code}: ${item.hint}`).join('\n')}
          </div>
        )}
        {error && <div style={{ marginTop: 12, padding: 10, whiteSpace: 'pre-wrap', color: colors.danger, fontSize: 11, lineHeight: 1.5, border: `1px solid ${alpha(colors.danger, 0.4)}`, borderRadius: 8 }}>{error}</div>}
      </div>

      {stage === 'teach' && lastRejection && (
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: colors.textDim }}>Last rejection · revision #{state.revisionCount}</div>
          <div style={{ marginTop: 4, fontFamily: mono, fontSize: 11, lineHeight: 1.5, color: colors.danger, overflowWrap: 'anywhere' }}>{lastRejection.result.replace(/^rejected — /u, '')}</div>
        </div>
      )}

      {stage === 'review' && (
        <div style={{ padding: 12, flexShrink: 0 }}>
          {accepted === total && total > 0 ? (
            <button disabled={busy} onClick={() => void finalize()} style={{ width: '100%', padding: 12, borderRadius: 8, border: 0, background: colors.accent, color: colors.textOnAccent, fontWeight: 700, fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>Finalize — seal this recipe</button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, border: `2px solid ${colors.accentBlue}`, borderRadius: 14, background: alpha(colors.accentBlue, 0.1), boxShadow: `0 0 20px ${alpha(colors.accentBlue, 0.25)}` }}>
              {agent.chatLocation === 'sidebar-left' && <span className="tl-pulse" aria-hidden style={{ fontSize: 24, fontWeight: 700, color: colors.accentBlue, ...pulse() }}>←</span>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 800 }}><AgentMark agent={agent} size={16} />{rejected > 0 ? `Ask ${names.name} to revise` : `Review, then ask ${names.name} if something is off`}</div>
                <div style={{ marginTop: 6, fontFamily: mono, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>“Read my review and revise the rejected capabilities.”</div>
                <div style={{ marginTop: 4, fontSize: 11, color: colors.textDim }}>Your verdicts are already visible to {names.name} via get_state.</div>
              </div>
              <button onClick={copyRevision} title="Copy revision prompt" aria-label="Copy revision prompt" style={{ width: 38, height: 38, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 9, border: 0, background: colors.accentBlue, color: '#000', cursor: 'pointer', fontSize: 15, fontWeight: 800 }}>{copiedRevision ? '✓' : '⧉'}</button>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Sealed — "You got … reader!"
// ---------------------------------------------------------------------------

function SealedStage({ session, state, onRenderDataset, onLeave, error, setError }: {
  session: TeachableAuthoringSessionV1
  state: ReturnType<TeachableAuthoringSessionV1['getState']>
  onRenderDataset?: () => void
  onLeave?: () => void
  error: string | null
  setError: (value: string | null) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteHash, setRemoteHash] = useState('')
  const [showImport, setShowImport] = useState(false)
  const artifact = state.currentArtifact
  const name = artifact?.identity.name ?? 'this format'
  const accepted = state.reviews.filter((review) => review.verdict === 'accepted').length
  const finalizedAt = artifact?.provenance?.createdAt ? new Date(artifact.provenance.createdAt) : new Date()
  const importFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try { const result = await session.importArtifact(file); if (!result.ok) setError(result.diagnostics.map((item) => `${item.code}: ${item.hint}`).join('\n')); else setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const importRemote = async () => {
    setBusy(true)
    try { const verified = await fetchRemoteRecipeV1(remoteUrl.trim(), remoteHash.trim()); const result = await session.applyRevision(verified.recipe); if (!result.ok) setError(result.diagnostics.map((item) => `${item.code}: ${item.hint}`).join('\n')); else setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const secondary: React.CSSProperties = { flex: 1, padding: 9, borderRadius: 8, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.textSecondary, fontSize: 12, cursor: 'pointer' }
  const hashRows = artifact?.hashes ? [
    ['recipe', artifact.hashes.recipeHash], ['format fingerprint', artifact.hashes.formatFingerprint], ['operator set', artifact.hashes.operatorSetFingerprint], ['artifact', artifact.hashes.artifactHash],
  ] : []
  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'grid', placeItems: 'center', padding: '32px 24px' }}>
      <div style={{ width: 'min(880px, 100%)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
        <div style={{ gridColumn: '1 / -1', textAlign: 'center' }}>
          <span style={{ padding: '4px 12px', borderRadius: 999, background: colors.accent, color: colors.textOnAccent, fontSize: 10, fontWeight: 800, letterSpacing: '0.08em' }}>SEALED</span>
          <div style={{ margin: '14px 0 4px', fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em' }}>{name}</div>
          <div className="tl-pulse" style={{ fontFamily: mono, fontSize: 14, fontWeight: 800, letterSpacing: '0.14em', color: colors.accent, ...pulse(2.2) }}>YOU GOT… {name.toUpperCase()} READER!</div>
          <div style={{ marginTop: 4, fontSize: 12, color: colors.textSecondary }}>EgoLens can now read this format.</div>
          <div style={{ marginTop: 5, fontSize: 12, color: colors.textSecondary }}>Adapter sealed · {accepted} / {capabilityCount(state)} capabilities accepted · {state.revisionCount} revision{state.revisionCount === 1 ? '' : 's'} · finalized {finalizedAt.toLocaleDateString()}</div>
        </div>
        <div style={{ padding: 20, border: `1px solid ${colors.border}`, borderRadius: 14, background: colors.bgSurface }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Use it</div>
          <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.55, color: colors.textSecondary }}>Render now, or export the recipe file to hand this format to anyone.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
            {onRenderDataset && <button onClick={onRenderDataset} style={{ padding: 11, borderRadius: 8, border: 0, background: colors.accent, color: colors.textOnAccent, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Render this dataset</button>}
            {artifact && <button onClick={() => { try { downloadRecipeArtifactV1(artifact); setError(null) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }} style={{ padding: 11, borderRadius: 8, border: `1px solid ${colors.accentBlue}`, background: alpha(colors.accentBlue, 0.12), color: colors.textPrimary, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Export JSON</button>}
          </div>
        </div>
        <div style={{ padding: 20, border: `1px solid ${colors.border}`, borderRadius: 14, background: colors.bgSurface }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Keep it</div>
          <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.55, color: colors.textSecondary }}>Saved in this browser — matching folders render instantly. Import a file or URL to replace it.</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <input ref={fileInput} type="file" accept=".json,.egolens-adapter.json,application/json" hidden onChange={(event) => void importFile(event.target.files?.[0])} />
            <button disabled={busy} onClick={() => fileInput.current?.click()} style={secondary}>Import JSON</button>
            <button disabled={busy} onClick={() => setShowImport((value) => !value)} style={secondary}>Import URL</button>
          </div>
          {showImport && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6, marginTop: 10 }}>
              <input aria-label="Remote recipe URL" type="url" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://…/adapter.json" style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgBase, color: colors.textPrimary, fontSize: 12 }} />
              <input aria-label="Expected recipe hash" value={remoteHash} onChange={(event) => setRemoteHash(event.target.value)} placeholder="sha256:…" style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgBase, color: colors.textPrimary, fontSize: 12, fontFamily: mono }} />
              <button disabled={busy || !remoteUrl.trim() || !remoteHash.trim()} onClick={() => void importRemote()} style={secondary}>Import URL</button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 14 }}>
            {hashRows.map(([key, value]) => (
              <div key={key} style={{ display: 'flex', gap: 10, fontSize: 10 }}><span style={{ minWidth: 110, color: colors.textDim }}>{key}</span><span style={{ fontFamily: mono, color: colors.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span></div>
            ))}
          </div>
        </div>
        {error && <div style={{ gridColumn: '1 / -1', padding: 10, whiteSpace: 'pre-wrap', color: colors.danger, fontSize: 11, border: `1px solid ${alpha(colors.danger, 0.4)}`, borderRadius: 8 }}>{error}</div>}
        <div style={{ gridColumn: '1 / -1', textAlign: 'center', fontSize: 12 }}>
          <button onClick={() => { session.revoke(); onLeave?.() }} style={{ background: 'none', border: 0, padding: 0, color: colors.accentBlue, textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>Teach another folder</button>
        </div>
      </div>
    </div>
  )
}
