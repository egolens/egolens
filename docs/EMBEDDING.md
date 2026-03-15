# Embedding Perception Studio

Perception Studio can be embedded in third-party websites via iframe, following the Matterport embed pattern.

## Quick Start

```html
<iframe
  src="https://your-host.com/waymo-perception-studio/?dataset=argoverse2&data=https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/train/00a6ffc1-6ce9-3bc3-a060-6006e9893a1a/&embed=true"
  width="100%"
  height="600"
  frameborder="0"
  allow="autoplay"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

## URL Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `embed` | `true` | — | **Required.** Activates embed mode (hides header, landing page, credit bar) |
| `dataset` | string | — | **Required.** Dataset type (`argoverse2`) |
| `data` | URL | — | **Required.** Base URL to the dataset log directory |
| `controls` | `full` \| `minimal` \| `none` | `full` | UI controls visibility |
| `frame` | number | `0` | Initial frame index (0-based) |
| `camera` | string | — | Initial camera POV (e.g., `FRONT`, `ring_front_center`) |
| `autoplay` | `true` | `false` | Auto-start playback after first frame loads |
| `colormap` | string | `intensity` | Initial colormap mode |
| `bgcolor` | hex | — | Canvas background color without `#` (e.g., `000000`, `1a1f35`) |
| `origin` | URL origin | — | Allowed origin for postMessage (auto-derived from referrer if omitted) |

### Controls Modes

- **`full`** (default): All controls visible — layer panel, camera controls, BEV minimap, timeline with annotations
- **`minimal`**: Only play/pause button, scrubber, and frame counter
- **`none`**: View-only — orbit/pan/zoom still works, but no UI overlays. Camera strip also hidden.

### Colormap Values

`intensity` | `range` | `elongation` | `distance` | `segment` | `panoptic` | `camera`

## postMessage API

The embed communicates with the host page via `window.postMessage`. All messages are JSON objects with a `type` field.

### Inbound (Host → Embed)

```js
// Seek to frame 42
iframe.contentWindow.postMessage({ type: 'setFrame', frame: 42 }, '*')

// Start/stop playback
iframe.contentWindow.postMessage({ type: 'play' }, '*')
iframe.contentWindow.postMessage({ type: 'pause' }, '*')

// Change colormap
iframe.contentWindow.postMessage({ type: 'setColormap', colormap: 'height' }, '*')

// Request current state (viewer replies with 'stateReply')
iframe.contentWindow.postMessage({ type: 'getState' }, '*')
```

### Outbound (Embed → Host)

```js
window.addEventListener('message', (event) => {
  const { type } = event.data

  if (type === 'ready') {
    // First frame rendered — embed is interactive
    console.log('Embed ready!')
  }

  if (type === 'frameChange') {
    // Frame changed — { frame: number, totalFrames: number }
    console.log(`Frame: ${event.data.frame} / ${event.data.totalFrames}`)
  }

  if (type === 'stateReply') {
    // Response to getState — { frame, totalFrames, isPlaying, colormap, status }
    console.log('State:', event.data)
  }

  if (type === 'error') {
    // Load error — { message: string }
    console.error('Embed error:', event.data.message)
  }
})
```

## Security

### Origin Validation

The embed validates `event.origin` of inbound messages. Configure via:
1. `&origin=https://your-site.com` URL parameter (explicit)
2. Automatic derivation from `document.referrer` (implicit)

If neither is available, all origins are accepted (permissive mode).

### Iframe Sandbox

Recommended sandbox attributes:
```html
sandbox="allow-scripts allow-same-origin"
```

- `allow-scripts`: Required for the viewer to function
- `allow-same-origin`: Required for Web Workers and Service Workers
- **Do NOT add** `allow-top-navigation` — prevents the embed from navigating the parent page

### CSP Headers (Self-Hosted)

For production deployments, set these response headers on the Perception Studio HTML:

```
Content-Security-Policy: frame-ancestors 'self' https:;
X-Frame-Options: ALLOWALL
```

This allows embedding from any HTTPS origin while blocking insecure HTTP embeds.

### Same-Origin Embeds

If embedding on the same domain, consider serving the embed from a subdomain (e.g., `embed.studio.example.com`) to provide origin isolation via the browser's same-origin policy.

## Examples

### Minimal View-Only Embed
```html
<iframe
  src="...?dataset=argoverse2&data=...&embed=true&controls=none&bgcolor=000000"
  width="800" height="450"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

### Auto-Playing with Minimal Controls
```html
<iframe
  src="...?dataset=argoverse2&data=...&embed=true&controls=minimal&autoplay=true&colormap=distance"
  width="100%" height="600"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

### Interactive with postMessage
```html
<iframe id="viewer"
  src="...?dataset=argoverse2&data=...&embed=true&origin=https://my-site.com"
  width="100%" height="700"
  sandbox="allow-scripts allow-same-origin"
></iframe>

<script>
  const viewer = document.getElementById('viewer')

  window.addEventListener('message', (e) => {
    if (e.data.type === 'ready') {
      // Jump to frame 50 once loaded
      viewer.contentWindow.postMessage({ type: 'setFrame', frame: 50 }, '*')
    }
    if (e.data.type === 'frameChange') {
      document.getElementById('frame-display').textContent =
        `Frame ${e.data.frame} / ${e.data.totalFrames}`
    }
  })
</script>
```
