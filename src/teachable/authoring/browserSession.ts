import { InventoryBindingEvaluatorV1 } from './InventoryBindingEvaluator'
import { TeachableAuthoringSessionV1 } from './AuthoringSession'
import { BrowserGraphPreviewRuntimeV1 } from './BrowserGraphPreviewRuntime'

/** One live command surface shared by the landing UI and top-level Site tools. */
export const teachableAuthoringSession = new TeachableAuthoringSessionV1(
  new InventoryBindingEvaluatorV1(new BrowserGraphPreviewRuntimeV1()),
)
