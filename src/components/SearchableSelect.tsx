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
 *   - Virtualized list (react-window v2) for 700+ items
 *   - Lazy-loaded scene thumbnails (on-mount fetch + concurrent queue)
 */

import { useState, useRef, useEffect, useCallback, useMemo, type CSSProperties, type ReactElement } from 'react'
import { List, type ListImperativeAPI } from 'react-window'
import { colors, fonts, radius } from '../theme'
import { trackKeyboardShortcut } from '../utils/analytics'
import {
  useThumbnailCache,
  type ThumbnailResolverFn,
  type ThumbnailEntry,
} from '../hooks/useThumbnailCache'

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
  /** Async thumbnail resolver function (dataset-specific). null = no thumbnails. */
  thumbnailResolver?: ThumbnailResolverFn | null
}

/** Row height: 60px when thumbnails enabled, 32px without */
const ROW_HEIGHT_THUMB = 60
const ROW_HEIGHT_PLAIN = 32
const ROW_HEIGHT_MOBILE = 44
/** Thumbnail size (px) */
const THUMB_W = 48
const THUMB_H = 32

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

// ---------------------------------------------------------------------------
// Thumbnail image component
// ---------------------------------------------------------------------------

function ThumbnailImage({ entry }: { entry: ThumbnailEntry }) {
  if (entry.status === 'loaded' && entry.url) {
    return (
      <img
        src={entry.url}
        alt=""
        style={{
          width: THUMB_W,
          height: THUMB_H,
          objectFit: 'cover',
          borderRadius: '3px',
          flexShrink: 0,
          opacity: 1,
          transition: 'opacity 0.15s ease-in',
        }}
      />
    )
  }

  if (entry.status === 'loading') {
    return (
      <div
        style={{
          width: THUMB_W,
          height: THUMB_H,
          borderRadius: '3px',
          flexShrink: 0,
          backgroundColor: colors.bgOverlay,
          animation: 'ss-pulse 1.2s ease-in-out infinite',
        }}
      />
    )
  }

  // unavailable or idle — camera SVG placeholder
  return (
    <div
      style={{
        width: THUMB_W,
        height: THUMB_H,
        borderRadius: '3px',
        flexShrink: 0,
        backgroundColor: colors.bgOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
        <rect x="1" y="2" width="16" height="11" rx="1.5" stroke={colors.textDim} strokeWidth="1.2" />
        <circle cx="9" cy="7.5" r="3" stroke={colors.textDim} strokeWidth="1.2" />
        <circle cx="9" cy="7.5" r="1" fill={colors.textDim} />
        <rect x="12" y="3.5" width="2.5" height="1.5" rx="0.5" fill={colors.textDim} />
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row component for react-window v2 (receives custom props via rowProps)
// ---------------------------------------------------------------------------

interface RowCustomProps {
  filtered: SelectItem[]
  selectedValue: string | null
  highlightIdx: number
  isMobile: boolean
  hasThumbnails: boolean
  getThumbnail: (id: string) => ThumbnailEntry
  requestThumbnail: (id: string) => void
  onSelect: (value: string) => void
  onHover: (index: number) => void
}

function VirtualRow({
  index,
  style,
  filtered,
  selectedValue,
  highlightIdx,
  isMobile,
  hasThumbnails,
  getThumbnail,
  requestThumbnail,
  onSelect,
  onHover,
}: {
  index: number
  style: CSSProperties
  ariaAttributes: Record<string, unknown>
} & RowCustomProps): ReactElement | null {
  const item = filtered[index]
  if (!item) return null

  const isSelected = item.value === selectedValue
  const isHighlighted = index === highlightIdx

  return (
    <RowItem
      item={item}
      style={style}
      isSelected={isSelected}
      isHighlighted={isHighlighted}
      isMobile={isMobile}
      hasThumbnails={hasThumbnails}
      getThumbnail={getThumbnail}
      requestThumbnail={requestThumbnail}
      onSelect={onSelect}
      onHover={() => onHover(index)}
    />
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SearchableSelect({
  items,
  value,
  onChange,
  placeholder = '-- select --',
  disabled = false,
  title,
  mobileLabel,
  thumbnailResolver = null,
}: Props) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<ListImperativeAPI>(null)

  const hasThumbnails = thumbnailResolver != null
  const rowHeight = isMobile
    ? Math.max(hasThumbnails ? ROW_HEIGHT_THUMB : ROW_HEIGHT_PLAIN, ROW_HEIGHT_MOBILE)
    : (hasThumbnails ? ROW_HEIGHT_THUMB : ROW_HEIGHT_PLAIN)

  // Thumbnail cache
  const { getThumbnail, requestThumbnail } = useThumbnailCache(thumbnailResolver)

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

  // Scroll highlighted item into view (react-window v2)
  useEffect(() => {
    if (!open || !listRef.current) return
    listRef.current.scrollToRow({ index: highlightIdx, align: 'smart' })
  }, [highlightIdx, open, listRef])

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

  // Lock body scroll when modal is open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // / key opens selector (GitHub/YouTube convention)
  useEffect(() => {
    if (disabled) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === '/' && !open) {
        e.preventDefault()
        setOpen(true)
        setQuery('')
        trackKeyboardShortcut('/')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled, open])

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

  const handleHover = useCallback((index: number) => {
    setHighlightIdx(index)
  }, [])

  // Currently selected item's label
  const selectedLabel = items.find((item) => item.value === value)?.label ?? placeholder

  // Item count indicator for large lists
  const countLabel =
    items.length > 20 && query
      ? `${filtered.length}/${items.length}`
      : items.length > 20
        ? `${items.length} items`
        : null

  // ── Row props passed to react-window v2 rowComponent ──
  const rowProps: RowCustomProps = useMemo(() => ({
    filtered,
    selectedValue: value,
    highlightIdx,
    isMobile,
    hasThumbnails,
    getThumbnail,
    requestThumbnail,
    onSelect: handleSelect,
    onHover: handleHover,
  }), [filtered, value, highlightIdx, isMobile, hasThumbnails, getThumbnail, requestThumbnail, handleSelect, handleHover])

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

  // ── Virtualized list renderer ──
  const renderList = (maxHeight: number) => (
    <>
      <style>{`@keyframes ss-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }`}</style>
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
        <List<RowCustomProps>
          listRef={listRef as React.Ref<ListImperativeAPI>}
          className="ss-list"
          rowComponent={VirtualRow}
          rowCount={filtered.length}
          rowHeight={rowHeight}
          rowProps={rowProps}
          overscanCount={5}
          style={{
            maxHeight,
            overflowX: 'hidden',
          }}
        />
      )}
    </>
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
            {renderList(window.innerHeight - 200)}
          </div>
        </div>
      )}

      {/* ── Desktop: centered modal ── */}
      {open && !isMobile && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(4px)',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setOpen(false)
              setQuery('')
            }
          }}
        >
          <div
            style={{
              width: hasThumbnails ? '520px' : '480px',
              maxWidth: '90vw',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(26, 31, 53, 0.97)',
              border: `1px solid ${colors.border}`,
              borderRadius: radius.lg,
              boxShadow: '0 16px 48px rgba(0, 0, 0, 0.6)',
              overflow: 'hidden',
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
            {/* Desktop list area: cap at ~55% viewport height */}
            {renderList(Math.min(filtered.length * rowHeight, Math.round(window.innerHeight * 0.55)))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RowItem — individual list row (extracted to avoid re-creating per render)
// ---------------------------------------------------------------------------

interface RowItemProps {
  item: SelectItem
  style: React.CSSProperties
  isSelected: boolean
  isHighlighted: boolean
  isMobile: boolean
  hasThumbnails: boolean
  getThumbnail: (id: string) => ThumbnailEntry
  requestThumbnail: (id: string) => void
  onSelect: (value: string) => void
  onHover: () => void
}

function RowItem({
  item,
  style,
  isSelected,
  isHighlighted,
  isMobile,
  hasThumbnails,
  getThumbnail,
  requestThumbnail,
  onSelect,
  onHover,
}: RowItemProps) {
  // Request thumbnail when row mounts (i.e. enters react-window viewport)
  const thumbEntry = hasThumbnails ? getThumbnail(item.value) : null
  useEffect(() => {
    if (hasThumbnails) {
      requestThumbnail(item.value)
    }
  }, [hasThumbnails, item.value, requestThumbnail])

  return (
    <div
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        gap: hasThumbnails ? '10px' : '0',
        padding: isMobile
          ? (hasThumbnails ? '6px 16px' : '10px 16px')
          : (hasThumbnails ? '6px 12px' : '5px 12px'),
        fontSize: '12px',
        fontFamily: fonts.mono,
        color: isSelected ? colors.accent : colors.textPrimary,
        backgroundColor: isHighlighted ? colors.bgHover : 'transparent',
        cursor: 'pointer',
        transition: 'background-color 0.1s',
        boxSizing: 'border-box',
      }}
      title={item.value}
      onMouseDown={(e) => {
        e.preventDefault()
        onSelect(item.value)
      }}
      onMouseEnter={onHover}
    >
      {hasThumbnails && thumbEntry && <ThumbnailImage entry={thumbEntry} />}
      <div style={{
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: isMobile ? 'normal' : 'nowrap',
        wordBreak: isMobile ? 'break-all' : undefined,
        lineHeight: isMobile ? 1.4 : 1.3,
      }}>
        {item.label}
      </div>
    </div>
  )
}
