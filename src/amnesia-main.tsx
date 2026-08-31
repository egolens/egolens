import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AmnesiaAuthorApp from './AmnesiaAuthorApp'

Object.defineProperty(globalThis, '__EGOLENS_AMNESIA_BUILD__', {
  configurable: false,
  enumerable: true,
  writable: false,
  value: Object.freeze({
    runtimeId: 'egolens-adapter-amnesia-author-v1',
    commit: __EGOLENS_GIT_COMMIT__,
  }),
})

createRoot(document.getElementById('root')!).render(<StrictMode><AmnesiaAuthorApp /></StrictMode>)
