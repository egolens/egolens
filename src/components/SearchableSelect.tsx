/**
 * SearchableSelect — combobox-style dropdown with search filtering.
 *
 * Replaces native <select> for large item lists (e.g. 700 AV2 logs).
 * Features:
 *   - Click to open → search input auto-focused
 *   - Type to fuzzy-filter items
 *   - Keyboard nav: ↑↓ + Enter + Escape
 *   - Click outside to close
 *   - Frosted glass styling matching app theme
 *   - Works fine with small lists too (nuScenes 10 scenes)
 *   - Mobile: fullscreen modal with centered layout
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { colors, fonts, radius } from '../theme'

/** Thin dark scrollbar styles injected once per component instance */
const SCROLLBAR_CSS = `
.ss-list::-webkit-scrollbar { width: 4px; height: 4px; }
.ss-list::-webkit-scrollbar-track { background: transparent; }
.ss-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
.ss-list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
.ss-list { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.12) transparent; }
`

export interface SelectItem {
  value: string
  label: string
}

interface Props {
  items: SelectItem[]
  value: string | null
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** Full value shown on hover */
  title?: string
  /** Short label shown on mobile trigger button (e.g. "#1 / 10") */
  mobileLabel?: string
}

function useIsMobile(bp = 600) {
  const [m, setM] = useState(() => window.innerWidth < bp)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp - 1}px)`)
    const h = (e: MediaQueryListEvent) => setM(e.matches)
    mq.addEventListener('change', h)
    setM(mq.matches)
    return () => mq.removeEventListener('change', h)
  }, [bp])
  return m
}

export default function SearchableSelect({
  items,
  value,
  onChange,
  placeholder = '-- select --',
  disabled = false,
  title,
  mobileLabel,
}: Props) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter items by query (case-insensitive substring match)
  const filtered = useMemo(() => {
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter(
      (item) => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q),
    )
  }, [items, query])

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIdx(0)
  }, [filtered.length])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.children[highlightIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx, open])

  // Close on outside click (desktop only)
  useEffect(() => {
    if (!open || isMobile) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Auto-focus input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Lock body scroll when modal is open on mobile
  useEffect(() => {
    if (!isMobile || !open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val)
      setOpen(false)
      setQuery('')
    },
    [onChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[highlightIdx]) handleSelect(filtered[highlightIdx].value)
      } else if (e.key === 'Escape') {
        setOpen(false)
        setQuery('')
      }
    },
    [filtered, highlightIdx, handleSelect],
  )

  // Currently selected item's label
  const selectedLabel = items.find((item) => item.value === value)?.label ?? placeholder

  // Item count indicator for large lists
  const countLabel =
    items.length > 20 && query
      ? `${filtered.length}/${items.length}`
      : items.length > 20
        ? `${items.length} items`
        : null

  // ── Shared item list renderer ──
  const renderList = () => (
    <div
      ref={listRef}
      className="ss-list"
      style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '4px 0',
      }}
    >
      {filtered.length === 0 ? (
        <div
          style={{
            padding: '12px 16px',
            fontSize: '12px',
            fontFamily: fonts.sans,
            color: colors.textDim,
            textAlign: 'center',
          }}
        >
          No matches
        </div>
      ) : (
        filtered.map((item, idx) => {
          const isSelected = item.value === value
          const isHighlighted = idx === highlightIdx
          return (
            <div
              key={item.value}
              onMouseDown={(e) => {
                e.preventDefault()
                handleSelect(item.value)
              }}
              onMouseEnter={() => setHighlightIdx(idx)}
              style={{
                padding: isMobile ? '10px 16px' : '5px 12px',
                fontSize: isMobile ? '12px' : '12px',
                fontFamily: fonts.mono,
                color: isSelected ? colors.accent : colors.textPrimary,
                backgroundColor: isHighlighted ? colors.bgHover : 'transparent',
                cursor: 'pointer',
                whiteSpace: isMobile ? 'normal' : 'nowrap',
                wordBreak: isMobile ? 'break-all' : undefined,
                lineHeight: isMobile ? 1.4 : undefined,
                transition: 'background-color 0.1s',
              }}
              title={item.value}
            >
              {isSelected && (
                <span style={{ marginRight: '6px', fontSize: '10px' }}>●</span>
              )}
              {item.label}
            </div>
          )
        })
      )}
    </div>
  )

  // ── Shared search input renderer ──
  const renderSearch = () => (
    <div style={{ padding: isMobile ? '12px 16px 8px' : '8px 8px 4px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
      <div style={{ position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            left: '8px',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '11px',
            color: colors.textDim,
            pointerEvents: 'none',
          }}
        >
          ⌕
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Filter..."
          style={{
            width: '100%',
            padding: isMobile ? '10px 8px 10px 26px' : '6px 8px 6px 26px',
            fontSize: isMobile ? '16px' : '12px',
            fontFamily: fonts.mono,
            backgroundColor: colors.bgDeep,
            color: colors.textPrimary,
            border: `1px solid ${colors.borderSubtle}`,
            borderRadius: radius.sm,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {countLabel && (
          <span
            style={{
              position: 'absolute',
              right: '8px',
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '10px',
              fontFamily: fonts.mono,
              color: colors.textDim,
              pointerEvents: 'none',
            }}
          >
            {countLabel}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: '0 1 auto', minWidth: 0 }}>
      <style>{SCROLLBAR_CSS}</style>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => {
          if (!disabled) setOpen(!open)
        }}
        disabled={disabled}
        title={title ?? value ?? undefined}
        style={{
          width: '100%',
          padding: '6px 28px 6px 12px',
          fontSize: '12px',
          fontFamily: fonts.mono,
          backgroundColor: colors.bgOverlay,
          color: colors.textPrimary,
          border: `1px solid ${open ? colors.accent : colors.border}`,
          borderRadius: radius.md,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          outline: 'none',
          textAlign: 'left',
          whiteSpace: 'nowrap',
          boxShadow: open ? `0 0 8px ${colors.accentGlow}` : 'none',
          transition: 'box-shadow 0.2s, border-color 0.2s',
        }}
      >
        {isMobile && mobileLabel ? mobileLabel : selectedLabel}
        {/* Chevron */}
        <span
          style={{
            position: 'absolute',
            right: '10px',
            top: '50%',
            transform: `translateY(-50%) rotate(${open ? '180deg' : '0deg'})`,
            fontSize: '10px',
            color: colors.textDim,
            transition: 'transform 0.15s',
            pointerEvents: 'none',
          }}
        >
          ▼
        </span>
      </button>

      {/* ── Mobile: fullscreen modal ── */}
      {open && isMobile && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
          }}
          onClick={(e) => {
            // Close on backdrop click
            if (e.target === e.currentTarget) {
              setOpen(false)
              setQuery('')
            }
          }}
        >
          <div
            style={{
              margin: '48px 16px 16px',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(26, 31, 53, 0.97)',
              border: `1px solid ${colors.border}`,
              borderRadius: radius.lg,
              overflow: 'hidden',
              maxHeight: 'calc(100dvh - 64px)',
            }}
          >
            {/* Modal header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: `1px solid ${colors.borderSubtle}`,
            }}>
              <span style={{
                fontSize: '14px',
                fontFamily: fonts.sans,
                fontWeight: 600,
                color: colors.textPrimary,
              }}>
                Select Scene
              </span>
              <button
                onClick={() => { setOpen(false); setQuery('') }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: colors.textDim,
                  fontSize: '18px',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            {renderSearch()}
            {renderList()}
          </div>
        </div>
      )}

      {/* ── Desktop: dropdown panel ── */}
      {open && !isMobile && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            minWidth: '100%',
            width: 'max-content',
            maxHeight: '320px',
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(26, 31, 53, 0.95)',
            backdropFilter: 'blur(12px)',
            border: `1px solid ${colors.border}`,
            borderRadius: radius.lg,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {renderSearch()}
          {renderList()}
        </div>
      )}
    </div>
  )
}
