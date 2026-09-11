import { beginTeachingCase, trackTeaching } from '../../utils/teachableTelemetry'
import { PANDASET_TEACHING_SAMPLES } from '../../utils/teachingSample'
import DatasetLoadButton from '../DatasetLoadButton'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { colors, radius } from '../../theme'
import { openRemoteSourceInventoryV1 } from '../../teachable/authoring/RemoteSourceInventory'
import { scanSelectedFiles } from '../../utils/folderScan'
import { readRecipeArtifactFileV1 } from '../../teachable/authoring/portability'
import { validateRecipeImportV1, validateRecipeSourceV1 } from '../../teachable/authoring/recipeImport'
import { fetchRemoteRecipeForImportV1 } from '../../teachable/share/RecipeTransport'
import { teachableAuthoringSession } from '../../teachable/authoring/browserSession'
import type { SourceInventoryV1 } from '../../teachable/authoring/SourceInventory'
import type { FinalizedArtifactRecordV1 } from '../../teachable/authoring/persistence'
import type { EgoLensAdapterRecipeV1 } from '../../teachable/recipe/types'
import { useAgent } from './stages'
import './adapterEntry.css'

export type AdapterEntryMode = 'choose' | 'use'
export interface AdapterEntryRequest {
  mode: AdapterEntryMode
  remoteUrl?: string
  recipeSource?: 'file' | 'url'
  inventory?: SourceInventoryV1
  savedRecipes?: readonly FinalizedArtifactRecordV1[]
}

export interface AdapterTeachingRequest {
  inventory: SourceInventoryV1
  savedRecipes: readonly FinalizedArtifactRecordV1[]
}

const buttonStyle: CSSProperties = {
  padding: '10px 14px', borderRadius: radius.md, border: `1px solid ${colors.border}`,
  background: colors.bgOverlay, color: colors.textPrimary, fontSize: 12, fontWeight: 600,
  cursor: 'pointer',
}
const primaryStyle: CSSProperties = { ...buttonStyle, background: colors.accent, color: colors.textOnAccent, borderColor: colors.accent }

