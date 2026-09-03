import { colors } from '../../theme'
import type { SourceInventoryV1 } from '../../teachable/authoring/SourceInventory'
import type { SensorConfigurationV1 } from '../../teachable/authoring/sensorConfiguration'

type Modality = 'camera' | 'lidar' | 'radar'

export interface SensorLayoutConfirmProps {
  readonly inventory: SourceInventoryV1
  readonly configuration: SensorConfigurationV1
  readonly onChange: (configuration: SensorConfigurationV1) => void
  readonly onConfirm: () => void
}

/**
 * The human confirms how many sensors of each modality the recipe must expose
 * before any agent starts authoring. Defaults are inferred from the folder
 * layout; an edited count drops the inferred ids for that modality.
 */
export default function SensorLayoutConfirm({ inventory, configuration, onChange, onConfirm }: SensorLayoutConfirmProps) {
  const setCount = (modality: Modality, value: string) => {
    const parsed = Number.parseInt(value, 10)
    const count = Number.isFinite(parsed) ? Math.max(0, Math.min(64, parsed)) : 0
    const { [modality]: _dropped, ...names } = configuration.names ?? {}
    onChange({ ...configuration, [modality]: count, ...(Object.keys(names).length > 0 ? { names } : { names: undefined }) })
  }
  const setNames = (modality: Modality, value: string) => {
    const list = value.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
    const names = { ...(configuration.names ?? {}), [modality]: list }
    onChange({ ...configuration, [modality]: list.length, names })
  }
  return (
    <div data-testid="sensor-configuration" style={{ marginTop: 18, padding: 14, border: `1px solid ${colors.border}`, borderRadius: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>Confirm the sensor layout</div>
      <p style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 1.5, margin: '6px 0 10px' }}>
        {inventory.snapshot().entries.length} files scanned. Defaults are guessed from the folder layout; correct them so the recipe must expose every physical stream.
      </p>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {(['camera', 'lidar', 'radar'] as const).map((modality) => (
          <div key={modality} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: colors.textSecondary, minWidth: 180 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {modality} sensors
              <input
                type="number" min={0} max={64} value={configuration[modality]}
                aria-label={`${modality} sensor count`}
                onChange={(event) => setCount(modality, event.currentTarget.value)}
                style={{ width: 90, padding: '6px 8px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgBase, color: colors.textPrimary }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {modality} ids (comma-separated, optional)
              <input
                type="text" value={(configuration.names?.[modality] ?? []).join(', ')}
                aria-label={`${modality} sensor ids`}
                placeholder="found in the folder, edit if wrong"
                onChange={(event) => setNames(modality, event.currentTarget.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bgBase, color: colors.textPrimary }}
              />
            </label>
          </div>
        ))}
      </div>
      <button onClick={onConfirm} style={{ marginTop: 12, padding: '8px 14px', borderRadius: 8, border: 0, background: colors.accent, color: colors.textOnAccent, fontWeight: 700, cursor: 'pointer' }}>
        Confirm and start authoring
      </button>
    </div>
  )
}
