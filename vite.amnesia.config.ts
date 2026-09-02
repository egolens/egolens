import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function sourceCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** Fail the build if the author-only graph gains a hidden answer or judge. */
function enforceAmnesiaModuleBoundary(): Plugin {
  const denied = [
    /[/\\]src[/\\]App\.tsx$/u,
    /[/\\]src[/\\]stores[/\\]useSceneStore\.ts$/u,
    /[/\\]src[/\\]adapters[/\\](?:recipes|waymo|nuscenes|argoverse2)[/\\]/u,
    /[/\\]src[/\\]teachable[/\\]conformance[/\\]/u,
    /[/\\]scripts[/\\].*(?:oracle|judge)/u,
  ]
  const deniedMarkers = [
    'Waymo Open Dataset',
    'nuScenes',
    'Argoverse 2',
    'egolens-hidden-oracle',
    'OracleJudgeReceipt',
    'phase6-oracle',
  ]
  return {
    name: 'enforce-adapter-amnesia-module-boundary',
    generateBundle(_options, bundle) {
      const moduleIds = Object.values(bundle).flatMap((entry) =>
        entry.type === 'chunk' ? Object.keys(entry.modules) : [],
      )
      const violation = moduleIds.find((id) => denied.some((pattern) => pattern.test(id)))
      if (violation) this.error(`Adapter Amnesia author build imported denied module: ${violation}`)
      const emittedCode = Object.values(bundle)
        .filter((entry) => entry.type === 'chunk')
        .map((entry) => entry.code)
        .join('\n')
      const marker = deniedMarkers.find((value) => emittedCode.includes(value))
      if (marker) this.error(`Adapter Amnesia author build emitted denied identifier: ${marker}`)
    },
  }
}

export default defineConfig({
  base: './',
  // Same auto-discovery lockdown as vite.config.ts: no `.env*` loading and an
  // inert inline PostCSS configuration.
  envDir: false,
  css: { postcss: { plugins: [] } },
  define: { __EGOLENS_GIT_COMMIT__: JSON.stringify(sourceCommit()) },
  plugins: [react(), enforceAmnesiaModuleBoundary()],
  build: {
    outDir: 'dist-amnesia-author',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: path.resolve(import.meta.dirname, 'amnesia.html') },
  },
})
