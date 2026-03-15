import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { createReadStream, statSync, readdirSync } from 'node:fs'

/**
 * Vite plugin to serve waymo_data/ files with Range Request support.
 * hyparquet reads Parquet via asyncBufferFromUrl which uses Range headers
 * to fetch only the needed byte ranges (footer, row groups).
 */
function serveWaymoData(): Plugin {
  return {
    name: 'serve-waymo-data',
    configureServer(server) {
      // Segment discovery: list available segments from vehicle_pose folder
      server.middlewares.use((req, res, next) => {
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

      // Serve waymo_data/ files with Range Request support
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/waymo_data/')) return next()

        const filePath = path.resolve(__dirname, req.url.slice(1))
        let stat
        try {
          stat = statSync(filePath)
        } catch {
          return next()
        }

        const range = req.headers.range
        if (range) {
          const parts = range.replace('bytes=', '').split('-')
          const start = parseInt(parts[0], 10)
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': end - start + 1,
            'Content-Type': 'application/octet-stream',
            'Accept-Ranges': 'bytes',
          })
          createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': 'application/octet-stream',
            'Accept-Ranges': 'bytes',
          })
          createReadStream(filePath).pipe(res)
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/waymo-perception-studio/',
  plugins: [react(), serveWaymoData()],
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
})
