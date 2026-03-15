/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EmbedParams } from '../embedParams'

// We need to mock the store before importing embedApi
vi.mock('../../stores/useSceneStore', () => {
  const subscribers = new Set<(state: Record<string, unknown>) => void>()
  let state: Record<string, unknown> = {
    currentFrameIndex: 0,
    totalFrames: 100,
    isPlaying: false,
    colormapMode: 'intensity',
    status: 'idle',
    error: null,
    actions: {
      seekFrame: vi.fn(),
      togglePlayback: vi.fn(),
      setColormapMode: vi.fn(),
    },
  }
  return {
    useSceneStore: {
      getState: () => state,
      subscribe: (fn: (state: Record<string, unknown>) => void) => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
      },
      _setState: (partial: Record<string, unknown>) => {
        state = { ...state, ...partial }
        subscribers.forEach((fn) => fn(state))
      },
      _reset: () => {
        state = {
          currentFrameIndex: 0,
          totalFrames: 100,
          isPlaying: false,
          colormapMode: 'intensity',
          status: 'idle',
          error: null,
          actions: {
            seekFrame: vi.fn(),
            togglePlayback: vi.fn(),
            setColormapMode: vi.fn(),
          },
        }
        subscribers.clear()
      },
    },
  }
})

// Import after mock setup
import { initEmbedApi } from '../embedApi'
import { useSceneStore } from '../../stores/useSceneStore'

const store = useSceneStore as unknown as {
  getState: () => Record<string, unknown>
  subscribe: (fn: (state: Record<string, unknown>) => void) => () => void
  _setState: (partial: Record<string, unknown>) => void
  _reset: () => void
}

function makeEmbedParams(overrides: Partial<EmbedParams> = {}): EmbedParams {
  return {
    embed: true,
    controls: 'full',
    frame: null,
    camera: null,
    autoplay: false,
    colormap: null,
    bgcolor: null,
    origin: null,
    ...overrides,
  }
}

describe('embedApi', () => {
  let cleanup: (() => void) | null = null
  let postMessageSpy: ReturnType<typeof vi.fn>
  const originalParent = globalThis.window?.parent

  beforeEach(() => {
    store._reset()
    postMessageSpy = vi.fn()
    // Simulate being in an iframe
    if (typeof globalThis.window !== 'undefined') {
      Object.defineProperty(globalThis.window, 'parent', {
        value: { postMessage: postMessageSpy },
        writable: true,
        configurable: true,
      })
    }
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
    vi.restoreAllMocks()
    if (typeof globalThis.window !== 'undefined' && originalParent) {
      Object.defineProperty(globalThis.window, 'parent', {
        value: originalParent,
        writable: true,
        configurable: true,
      })
    }
  })

  it('sends ready when status changes to ready', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    store._setState({ status: 'ready' })
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: 'ready' },
      '*',
    )
  })

  it('sends ready with validated origin', () => {
    cleanup = initEmbedApi(makeEmbedParams({ origin: 'https://example.com' }))
    store._setState({ status: 'ready' })
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: 'ready' },
      'https://example.com',
    )
  })

  it('sends frameChange on frame updates', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    store._setState({ currentFrameIndex: 5, totalFrames: 100, status: 'ready' })
    const calls = postMessageSpy.mock.calls
    const frameChanges = calls.filter(([msg]: [{ type: string }]) => msg.type === 'frameChange')
    expect(frameChanges.length).toBeGreaterThan(0)
    expect(frameChanges[0][0]).toEqual({ type: 'frameChange', frame: 5, totalFrames: 100 })
  })

  it('sends error message on status=error', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    store._setState({ status: 'error', error: 'CORS blocked' })
    const calls = postMessageSpy.mock.calls
    const errors = calls.filter(([msg]: [{ type: string }]) => msg.type === 'error')
    expect(errors.length).toBe(1)
    expect(errors[0][0]).toEqual({ type: 'error', message: 'CORS blocked' })
  })

  it('handles setFrame inbound message', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    const event = new MessageEvent('message', {
      data: { type: 'setFrame', frame: 42 },
      origin: 'https://anywhere.com',
    })
    window.dispatchEvent(event)
    const actions = store.getState().actions as { seekFrame: ReturnType<typeof vi.fn> }
    expect(actions.seekFrame).toHaveBeenCalledWith(42)
  })

  it('rejects setFrame from wrong origin', () => {
    cleanup = initEmbedApi(makeEmbedParams({ origin: 'https://trusted.com' }))
    const event = new MessageEvent('message', {
      data: { type: 'setFrame', frame: 42 },
      origin: 'https://evil.com',
    })
    window.dispatchEvent(event)
    const actions = store.getState().actions as { seekFrame: ReturnType<typeof vi.fn> }
    expect(actions.seekFrame).not.toHaveBeenCalled()
  })

  it('handles play inbound message', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'play' },
    }))
    const actions = store.getState().actions as { togglePlayback: ReturnType<typeof vi.fn> }
    expect(actions.togglePlayback).toHaveBeenCalledTimes(1)
  })

  it('handles setColormap inbound message', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setColormap', colormap: 'distance' },
    }))
    const actions = store.getState().actions as { setColormapMode: ReturnType<typeof vi.fn> }
    expect(actions.setColormapMode).toHaveBeenCalledWith('distance')
  })

  it('rejects invalid colormap', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setColormap', colormap: 'rainbow' },
    }))
    const actions = store.getState().actions as { setColormapMode: ReturnType<typeof vi.fn> }
    expect(actions.setColormapMode).not.toHaveBeenCalled()
  })

  it('ignores malformed messages', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    window.dispatchEvent(new MessageEvent('message', { data: 'hello' }))
    window.dispatchEvent(new MessageEvent('message', { data: { frame: 42 } }))
    window.dispatchEvent(new MessageEvent('message', { data: null }))
    const actions = store.getState().actions as { seekFrame: ReturnType<typeof vi.fn> }
    expect(actions.seekFrame).not.toHaveBeenCalled()
  })

  it('cleanup removes listeners', () => {
    cleanup = initEmbedApi(makeEmbedParams())
    cleanup()
    cleanup = null

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setFrame', frame: 99 },
    }))
    const actions = store.getState().actions as { seekFrame: ReturnType<typeof vi.fn> }
    expect(actions.seekFrame).not.toHaveBeenCalled()
  })
})
