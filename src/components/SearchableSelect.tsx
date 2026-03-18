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
}

export default function SearchableSelect({
  items,
  value,
  onChange,
  placeholder = '-- select --',
  disabled = false,
  title,
}: Props) {
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

  // Close on outside click
  useEffect(() => {
    if (!open) return
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
      // Small delay so the DOM is painted
      requestAnimationFrame(() => inputRef.current?.focus())
    }
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

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: '0 1 auto', minWidth: 0 }}>
      <style>{SCROLLBAR_CSS}</style>
      {/* Trigger button (looks like a select) */}
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
        {selectedLabel}
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

      {/* Dropdown panel */}
      {open && (
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
          {/* Search input */}
          <div style={{ padding: '8px 8px 4px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <div style={{ position: 'relative' }}>
              {/* Search icon */}
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
                  padding: '6px 8px 6px 26px',
                  fontSize: '12px',
                  fontFamily: fonts.mono,
                  backgroundColor: colors.bgDeep,
                  color: colors.textPrimary,
                  border: `1px solid ${colors.borderSubtle}`,
                  borderRadius: radius.sm,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {/* Count badge */}
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

          {/* Item list */}
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
                      e.preventDefault() // keep input focused
                      handleSelect(item.value)
                    }}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    style={{
                      padding: '5px 12px',
                      fontSize: '12px',
                      fontFamily: fonts.mono,
                      color: isSelected ? colors.accent : colors.textPrimary,
                      backgroundColor: isHighlighted ? colors.bgHover : 'transparent',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
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
        </div>
      )}
    </div>
  )
}
