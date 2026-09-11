import { colors, fonts, radius } from '../theme'

export default function DatasetLoadButton({ onClick, disabled = false, loading = false }: {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}) {
  const unavailable = disabled || loading
  return <button type="button" className="dataset-load-button" onClick={onClick} disabled={unavailable} aria-busy={loading} style={{
    padding: '8px 20px', fontSize: '12px', fontFamily: fonts.sans, fontWeight: 600,
    backgroundColor: unavailable ? colors.bgOverlay : colors.accent,
    color: unavailable ? colors.textDim : colors.textOnAccent,
    border: 'none', borderRadius: radius.sm, cursor: unavailable ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s', whiteSpace: 'nowrap', minWidth: '72px',
  }}>{loading ? '…' : 'Load'}</button>
}
