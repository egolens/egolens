import { trackTeaching } from '../../utils/teachableTelemetry'
import { useId, useState } from 'react'
import './adapterEntry.css'

export default function OtherFormatsChip({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  const tooltipId = useId()
  const [dismissed, setDismissed] = useState(false)
  return (
    <span className="other-formats-chip" data-tooltip-dismissed={dismissed} onMouseEnter={() => setDismissed(false)} onFocus={() => setDismissed(false)}>
      <button type="button" disabled={disabled} aria-haspopup="dialog" aria-describedby={tooltipId}
        onClick={() => { setDismissed(true); trackTeaching('intro_open'); onClick() }}
        onKeyDown={(event) => {
          // Viewer shortcuts blur focused buttons; preserve native activation here.
          event.stopPropagation()
          if (event.key === 'Escape') setDismissed(true)
        }}>
        <span aria-hidden="true">＋ </span>Other formats
      </button>
      <span id={tooltipId} role="tooltip" className="other-formats-tooltip">
        <span>Teach EgoLens a new dataset format with AI and reusable adapter recipes.</span>
      </span>
    </span>
  )
}
