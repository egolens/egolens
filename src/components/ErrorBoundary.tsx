/**
 * ErrorBoundary — stops one broken subtree from taking down the app.
 *
 * EgoLens composes many independent overlays over the same frame (LiDAR
 * projection, camera segmentation, boxes, keypoints). Without boundaries a
 * throw in any one of them unmounts the entire React tree and the user is left
 * staring at a white page — which is exactly what the LiDAR→Camera colormap bug
 * did. Wrapping each overlay downgrades that class of failure from "app is
 * gone" to "one overlay is missing".
 *
 * Every catch is reported, so a subtree that silently disappears still shows up
 * in analytics instead of vanishing without a trace.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { reportError } from '../utils/errorReporting'
import { colors } from '../theme'

interface Props {
  /**
   * Stable identifier for telemetry grouping — a component or feature name,
   * never a user-facing string.
   */
  feature: string
  children: ReactNode
  /**
   * 'root'   — the failure cost the user the app: show a recovery screen.
   * 'silent' — the failure cost the user one overlay: drop it and carry on.
   */
  variant?: 'root' | 'silent'
}

interface State {
  failed: boolean
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const firstSighting = reportError(error, this.props.feature, this.props.variant === 'root')
    if (firstSighting && info.componentStack) {
      console.error(`[egolens] component stack for ${this.props.feature}:`, info.componentStack)
    }
  }

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.variant !== 'root') return null
    return renderRootFallback()
  }
}

// ---------------------------------------------------------------------------
// Fallback UI (root only)
// ---------------------------------------------------------------------------

// Deliberately not a component: react-refresh cannot fast-refresh a file that
// mixes a class export with a function component, and this markup has no state
// of its own to warrant one.
function renderRootFallback() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        background: colors.bgBase,
        color: colors.textPrimary,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>Something broke</div>
      <div style={{ fontSize: 14, color: colors.textSecondary, maxWidth: 420, lineHeight: 1.5 }}>
        EgoLens hit an unexpected error and stopped rendering. Reloading usually clears it.
        If it keeps happening, the details in the browser console would help a bug report.
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 18px',
            fontSize: 14,
            fontWeight: 600,
            color: colors.bgDeep,
            background: colors.accent,
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
        <a
          href="https://github.com/egolens/egolens/issues"
          target="_blank"
          rel="noreferrer"
          style={{
            padding: '8px 18px',
            fontSize: 14,
            color: colors.textSecondary,
            background: colors.bgOverlay,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            textDecoration: 'none',
          }}
        >
          Report an issue
        </a>
      </div>
    </div>
  )
}
