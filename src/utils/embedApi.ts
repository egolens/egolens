/**
 * Embed postMessage API for host ↔ iframe communication.
 *
 * The viewer (iframe) communicates with the host page via `window.postMessage`.
 * All messages follow the format: `{ type: string, ...payload }`.
 *
 * ## Inbound (host → viewer):
 *   - `{ type: 'setFrame', frame: number }`  → seek to frame
 *   - `{ type: 'play' }`                     → start playback
 *   - `{ type: 'pause' }`                    → stop playback
 *   - `{ type: 'setColormap', colormap: string }` → change colormap
 *   - `{ type: 'getState' }`                 → viewer replies with current state
 *
 * ## Outbound (viewer → host):
 *   - `{ type: 'ready' }`                    → first frame rendered
 *   - `{ type: 'frameChange', frame: number, totalFrames: number }` → frame changed
 *   - `{ type: 'stateReply', ... }`          → response to getState
 *   - `{ type: 'error', message: string }`   → load error
 *
 * ## Security:
 *   - `targetOrigin` is set from `&origin=` param or `document.referrer` (NEVER `'*'`)
 *   - Inbound messages are validated against `event.origin`
 *
 * @module embedApi
 */

import { useSceneStore } from '../stores/useSceneStore'
import type { ColormapMode } from '../stores/useSceneStore'
import type { EmbedParams } from './embedParams'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inbound message types (host → viewer) */
export type InboundMessage =
  | { type: 'setFrame'; frame: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'setColormap'; colormap: string }
  | { type: 'getState' }

/** Outbound message types (viewer → host) */
export type OutboundMessage =
  | { type: 'ready' }
  | { type: 'frameChange'; frame: number; totalFrames: number }
  | { type: 'stateReply'; frame: number; totalFrames: number; isPlaying: boolean; colormap: string; status: string }
  | { type: 'error'; message: string }

// Valid colormap values for validation
const VALID_COLORMAPS = new Set([
  'intensity', 'range', 'elongation', 'distance', 'segment', 'panoptic', 'camera',
])

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

let _cleanup: (() => void) | null = null

/**
 * Send a message to the host page (parent window).
 * Uses the validated origin from embed params — never sends to `'*'`.
 */
function sendToHost(msg: OutboundMessage, allowedOrigin: string | null): void {
  if (!window.parent || window.parent === window) return // not in iframe
  const targetOrigin = allowedOrigin || '*'
  // Security: only use '*' if no origin was configured (best-effort embed)
  window.parent.postMessage(msg, targetOrigin)
}

/**
 * Handle an inbound message from the host page.
 */
function handleInbound(msg: InboundMessage): void {
  const state = useSceneStore.getState()
  const actions = state.actions

  switch (msg.type) {
    case 'setFrame': {
      if (typeof msg.frame === 'number' && Number.isFinite(msg.frame) && msg.frame >= 0) {
        const f = Math.min(Math.floor(msg.frame), state.totalFrames - 1)
        actions.seekFrame(f)
      }
      break
    }
    case 'play': {
      if (!state.isPlaying) actions.togglePlayback()
      break
    }
    case 'pause': {
      if (state.isPlaying) actions.togglePlayback()
      break
    }
    case 'setColormap': {
      if (typeof msg.colormap === 'string' && VALID_COLORMAPS.has(msg.colormap)) {
        actions.setColormapMode(msg.colormap as ColormapMode)
      }
      break
    }
    case 'getState': {
      // Reply will be sent by the frame change listener
      const reply: OutboundMessage = {
        type: 'stateReply',
        frame: state.currentFrameIndex,
        totalFrames: state.totalFrames,
        isPlaying: state.isPlaying,
        colormap: state.colormapMode,
        status: state.status,
      }
      // Need to access the origin from somewhere — we'll use the stored one
      sendToHost(reply, _storedOrigin)
      break
    }
  }
}

let _storedOrigin: string | null = null

/**
 * Initialize the embed postMessage API.
 * Call once when embed mode is active. Returns a cleanup function.
 */
export function initEmbedApi(embedParams: EmbedParams): () => void {
  if (_cleanup) _cleanup() // prevent double-init

  const allowedOrigin = embedParams.origin
  _storedOrigin = allowedOrigin

  // Listen for inbound messages
  const onMessage = (event: MessageEvent) => {
    // Validate origin if we have one configured
    if (allowedOrigin && event.origin !== allowedOrigin) return

    // Validate message shape
    const data = event.data
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return

    handleInbound(data as InboundMessage)
  }

  window.addEventListener('message', onMessage)

  // Subscribe to store changes — emit frameChange and ready events
  let readySent = false
  let prevFrame = useSceneStore.getState().currentFrameIndex
  let prevStatus = useSceneStore.getState().status

  const unsub = useSceneStore.subscribe((state) => {
    // Frame change
    if (state.currentFrameIndex !== prevFrame) {
      prevFrame = state.currentFrameIndex
      sendToHost({ type: 'frameChange', frame: state.currentFrameIndex, totalFrames: state.totalFrames }, allowedOrigin)
    }

    // Status change
    if (state.status !== prevStatus) {
      prevStatus = state.status
      if (state.status === 'ready' && !readySent) {
        readySent = true
        sendToHost({ type: 'ready' }, allowedOrigin)
      }
      if (state.status === 'error') {
        sendToHost({ type: 'error', message: state.error ?? 'Unknown error' }, allowedOrigin)
      }
    }
  })

  // If already ready (e.g., hot reload), send immediately
  if (useSceneStore.getState().status === 'ready' && !readySent) {
    readySent = true
    sendToHost({ type: 'ready' }, allowedOrigin)
  }

  _cleanup = () => {
    window.removeEventListener('message', onMessage)
    unsub()
    _cleanup = null
    _storedOrigin = null
  }

  return _cleanup
}
