import { useEffect, useId, useRef, useState } from 'react'
import { useWebMcpAgentV1 } from '../../teachable/authoring/agentDetection'
import type { SourceInventoryV1 } from '../../teachable/authoring/SourceInventory'
import { openRemoteSourceInventoryV1 } from '../../teachable/authoring/RemoteSourceInventory'
import { teachableAuthoringSession } from '../../teachable/authoring/browserSession'
import type { FinalizedArtifactRecordV1 } from '../../teachable/authoring/persistence'
import { PANDASET_TEACHING_SAMPLE } from '../../utils/teachingSample'
import { trackPresetClick } from '../../utils/analytics'
import './adapterEntry.css'

export default function HostedTeachingPreset({ onTeach, disabled = false }: {
  onTeach: (inventory: SourceInventoryV1, savedRecipes: readonly FinalizedArtifactRecordV1[]) => void
  disabled?: boolean
}) {
  const agent = useWebMcpAgentV1()
  const requirementId = useId()
  const requirement = useRef<HTMLParagraphElement>(null)
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sample = PANDASET_TEACHING_SAMPLE

  const cancel = () => { request.current?.abort(); request.current = null; setBusy(false) }
  useEffect(() => () => { request.current?.abort(); request.current = null }, [])
  useEffect(() => {
    if (disabled) request.current?.abort()
  }, [disabled])

  const start = async () => {
    if (request.current && !request.current.signal.aborted) return
    if (!agent.available) {
      requirement.current?.focus()
      return
    }
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    trackPresetClick('pandaset')
    let inventory: SourceInventoryV1 | null = null
    try {
      inventory = await openRemoteSourceInventoryV1({
        rootUrl: sample.rootUrl,
        catalogUrl: sample.catalogUrl,
        expectedCatalogHash: sample.catalogHash,
        limits: { maxTotalResponseBytes: sample.maxTotalResponseBytes },
        // The public host permits CORS GET but does not expose Content-Range.
        // Read each requested frame file with its full digest still enforced.
        preferFullObjects: true,
        signal: controller.signal,
      })
      if (controller.signal.aborted) { inventory.revoke(); return }
      // Reopening a sample can reuse a sealed adapter. Matching reads only the
      // catalog's paths and extensions, never the remote source objects.
      const savedRecipes = await teachableAuthoringSession.findSavedRecipes(inventory)
      if (controller.signal.aborted) { inventory.revoke(); return }
      request.current = null
      setBusy(false)
      onTeach(inventory, savedRecipes)
      // The authoring session owns the source after this synchronous handoff.
      inventory = null
    } catch (cause) {
      inventory?.revoke()
      if (!controller.signal.aborted) {
        setError('Could not connect to the hosted log. Try again, or download the ZIP and open it locally.')
        console.warn('Hosted teaching source could not be opened.', cause)
      }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }

  return (
    <div className="hosted-teaching-preset" onKeyDown={(event) => event.stopPropagation()}>
      <button type="button" className="hosted-teaching-button" disabled={disabled || busy}
        aria-describedby={requirementId} aria-busy={busy} onClick={() => void start()}>
        {busy ? 'Connecting to PandaSet…' : 'Teach PandaSet'}
        <span>Hosted by EgoLens · 80 frames</span>
      </button>
      {busy && <button type="button" className="adapter-text-button hosted-teaching-cancel" onClick={cancel}>Cancel</button>}
      <p className="hosted-teaching-local">Prefer local files? <a href={sample.zipUrl}>Download ZIP (439 MB)</a><br />Unzip, then drag the extracted folder below.</p>
      <p id={requirementId} ref={requirement} tabIndex={-1} className="hosted-teaching-agent">
        To create an adapter with AI, use the in-app browser in the Codex desktop app.
      </p>
      <p className="hosted-teaching-credit">Data: <a href="https://pandaset.org/" target="_blank" rel="noreferrer">Hesai + Scale AI</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></p>
      {error && <p role="alert" className="adapter-error">{error}</p>}
    </div>
  )
}
