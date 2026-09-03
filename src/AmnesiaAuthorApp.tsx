import { useEffect, useState } from 'react'
import TeachableLensPanel from './components/TeachableLens/TeachableLensPanel'
import { teachableAuthoringSession } from './teachable/authoring/browserSession'
import { sourceInventoryFromFilesV1, type SourceInventoryV1 } from './teachable/authoring/SourceInventory'
import { inferSensorConfigurationV1, type SensorConfigurationV1 } from './teachable/authoring/sensorConfiguration'
import SensorLayoutConfirm from './components/TeachableLens/SensorLayoutConfirm'
import { selectedFileKeysV1 } from './teachable/authoring/selectedFileKeys'
import { registerTeachableWebMcpToolsV1 } from './teachable/authoring/webMcp'
import { colors, fonts } from './theme'

export default function AmnesiaAuthorApp() {
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The folder is scanned first; authoring starts only after the human
  // confirms how many sensors of each modality the recipe must expose.
  const [pending, setPending] = useState<{ inventory: SourceInventoryV1; configuration: SensorConfigurationV1 } | null>(null)

  useEffect(() => {
    void registerTeachableWebMcpToolsV1(teachableAuthoringSession).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  const selectFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    try {
      // Same canonical relative keys as the ordinary viewer's directory input,
      // so an authored recipe binds identically at capture time.
      const inventory = sourceInventoryFromFilesV1(selectedFileKeysV1(files))
      setPending({ inventory, configuration: inferSensorConfigurationV1(inventory.snapshot()) })
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const confirmConfiguration = () => {
    if (!pending) return
    try {
      teachableAuthoringSession.start(pending.inventory, { sensorConfiguration: pending.configuration })
      setPending(null)
      setStarted(true)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (started) return <TeachableLensPanel />
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: colors.bgBase, color: colors.textPrimary, fontFamily: fonts.sans, padding: 24 }}>
    <section style={{ width: 'min(620px, 100%)', padding: 28, background: colors.bgSurface, border: `1px solid ${colors.border}`, borderRadius: 16 }}>
      <div style={{ color: colors.accent, fontSize: 11, fontWeight: 800, letterSpacing: '0.12em' }}>ADAPTER AMNESIA · PUBLIC AUTHOR WORKSPACE</div>
      <h1 style={{ margin: '10px 0 8px', fontSize: 26 }}>Teach the lens what it can’t yet see.</h1>
      <p style={{ color: colors.textSecondary, lineHeight: 1.6, fontSize: 13 }}>
        This isolated build exposes only bounded source inspection, the public recipe contract, registered operators, revision validation, state, and finalization. It contains no dataset registry, bundled adapter recipe, oracle, or judge.
      </p>
      <label style={{ display: 'inline-flex', marginTop: 12, padding: '10px 14px', background: colors.accent, color: colors.textOnAccent, borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
        Select held-out dataset folder
        <input
          type="file"
          multiple
          hidden
          {...{ webkitdirectory: '' }}
          onChange={(event) => selectFiles(event.currentTarget.files)}
        />
      </label>
      {pending && (
        <SensorLayoutConfirm
          inventory={pending.inventory}
          configuration={pending.configuration}
          onChange={(configuration) => setPending({ ...pending, configuration })}
          onConfirm={confirmConfiguration}
        />
      )}
      {error && <pre style={{ whiteSpace: 'pre-wrap', color: colors.danger, fontSize: 11 }}>{error}</pre>}
    </section>
  </main>
}

