import AgentSetupCard from './AgentSetupCard'
import { useEffect, useId, useRef } from 'react'
import './adapterEntry.css'

export default function AdapterRecipeIntro({ onClose, onTry }: { onClose: () => void; onTry: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return <dialog ref={dialog} className="adapter-dialog adapter-intro" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <div className="adapter-dialog-heading">
      <h2 id={titleId}>Open more dataset formats with adapter recipes</h2>
      <button type="button" className="adapter-text-button" aria-label="Close adapter guide" onClick={onClose}>✕</button>
    </div>
    <p>An adapter recipe tells EgoLens how to read a dataset format.</p>
    <h3>Use an existing recipe</h3>
    <p>Load a recipe file or URL with your local or remote data. No AI agent needed.</p>
    <h3>Create or improve a recipe with AI</h3>
    <p>Ask the AI agent to inspect your dataset and build a recipe. Review the rendered result, then save the recipe to reuse or share.</p>
    <AgentSetupCard />
    <p>Teaching is experimental. Results depend on the AI agent and dataset format; some formats need capabilities that adapter recipes do not support yet.</p>
    <h3>Try it with the PandaSet sample</h3>
    <p>Once your agent is connected, choose <strong>Try an unsupported format</strong>.</p>
    <button type="button" className="adapter-intro-cta" onClick={() => onTry()}>Try an unsupported format</button>
  </dialog>
}
