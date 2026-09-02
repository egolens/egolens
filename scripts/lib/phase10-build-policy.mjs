import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

export const PHASE10_AUTHOR_STAGE_FILES = Object.freeze([
  'amnesia.html',
  'tsconfig.app.json',
  'src/vite-env.d.ts',
  'src/amnesia-main.tsx',
  'src/AmnesiaAuthorApp.tsx',
  'src/theme.ts',
  'src/types/dataset.ts',
  'src/types/lz4js.d.ts',
  'src/types/waymo.ts',
  'src/utils/matrix.ts',
  'src/utils/merge.ts',
  'src/utils/parquet.ts',
  'src/utils/quaternion.ts',
  'src/utils/rangeImage.ts',
  'src/utils/themeParams.ts',
  'src/workers/fetchHelper.ts',
])

export const PHASE10_AUTHOR_STAGE_ROOTS = Object.freeze([
  'src/components/TeachableLens',
  'src/teachable',
])

async function regularFiles(root, relativeRoot) {
  const result = []
  const visit = async (relative) => {
    const absolute = path.join(root, relative)
    const entries = (await readdir(absolute, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`
      const info = await lstat(path.join(root, child))
      if (info.isSymbolicLink()) throw new Error(`Author source closure contains a symlink: ${child}`)
      if (info.isDirectory()) await visit(child)
      else if (info.isFile()) result.push(child)
      else throw new Error(`Author source closure contains an unsupported entry: ${child}`)
    }
  }
  await visit(relativeRoot)
  return result
}

export async function phase10AuthorStageFilesV1(sourceRoot) {
  const files = new Set(PHASE10_AUTHOR_STAGE_FILES)
  for (const relativeRoot of PHASE10_AUTHOR_STAGE_ROOTS) {
    for (const relative of await regularFiles(sourceRoot, relativeRoot)) {
      if (relative.includes('/__tests__/') || relative.includes('/__fixtures__/')
        || relative.startsWith('src/teachable/conformance/')) continue
      files.add(relative)
    }
  }
  return [...files].sort()
}

/**
 * Reviewed Vite build invocation. Two properties are load-bearing:
 *
 * 1. `--configLoader runner` executes the byte-reviewed config without
 *    writing a bundled temp file into the read-only source stage.
 * 2. The runner loader first boots an internal Vite environment rooted at
 *    `process.cwd()` (with `configFile: false`), and Vite's CSS plugin eagerly
 *    searches that root for `postcss.config.*`. A candidate PostCSS config at
 *    the process cwd would therefore execute even though the reviewed config
 *    pins an inline PostCSS setup. The build must run with its cwd in a fresh
 *    driver-owned directory that can hold no candidate files, and the
 *    candidate stage is passed explicitly as the positional build root.
 */
export function phase10ReviewedViteBuildInvocationV1({ node, nodeModules, configFile, sourceRoot, cwd }) {
  for (const [name, value] of Object.entries({ node, nodeModules, configFile, sourceRoot, cwd })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error(`Reviewed Vite invocation requires an absolute ${name}`)
    }
  }
  if (cwd === sourceRoot || cwd.startsWith(`${sourceRoot}${path.sep}`) || sourceRoot.startsWith(`${cwd}${path.sep}`)) {
    throw new Error('Reviewed Vite build cwd must be disjoint from the candidate source stage')
  }
  return Object.freeze({
    cwd,
    // `vite build [root]`: the candidate stage is the positional root.
    command: Object.freeze([
      node, path.join(nodeModules, 'vite', 'bin', 'vite.js'), 'build', sourceRoot,
      '--config', configFile, '--configLoader', 'runner',
    ]),
  })
}