export default function AdapterEntryDialog({ request, onClose, onTeach, onRender, onChoose, onSourceUrlChange, inline = false }: {
  request: AdapterEntryRequest
  inline?: boolean
  onSourceUrlChange?: (url: string | null) => void
  onChoose?: (request: AdapterTeachingRequest) => void
  onClose: () => void
  onTeach: (request: AdapterTeachingRequest) => void
  onRender: (inventory: SourceInventoryV1, recipe: EgoLensAdapterRecipeV1) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const folderPurpose = useRef<'use' | 'teach'>('use')
  const activeRequest = useRef<AbortController | null>(null)
  const inventoryRef = useRef(request.inventory ?? null)
  const handingOff = useRef(false)
  const [mode, setMode] = useState(request.mode)
  const [inventory, setInventory] = useState(request.inventory ?? null)
  const [saved, setSaved] = useState(request.savedRecipes ?? [])
  const [recipe, setRecipe] = useState<EgoLensAdapterRecipeV1 | null>(null)
  const [sourceTab, setSourceTab] = useState<'file' | 'url'>(request.recipeSource ?? 'file')
  const [dataTab, setDataTab] = useState<'local' | 'remote'>(request.remoteUrl || request.inventory?.kind === 'remote' ? 'remote' : 'local')
  const [dataUrl, setDataUrl] = useState(request.remoteUrl ?? '')
  const [recipeAttempted, setRecipeAttempted] = useState(false)
  const [url, setUrl] = useState('')
  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const agent = useAgent()
  const openingDataset = busy === 'Opening dataset…'
  useEffect(() => { onSourceUrlChange?.(dataTab === 'remote' ? dataUrl : null) }, [dataTab, dataUrl, onSourceUrlChange])

  useEffect(() => {
    if (inline) return () => {
      activeRequest.current?.abort()
      if (!handingOff.current) inventoryRef.current?.revoke()
    }
    const element = dialog.current!
    element.showModal()
    return () => { activeRequest.current?.abort(); element.close() }
  }, [inline])

  const close = () => {
    if (openingDataset) return
    activeRequest.current?.abort()
    inventoryRef.current?.revoke()
    onClose()
  }

  const changeMode = (next: AdapterEntryMode) => { setError(null); setMode(next) }
  const chooseFolder = (purpose: 'use' | 'teach' = 'use') => {
    folderPurpose.current = purpose
    folderInput.current?.click()
  }
  const handOffTeaching = (selected: SourceInventoryV1, matches: readonly FinalizedArtifactRecordV1[]) => {
    onTeach({ inventory: selected, savedRecipes: matches })
    // The authoring session now owns the selected files.
    inventoryRef.current = null
  }
  const run = async (label: string, operation: (signal: AbortSignal) => Promise<void>) => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    const telemetryEvent = label.includes('adapter') ? 'recipe_import' : 'load_start'
    const startedAt = performance.now()
    trackTeaching(telemetryEvent, { source: dataTab, outcome: 'started' })
    setBusy(label)
    setError(null)
    try { await operation(controller.signal); if (!controller.signal.aborted) trackTeaching(telemetryEvent === 'recipe_import' ? 'recipe_import' : 'source_selected', { source: dataTab, outcome: 'success', duration_ms: performance.now() - startedAt }) }
    catch (cause) { if (!controller.signal.aborted) { trackTeaching(telemetryEvent === 'recipe_import' ? 'recipe_import' : 'load_error', { source: dataTab, outcome: 'failure', duration_ms: performance.now() - startedAt }); setError(cause instanceof Error ? cause.message : String(cause)) } }
    finally { if (!controller.signal.aborted) setBusy(null) }
  }

  const selectFolder = (files: FileList | null) => {
    const purpose = folderPurpose.current
    folderPurpose.current = 'use'
    if (!files?.length) return
    void run('Checking folder…', async (signal) => {
      const selected = scanSelectedFiles(files).inventory
      if (!selected || selected.snapshot().entries.length === 0 || selected.truncated) {
        selected?.revoke()
        throw new Error('Select a nonempty dataset folder that can be read completely.')
      }
      const matches = await teachableAuthoringSession.findSavedRecipes(selected).catch(() => [])
      if (signal.aborted) { selected.revoke(); return }
      inventoryRef.current?.revoke()
      inventoryRef.current = selected
      handingOff.current = false
      setInventory(selected)
      setSaved(matches)
      trackTeaching('recognized', { match_count: matches.length, file_count: selected.snapshot().entries.length })
      if (purpose === 'teach') handOffTeaching(selected, matches)
    })
  }

  const clearSource = () => {
    inventoryRef.current?.revoke()
    inventoryRef.current = null
    setInventory(null)
    setSaved([])
    setError(null)
  }
  const connectRemote = (load = false) => {
    if (load) beginTeachingCase()
    return void run('Connecting to dataset…', async (signal) => {
    const root = new URL(dataUrl.trim())
    if (root.search || root.hash) throw new Error('Use a dataset folder URL without a query or fragment.')
    if (!root.pathname.endsWith('/')) root.pathname += '/'
    const hostedSample = Object.values(PANDASET_TEACHING_SAMPLES).find(sample => sample.rootUrl === root.href)
    const selected = await openRemoteSourceInventoryV1({
      rootUrl: root.href, catalogUrl: new URL('source-catalog.json', root).href,
      preferFullObjects: true, signal,
      ...(hostedSample ? { limits: { maxTotalResponseBytes: hostedSample.maxTotalResponseBytes } } : {}),
    })
    try {
      const matches = await teachableAuthoringSession.findSavedRecipes(selected).catch(() => [])
      if (signal.aborted) { selected.revoke(); return }
      inventoryRef.current?.revoke()
      inventoryRef.current = selected
      handingOff.current = false
      setInventory(selected)
      setSaved(matches)
      trackTeaching('recognized', { match_count: matches.length, file_count: selected.snapshot().entries.length })
      if (load && !recipe && onChoose) {
        handingOff.current = true
        inventoryRef.current = null
        setInventory(null)
        setSaved([])
        onChoose({ inventory: selected, savedRecipes: matches })
      } else if (load && recipe) {
        const validated = await validateRecipeImportV1(recipe)
        await validateRecipeSourceV1(validated, selected)
        if (signal.aborted) return
        handingOff.current = true
        await onRender(selected, validated)
        trackTeaching('load_success', { source: 'remote' })
        inventoryRef.current = null
        onClose()
      }
    } catch (cause) { selected.revoke(); throw cause }
  })
  }

  const importFile = (file: File | undefined) => {
    if (!file) return
    // A failed replacement must not leave the old recipe eligible for Render.
    setRecipeAttempted(true)
    setRecipe(null)
    void run('Checking adapter…', async (signal) => {
      const imported = await validateRecipeImportV1(await readRecipeArtifactFileV1(file))
      if (!signal.aborted) setRecipe(imported)
    })
  }

  const importUrl = () => {
    setRecipeAttempted(true)
    setRecipe(null)
    void run('Fetching adapter…', async (signal) => {
      const fetched = await fetchRemoteRecipeForImportV1(url.trim(), { signal, expectedRecipeHash: hash.trim() || undefined })
      const imported = await validateRecipeImportV1(fetched.recipe)
      if (!signal.aborted) setRecipe(imported)
    })
  }

  const render = (selectedRecipe: EgoLensAdapterRecipeV1) => {
    if (!inventory) return
    void run('Opening dataset…', async (signal) => {
      const validated = await validateRecipeImportV1(selectedRecipe)
      await validateRecipeSourceV1(validated, inventory)
      if (signal.aborted) return
      handingOff.current = true
      await onRender(inventory, validated)
      trackTeaching('load_success', { source: inventory.kind })
      // The scene now owns this inventory. Do not revoke it when closing.
      inventoryRef.current = null
      onClose()
    })
  }

  const loadLocal = () => {
    if (!inventory) return
    beginTeachingCase()
    trackTeaching('load_start', { source: 'local' })
    if (recipe) { render(recipe); return }
    if (onChoose) {
      handingOff.current = true
      inventoryRef.current = null
      setInventory(null)
      setSaved([])
      onChoose({ inventory, savedRecipes: saved })
    }
  }
  const invalidRecipe = !recipe && (recipeAttempted || (sourceTab === 'url' && !!url.trim()))

  const startTeaching = () => {
    if (!agent.available) return
    if (!inventory) { chooseFolder('teach'); return }
    try {
      handOffTeaching(inventory, saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const title = mode === 'use' ? 'Use an adapter recipe' : 'Open your dataset with an adapter'
  const content = (
    <>
      {!inline && <div className="adapter-dialog-heading">
        <h2 id="adapter-dialog-title">{title}</h2>
        <button type="button" aria-label="Close adapter setup" disabled={openingDataset} onClick={close} style={buttonStyle}>✕</button>
      </div>}
      {!inline && mode !== 'choose' && <button type="button" disabled={!!busy} onClick={() => changeMode('choose')} className="adapter-text-button">← Other format options</button>}

      <input ref={folderInput} aria-label="Dataset folder" type="file" hidden multiple {...{ webkitdirectory: '', directory: '' }} onChange={(event) => { selectFolder(event.target.files); event.target.value = '' }} />
      <input ref={fileInput} aria-label="Adapter recipe file" type="file" hidden accept=".json,.egolens-adapter.json,application/json" onChange={(event) => { importFile(event.target.files?.[0]); event.target.value = '' }} />

      {inventory && (
        <div className="adapter-source-summary">
          <div><strong>{inventory.kind === 'remote' ? 'Remote dataset connected' : 'Dataset folder selected'}</strong><p>{inventory.snapshot().entries.length.toLocaleString()} {inventory.snapshot().entries.length === 1 ? 'file' : 'files'}. Kept while you choose an adapter.</p></div>
          <button type="button" disabled={!!busy} onClick={() => inventory.kind === 'remote' ? clearSource() : chooseFolder()} style={buttonStyle}>{inventory.kind === 'remote' ? 'Change URL' : 'Change folder'}</button>
        </div>
      )}

      {mode === 'choose' && <>
        <p>Use an existing adapter to open your data, or create one with a browser agent.</p>
        <div className="adapter-entry-options">
          <div>
            <button type="button" disabled={!!busy} onClick={() => changeMode('use')} style={buttonStyle}>Use an adapter recipe</button>
            <p>File or URL. No AI agent needed.</p>
          </div>
          <div>
            <button type="button" disabled={!!busy || !agent.available} onClick={startTeaching} aria-describedby="adapter-agent-requirement" style={buttonStyle}>Create an adapter with AI</button>
            <p id="adapter-agent-requirement">Use the in-app browser in the Codex desktop app.</p>
          </div>
        </div>
      </>}

      {mode === 'use' && <>
        {!inline && <p>An adapter describes how to read your data. Select a recipe and its matching dataset folder. No AI agent is needed.</p>}
        {inline && <div>Adapter recipe <span style={{ color: colors.textDim }}>(optional)</span></div>}
        <div className="adapter-input-methods adapter-segmented" role="group" aria-label="Recipe source">
          <button type="button" disabled={!!busy} aria-pressed={sourceTab === 'file'} onClick={() => { setSourceTab('file'); setError(null) }} style={buttonStyle}>Recipe file</button>
          <button type="button" disabled={!!busy} aria-pressed={sourceTab === 'url'} onClick={() => { setSourceTab('url'); setError(null) }} style={buttonStyle}>Recipe URL</button>
        </div>
        {sourceTab === 'file'
          ? <button type="button" disabled={!!busy} onClick={() => fileInput.current?.click()} style={buttonStyle}>Import JSON</button>
          : <form onSubmit={(event) => { event.preventDefault(); importUrl() }} className="adapter-url-form">
              <label>Recipe URL<input type="url" required disabled={!!busy} value={url} onChange={(event) => { setUrl(event.target.value); setRecipe(null) }} placeholder="https://example.org/adapter.json" /></label>
              <p>The URL provides the recipe; you select the data folder separately.</p>
              {!inline && <details className="adapter-advanced-options">
                <summary>Advanced options{hash.trim() ? ' (version check enabled)' : ''}</summary>
                <label>Expected recipe hash (optional)<input type="text" disabled={!!busy} value={hash} onChange={(event) => { setHash(event.target.value); setRecipe(null) }} placeholder="sha256:…" spellCheck={false} /></label>
                <p>Only import the recipe version that matches this hash. Leave blank to use the recipe currently at this URL.</p>
              </details>}
              <button type="submit" disabled={!!busy || !url.trim()} style={buttonStyle}>Import URL</button>
            </form>}
        {inline && (recipe || recipeAttempted || url) && <button type="button" disabled={!!busy} className="adapter-text-button" onClick={() => { setRecipe(null); setRecipeAttempted(false); setUrl(''); setHash(''); setError(null) }}>Clear recipe</button>}
        {recipe && <div className="adapter-recipe-summary" role="status">
          <strong>{recipe.identity.name}</strong>
          <p>{(['lidar', 'camera', 'radar'] as const).flatMap((modality) => {
            const count = recipe.scene.sensors.filter((sensor) => sensor.modality === modality).length
            return count ? [`${count} ${modality === 'lidar' ? 'LiDAR' : modality === 'camera' ? (count === 1 ? 'camera' : 'cameras') : 'radar'}`] : []
          }).join(' · ') || 'No sensors declared'}</p>
          <p>Recipe checked. Ready to open with matching data.</p>
        </div>}
        {inline && <div>Data source <span style={{ color: colors.textDim }}>(required)</span></div>}
        <div className="adapter-input-methods adapter-segmented" role="group" aria-label="Dataset location">
          <button type="button" disabled={!!busy} aria-pressed={dataTab === 'local'} onClick={() => { if (dataTab !== 'local') { clearSource(); setDataTab('local') } }} style={buttonStyle}>Local folder</button>
          <button type="button" disabled={!!busy} aria-pressed={dataTab === 'remote'} onClick={() => { if (dataTab !== 'remote') { clearSource(); setDataTab('remote') } }} style={buttonStyle}>Remote URL</button>
        </div>
        {inline ? (dataTab === 'local' ? <div className="adapter-load-row">
          <button type="button" disabled={!!busy} onClick={() => chooseFolder()} style={buttonStyle}>{inventory ? 'Change folder' : 'Select Folder'}</button>
          <DatasetLoadButton disabled={!!busy || invalidRecipe || !inventory} loading={openingDataset} onClick={loadLocal} />
        </div> : <form className="adapter-url-form" onSubmit={(event) => { event.preventDefault(); if (!invalidRecipe && !busy && dataUrl.trim()) connectRemote(true) }}>
          <label htmlFor="adapter-data-url">Dataset folder URL</label>
          <div className="adapter-load-row">
            <input id="adapter-data-url" type="url" required disabled={!!busy} value={dataUrl} onChange={(event) => { clearSource(); setDataUrl(event.target.value) }} placeholder="https://your-server.com/dataset/log/" />
            <DatasetLoadButton disabled={!!busy || invalidRecipe || !dataUrl.trim()} loading={!!busy} onClick={() => connectRemote(true)} />
          </div>
          <p>This folder must contain source-catalog.json and allow browser access (CORS).</p>
        </form>) : <>
        {!inventory && (dataTab === 'local' ? <div className="adapter-folder-step">
          <button type="button" disabled={!!busy} onClick={() => chooseFolder()} style={buttonStyle}>Select Folder</button>
        </div> : <form className="adapter-url-form" onSubmit={(event) => { event.preventDefault(); connectRemote() }}>
          <label>Dataset folder URL<input type="url" required disabled={!!busy} value={dataUrl} onChange={(event) => { setDataUrl(event.target.value); setError(null) }} placeholder="https://your-server.com/dataset/log/" /></label>
          <p>This folder must contain source-catalog.json and allow browser access (CORS).</p>
          <button type="submit" disabled={!!busy || !dataUrl.trim()} style={buttonStyle}>Connect</button>
        </form>)}
        <button type="button" disabled={!!busy || !recipe || !inventory} onClick={() => recipe && render(recipe)} style={primaryStyle}>Render this dataset</button>
        </>}
      </>}

      {!inline && saved.length > 0 && <section className="adapter-saved" aria-label="Saved compatible adapters">
        <h3>Saved in this browser</h3>
        {saved.map((record) => <div key={record.recipeHash} className="adapter-source-summary">
          <div><strong>{record.artifact.identity.name}</strong><p>Matches the selected folder layout.</p></div>
          <button type="button" disabled={!!busy} onClick={() => render(record.artifact)} style={buttonStyle}>Render now</button>
        </div>)}
      </section>}

      {busy && <p role="status" aria-live="polite">{busy}</p>}
      {error && <p className="adapter-error" role="alert">{error}</p>}
    </>
  )
  if (inline) return <div className="adapter-inline" onKeyDown={(event) => event.stopPropagation()}>{content}</div>
  return (
    <dialog ref={dialog} className="adapter-dialog" aria-labelledby="adapter-dialog-title" onCancel={(event) => {
      // File-picker cancellation bubbles too; it must not dismiss this dialog.
      if (event.target !== event.currentTarget) { folderPurpose.current = 'use'; return }
      event.preventDefault()
      close()
    }} onKeyDown={(event) => event.stopPropagation()}>
      {content}
    </dialog>
  )
}
