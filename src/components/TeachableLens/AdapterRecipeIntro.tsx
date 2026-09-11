import { trackTeaching } from '../../utils/teachableTelemetry'
import AgentSetupCard from './AgentSetupCard'
import { useEffect, useId, useRef } from 'react'
import './adapterEntry.css'

export default function AdapterRecipeIntro({ onClose, onTry }: { onClose: () => void; onTry: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    // Start at the guide title; Tab still moves to the close button normally.
    heading.current?.focus({ preventScroll: true })
    return () => element.close()
  }, [])
  return <dialog ref={dialog} className="adapter-dialog adapter-intro" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <div className="adapter-dialog-heading">
      <h2 ref={heading} tabIndex={-1} className="adapter-intro-title" id={titleId}>Teachable Lens: Teach EgoLens a new dataset format</h2>
      <button type="button" className="adapter-text-button" aria-label="Close adapter guide" onClick={onClose}>✕</button>
    </div>
    <p>Create reusable adapter recipes with AI, then visually review the results.</p>
    <h3>Use an existing recipe</h3>
    <p>Load a recipe file or URL with your local or remote data. No AI agent needed.</p>
    <h3>Create or improve a recipe with AI</h3>
    <p>Ask the AI agent to inspect your dataset and build a recipe. Review the rendered result, then save the recipe to reuse or share.</p>
    <AgentSetupCard />
    <p>Teaching is experimental. Results depend on the AI agent and dataset format; some formats need capabilities that adapter recipes do not support yet.</p>
    <h3>Try it with the PandaSet sample</h3>
    <p>Once your agent is connected, choose <strong>Try an unsupported format</strong>.</p>
    <button type="button" className="adapter-intro-cta" onClick={() => { trackTeaching('intro_try'); onTry() }}>Try an unsupported format</button>
  </dialog>
}
