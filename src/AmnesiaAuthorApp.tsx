import { useEffect, useState } from 'react'
import TeachableLensPanel from './components/TeachableLens/TeachableLensPanel'
import { teachableAuthoringSession } from './teachable/authoring/browserSession'
import { sourceInventoryFromFilesV1 } from './teachable/authoring/SourceInventory'
import { registerTeachableWebMcpToolsV1 } from './teachable/authoring/webMcp'
import { colors, fonts } from './theme'

export default function AmnesiaAuthorApp() {
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void registerTeachableWebMcpToolsV1(teachableAuthoringSession).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  const selectFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    try {
      const entries = [...files].map((file) => [file.webkitRelativePath || file.name, file] as const)
      teachableAuthoringSession.start(sourceInventoryFromFilesV1(entries))
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
      {error && <pre style={{ whiteSpace: 'pre-wrap', color: colors.danger, fontSize: 11 }}>{error}</pre>}
    </section>
  </main>
}

