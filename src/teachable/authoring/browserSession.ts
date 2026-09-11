import { trackTeaching } from '../../utils/teachableTelemetry'
import { InventoryBindingEvaluatorV1 } from './InventoryBindingEvaluator'
import { TeachableAuthoringSessionV1 } from './AuthoringSession'
import { BrowserGraphPreviewRuntimeV1 } from './BrowserGraphPreviewRuntime'

/** One live command surface shared by the landing UI and top-level Site tools. */
export const teachableAuthoringSession = new TeachableAuthoringSessionV1(
  new InventoryBindingEvaluatorV1(new BrowserGraphPreviewRuntimeV1()),
)

// Observe lifecycle transitions without including dataset names or review notes.
let previous = teachableAuthoringSession.getState()
teachableAuthoringSession.subscribe(() => {
  const state = teachableAuthoringSession.getState()
  const before = previous
  previous = state
  if (state.inventory?.sessionId && state.inventory.sessionId !== before.inventory?.sessionId) {
    trackTeaching('session_start', { source: teachableAuthoringSession.getInventory()?.kind, file_count: state.inventory.entries.length })
  }
  if (state.phase !== before.phase) trackTeaching(state.phase === 'finalized' ? 'seal' : 'phase_change', { phase: state.phase, revision: state.revisionCount })
  if (state.reviews !== before.reviews) {
    for (const review of state.reviews) {
      if (!before.reviews.includes(review)) trackTeaching('human_review', { capability: review.capability, outcome: review.verdict, issue: review.issue, revision: state.revisionCount })
    }
  }
})
