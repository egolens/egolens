import { useId, useState } from 'react'
import './adapterEntry.css'

export default function OtherFormatsChip({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  const tooltipId = useId()
  const [dismissed, setDismissed] = useState(false)
  return (
    <span className="other-formats-chip" data-tooltip-dismissed={dismissed} onMouseEnter={() => setDismissed(false)} onFocus={() => setDismissed(false)}>
      <button type="button" disabled={disabled} aria-haspopup="dialog" aria-describedby={tooltipId}
        onClick={() => { setDismissed(true); onClick() }}
        onKeyDown={(event) => {
          // Viewer shortcuts blur focused buttons; preserve native activation here.
          event.stopPropagation()
          if (event.key === 'Escape') setDismissed(true)
        }}>
        <span aria-hidden="true">＋ </span>Other formats
      </button>
      <span id={tooltipId} role="tooltip" className="other-formats-tooltip">
        <span>Learn how adapter recipes open more dataset formats.</span>
      </span>
    </span>
  )
}
