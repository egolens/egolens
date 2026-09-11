import { useId, useState } from 'react'
import { PANDASET_TEACHING_SAMPLES, type PandaSetSampleId } from '../../utils/teachingSample'
import { trackPresetClick } from '../../utils/analytics'
import './adapterEntry.css'

export default function HostedTeachingPreset({ onSelect, activeSampleId, disabled = false }: {
  onSelect: (sampleId: PandaSetSampleId) => void
  disabled?: boolean
  activeSampleId?: PandaSetSampleId
}) {
  const [sampleId, setSampleId] = useState<PandaSetSampleId>('001')
  const downloadHintId = useId()
  const active = activeSampleId === sampleId
  const sample = PANDASET_TEACHING_SAMPLES[sampleId]
  return (
    <div className="hosted-teaching-preset" onKeyDown={(event) => event.stopPropagation()}>
      <div className="hosted-sample-card" data-active={active}>
      <button type="button" className="hosted-teaching-button" disabled={disabled} aria-pressed={active}
        onClick={() => { trackPresetClick('pandaset'); onSelect(sampleId) }}>
        Try an unsupported format
      </button>
      <div className="hosted-sample-meta">
      <span>PandaSet</span>
      <div className="adapter-segmented hosted-sample-selector" role="group" aria-label="PandaSet log">
        {(['001', '002'] as const).map(id => <button key={id} type="button" disabled={disabled} aria-pressed={sampleId === id} onClick={() => setSampleId(id)}>{id}</button>)}
      </div>
      <span>· 80 frames</span>
      <span className="hosted-download">
        <a href={sample.zipUrl} aria-label={`Download PandaSet log ${sampleId} ZIP (${sample.zipSizeMB} MB)`} aria-describedby={downloadHintId}>↓ ZIP</a>
        <span id={downloadHintId} role="tooltip" className="hosted-download-hint">Download log {sampleId} ({sample.zipSizeMB} MB). Unzip, then drop the folder below.</span>
      </span>
      </div>
      </div>
    </div>
  )
}
