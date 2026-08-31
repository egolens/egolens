import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { createReadStream, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function sourceCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Vite plugin to serve waymo_data/ files with Range Request support.
 * hyparquet reads Parquet via asyncBufferFromUrl which uses Range headers
 * to fetch only the needed byte ranges (footer, row groups).
 */
function installLocalEvidenceDataMiddleware(middlewares: Connect.Server): void {
  // Segment discovery: list available segments from vehicle_pose folder
  middlewares.use((req, res, next) => {
    if (req.url !== '/api/segments') return next()

    const dataPath = process.env.VITE_WAYMO_DATA_PATH || './waymo_data'
    const posePath = path.resolve(__dirname, dataPath, 'vehicle_pose')
    try {
      const files = readdirSync(posePath)
      const segments = files
        .filter(f => f.endsWith('.parquet'))
        .map(f => f.replace('.parquet', ''))
        .sort()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ segments }))
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ segments: [] }))
    }
  })

  // Serve the three approved local evidence roots with Range Request support.
  // These middlewares exist only in Vite dev/preview and are never emitted in
  // the browser bundle.
  middlewares.use((req, res, next) => {
    if (!req.url) return next()
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const localRoots = [
      {
        prefix: '/waymo_data/',
        root: path.resolve(__dirname, process.env.VITE_WAYMO_DATA_PATH || './waymo_data'),
      },
      { prefix: '/v1.0-mini/', root: path.resolve(__dirname, './v1.0-mini') },
      { prefix: '/argo/', root: path.resolve(__dirname, './argo') },
    ]
    const match = localRoots.find(({ prefix }) => pathname.startsWith(prefix))
    if (!match) return next()
    const relative = decodeURIComponent(pathname.slice(match.prefix.length))
    const filePath = path.resolve(match.root, relative)
    if (filePath !== match.root && !filePath.startsWith(`${match.root}${path.sep}`)) return next()
    let stat
    try {
      stat = statSync(filePath)
    } catch {
      return next()
    }
    if (!stat.isFile()) return next()

    const contentType = filePath.endsWith('.json') ? 'application/json'
      : filePath.endsWith('.jpg') || filePath.endsWith('.jpeg') ? 'image/jpeg'
        : filePath.endsWith('.png') ? 'image/png'
          : 'application/octet-stream'

    const range = req.headers.range
    if (range) {
      const parts = range.replace('bytes=', '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      })
      if (req.method === 'HEAD') res.end()
      else createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      })
      if (req.method === 'HEAD') res.end()
      else createReadStream(filePath).pipe(res)
    }
  })
}

function serveLocalEvidenceData(): Plugin {
  return {
    name: 'serve-local-evidence-data',
    configureServer(server) {
      installLocalEvidenceDataMiddleware(server.middlewares)
    },
    configurePreviewServer(server) {
      // Normative Phase 6 measurements use a production build. Serving the
      // same pinned local Waymo files in preview avoids invalid dev/HMR DOM
      // baselines while preserving the Range-request behavior hyparquet uses.
      installLocalEvidenceDataMiddleware(server.middlewares)
    },
  }
}

/**
 * R3F 9.5 leaves its module-scoped last-frame values pointing at an unmounted
 * root after the animation loop stops. Its embedded React reconciler also
 * retains the last FiberRoot for nested-update detection; R3F leaves that
 * root's `containerInfo` pointing at the disposed scene store. Clear both
 * references only at their library-owned teardown terminals.
 *
 * Keep this as a fail-closed source transform until the upstream dependency
 * releases an equivalent fix. A changed dependency body must be reviewed
 * instead of silently shipping without the lifecycle guarantee.
 */
function releaseR3fRetainedRoots(): Plugin {
  const modulePattern = /[/\\]@react-three[/\\]fiber[/\\]dist[/\\]events-[^/\\]+\.esm\.js(?:\?|$)/u
  const terminal = [
    '    running = false;',
    '    return cancelAnimationFrame(frame);',
  ].join('\n')
  const replacement = [
    '    running = false;',
    '    state = undefined;',
    '    subscribers = undefined;',
    '    subscription = undefined;',
    '    return cancelAnimationFrame(frame);',
  ].join('\n')
  const unmountTerminal = [
    '            dispose(state.scene);',
    '            _roots.delete(canvas);',
    '            if (callback) callback(canvas);',
  ].join('\n')
  const unmountReplacement = [
    '            dispose(state.scene);',
    '            _roots.delete(canvas);',
    '            fiber.containerInfo = null;',
    '            if (callback) callback(canvas);',
  ].join('\n')

  return {
    name: 'release-r3f-retained-roots',
    enforce: 'pre',
    transform(code, id) {
      if (!modulePattern.test(id)) return null
      const loopTerminals = code.split(terminal).length - 1
      const unmountTerminals = code.split(unmountTerminal).length - 1
      if (loopTerminals !== 1 || unmountTerminals !== 1) {
        this.error(
          `Expected one R3F loop/unmount terminal in ${id}; found ${loopTerminals}/${unmountTerminals}`,
        )
      }
      return {
        code: code
          .replace(terminal, replacement)
          .replace(unmountTerminal, unmountReplacement),
        map: null,
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(() => ({
  // Served from the apex custom domain (public/CNAME), so assets live at the root.
  // GitHub Pages 301s egolens.github.io/egolens/* → egolens.org/*, keeping old links alive.
  base: '/',
  define: {
    __EGOLENS_GIT_COMMIT__: JSON.stringify(sourceCommit()),
  },
  plugins: [react(), releaseR3fRetainedRoots(), serveLocalEvidenceData()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    watch: {
      // Exclude large dataset directories from file watching to avoid ENOSPC
      ignored: [
        '**/waymo_data/**',
        '**/v1.0-mini/**',
        '**/v1.0-trainval/**',
        '**/argo/**',
        '**/samples/**',
        '**/sweeps/**',
      ],
    },
    headers: {
      // Allow embedding from any HTTPS origin (for iframe embed mode)
      'X-Frame-Options': 'ALLOWALL',
    },
  },
  // CSP headers for production (static hosting should also set these):
  // Content-Security-Policy: frame-ancestors 'self' https:;
  // This allows the page to be embedded in any HTTPS iframe while blocking HTTP.
}))
