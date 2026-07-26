import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { installGlobalErrorHandlers } from './utils/errorReporting'

// Global reset
document.documentElement.style.margin = '0'
document.documentElement.style.padding = '0'
document.body.style.margin = '0'
document.body.style.padding = '0'

// Must run before render so a crash during the first paint is still reported.
installGlobalErrorHandlers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary feature="app" variant="root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
