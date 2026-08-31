import { InventoryBindingEvaluatorV1 } from './InventoryBindingEvaluator'
import { TeachableAuthoringSessionV1 } from './AuthoringSession'
import { BrowserTimelinePreviewRuntimeV1 } from './BrowserTimelinePreviewRuntime'

/** One live command surface shared by the landing UI and top-level Site tools. */
export const teachableAuthoringSession = new TeachableAuthoringSessionV1(
  new InventoryBindingEvaluatorV1(new BrowserTimelinePreviewRuntimeV1()),
)
