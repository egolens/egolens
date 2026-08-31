import { executeExtensionWorkerRequest } from './extensionWorkerRuntime'
import type { ExtensionExecutionRequest } from './protocol'

interface ExtensionWorkerScope {
  onmessage: ((event: MessageEvent<ExtensionExecutionRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const scope = self as unknown as ExtensionWorkerScope
scope.onmessage = (event): void => {
  void executeExtensionWorkerRequest(event.data).then(({ response, transfer }) => {
    scope.postMessage(response, [...transfer])
  })
}
