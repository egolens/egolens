import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const repositoryRoot = path.dirname(import.meta.dirname)
const graphReport = process.env.PHASE9_AUTHOR_GRAPH_REPORT
const sourceCommit = process.env.PHASE9_SOURCE_COMMIT

if (!graphReport || !path.isAbsolute(graphReport) || !sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
  throw new Error('Trusted counted author build inputs are missing.')
}

const allowedLocalModule = (relative: string): boolean => {
  if (relative === 'amnesia.html' || relative === 'src/amnesia-main.tsx' || relative === 'src/AmnesiaAuthorApp.tsx'
    || relative === 'src/theme.ts') return true
  if (relative.startsWith('src/components/TeachableLens/')) return true
  if (relative.startsWith('src/teachable/')
    && !relative.includes('/__tests__/')
    && !relative.includes('/__fixtures__/')
    && !relative.startsWith('src/teachable/conformance/')) return true
  return new Set([
    'src/types/dataset.ts',
    'src/utils/matrix.ts',
    'src/utils/merge.ts',
    'src/utils/parquet.ts',
    'src/utils/quaternion.ts',
    'src/utils/rangeImage.ts',
    'src/utils/themeParams.ts',
    'src/workers/fetchHelper.ts',
  ]).has(relative)
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Trusted graph policy: reject every local runtime module outside the reviewed author closure. */
function countedAuthorGraphPolicy(): Plugin {
  const deniedMarkers = [
    'Waymo Open Dataset',
    'nuScenes',
    'Argoverse 2',
    'egolens-hidden-oracle',
    'OracleJudgeReceipt',
    'phase6-oracle',
  ]
  return {
    name: 'counted-adapter-amnesia-graph-policy',
    generateBundle(_options, bundle) {
      const moduleIds = new Set(Object.values(bundle).flatMap((entry) =>
        entry.type === 'chunk' ? Object.keys(entry.modules) : [],
      ))
      const moduleMap = new Map<string, { path: string; bytes: number; sha256: string }>()
      for (const rawId of [...moduleIds].sort()) {
        if (rawId.startsWith('\0')) continue
        const withoutQuery = rawId.split('?', 1)[0]
        if (!path.isAbsolute(withoutQuery)) continue
        const canonical = realpathSync(withoutQuery)
        if (canonical.includes(`${path.sep}node_modules${path.sep}`)) continue
        if (canonical !== repositoryRoot && !canonical.startsWith(`${repositoryRoot}${path.sep}`)) {
          this.error(`Adapter Amnesia build imported a local module outside its exact checkout: ${rawId}`)
        }
        const relative = path.relative(repositoryRoot, canonical).split(path.sep).join('/')
        if (!allowedLocalModule(relative)) {
          this.error(`Adapter Amnesia build imported a module outside the reviewed author closure: ${relative}`)
        }
        const info = lstatSync(canonical)
        if (!info.isFile() || info.isSymbolicLink()) this.error(`Unsafe author module type: ${relative}`)
        const bytes = readFileSync(canonical)
        moduleMap.set(relative, { path: relative, bytes: bytes.length, sha256: sha256(bytes) })
      }
      const modules = [...moduleMap.values()]
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      const emittedCode = Object.values(bundle)
        .filter((entry) => entry.type === 'chunk')
        .map((entry) => entry.code)
        .join('\n')
      const marker = deniedMarkers.find((value) => emittedCode.includes(value))
      if (marker) this.error(`Adapter Amnesia author build emitted denied identifier: ${marker}`)
      if (!modules.some((entry) => entry.path === 'src/amnesia-main.tsx')
        || !modules.some((entry) => entry.path === 'src/AmnesiaAuthorApp.tsx')) {
        this.error('Adapter Amnesia author entry modules are missing from the emitted graph.')
      }
      writeFileSync(graphReport, `${JSON.stringify({
        kind: 'egolens-counted-author-source-graph',
        schemaVersion: 1,
        sourceCommit,
        modules,
        moduleCount: modules.length,
        totalBytes: modules.reduce((total, entry) => total + entry.bytes, 0),
      })}\n`, { flag: 'wx', mode: 0o600 })
    },
  }
}

export default defineConfig({
  root: repositoryRoot,
  base: './',
  // The counted author build stages candidate source; a staged `.env*` or
  // `postcss.config.*` must not be able to influence or execute during it.
  envDir: false,
  css: { postcss: { plugins: [] } },
  define: { __EGOLENS_GIT_COMMIT__: JSON.stringify(sourceCommit) },
  plugins: [react(), countedAuthorGraphPolicy()],
  build: {
    outDir: 'dist-amnesia-author',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: path.join(repositoryRoot, 'amnesia.html') },
  },
})
