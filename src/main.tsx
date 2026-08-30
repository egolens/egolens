import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { installAnalytics } from './utils/analyticsBootstrap'
import { installGlobalErrorHandlers } from './utils/errorReporting'
import { installLoadTelemetry } from './utils/loadTelemetry'
import { applyTheme, initialAccent, initialTheme } from './theme'
import { trackThemeConfig } from './utils/analytics'
import { parseAccent, parseThemePreference } from './utils/themeParams'

// Global reset
document.documentElement.style.margin = '0'
document.documentElement.style.padding = '0'
document.body.style.margin = '0'
document.body.style.padding = '0'

// Theme before render. Chrome tokens are `var(--el-*)` with a dark fallback, so
// a late apply is not a broken page — it is a visible flash from dark to light.
applyTheme(initialTheme(), document.documentElement, initialAccent())

// Analytics first: the error handlers below report through it.
installAnalytics()
const themePreference = parseThemePreference(window.location.search)
const accentPreference = parseAccent(window.location.search)
if (themePreference || accentPreference) {
  trackThemeConfig(themePreference, accentPreference)
}
// Must run before render so a crash during the first paint is still reported.
installGlobalErrorHandlers()
// Subscribes to load status transitions; must be live before any load starts.
installLoadTelemetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary feature="app" variant="root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
