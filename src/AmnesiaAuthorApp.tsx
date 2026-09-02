import { useEffect, useState } from 'react'
import TeachableLensPanel from './components/TeachableLens/TeachableLensPanel'
import { teachableAuthoringSession } from './teachable/authoring/browserSession'
import { sourceInventoryFromFilesV1, type SourceInventoryV1 } from './teachable/authoring/SourceInventory'
import { inferSensorConfigurationV1, type SensorConfigurationV1 } from './teachable/authoring/sensorConfiguration'
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

  const setCount = (modality: 'camera' | 'lidar' | 'radar', value: string) => {
    if (!pending) return
    const parsed = Number.parseInt(value, 10)
    const count = Number.isFinite(parsed) ? Math.max(0, Math.min(64, parsed)) : 0
    // A count edit drops the inferred names for that modality; they no longer match.
    const { [modality]: _dropped, ...names } = pending.configuration.names ?? {}
    setPending({ ...pending, configuration: { ...pending.configuration, [modality]: count, ...(Object.keys(names).length > 0 ? { names } : { names: undefined }) } })
  }

  const setNames = (modality: 'camera' | 'lidar' | 'radar', value: string) => {
    if (!pending) return
    const list = value.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
    const names = { ...(pending.configuration.names ?? {}), [modality]: list }
    setPending({ ...pending, configuration: { ...pending.configuration, [modality]: list.length, names } })
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
        <div data-testid="sensor-configuration" style={{ marginTop: 18, padding: 14, border: `1px solid ${colors.border}`, borderRadius: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Confirm the sensor layout</div>
          <p style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 1.5, margin: '6px 0 10px' }}>
            {pending.inventory.snapshot().entries.length} files scanned. Defaults are guessed from the folder layout; correct them so the recipe must expose every physical stream.
          </p>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {(['camera', 'lidar', 'radar'] as const).map((modality) => (
              <div key={modality} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: colors.textSecondary, minWidth: 180 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {modality} sensors
                  <input
                    type="number" min={0} max={64} value={pending.configuration[modality]}
                    aria-label={`${modality} sensor count`}
                    onChange={(event) => setCount(modality, event.currentTarget.value)}
                    style={{ width: 90, padding: '6px 8px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgBase, color: colors.textPrimary }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {modality} ids (comma-separated, optional)
                  <input
                    type="text" value={(pending.configuration.names?.[modality] ?? []).join(', ')}
                    aria-label={`${modality} sensor ids`}
                    placeholder="found in the folder, edit if wrong"
                    onChange={(event) => setNames(modality, event.currentTarget.value)}
                    style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgBase, color: colors.textPrimary }}
                  />
                </label>
              </div>
            ))}
          </div>
          <button onClick={confirmConfiguration} style={{ marginTop: 12, padding: '8px 14px', borderRadius: 8, border: 0, background: colors.accent, color: colors.textOnAccent, fontWeight: 700, cursor: 'pointer' }}>Confirm and start authoring</button>
        </div>
      )}
      {error && <pre style={{ whiteSpace: 'pre-wrap', color: colors.danger, fontSize: 11 }}>{error}</pre>}
    </section>
  </main>
}

