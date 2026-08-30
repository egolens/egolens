# Embedding EgoLens

EgoLens can be embedded in third-party websites via iframe, following the Matterport embed pattern.

The hosted build at `https://egolens.org` is embeddable as-is — no need to run your own copy unless you want to pin a version or serve it from your own origin.

## Quick Start

```html
<iframe
  src="https://egolens.org/?dataset=argoverse2&data=https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/train/00a6ffc1-6ce9-3bc3-a060-6006e9893a1a/&embed=true"
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
| `t0` / `t1` | int64 string | — | Playback time window (sensor timestamps, ns or µs). Auto-seeks to the window start and loops playback inside it; `t0` wins over `frame` |
| `cameras` | `all` \| `false` | follows `controls` | Camera strip visibility. `false` also skips loading camera images entirely when nothing else needs them — the largest allocation in a scene |
| `camera` | string | — | Initial camera POV by name: the panel label (`FRONT`, `REAR LEFT`), the dataset's own channel name (`ring_front_center`, `CAM_FRONT`), or an id. Case, spaces, underscores and hyphens are ignored. Share links write the numeric `cam=` instead, and `cam` wins when both are present |
| `autoplay` | `true` | `false` | Auto-start playback after first frame loads |
| `colormap` | string | `intensity` | Initial colormap mode |
| `theme` | `dark` \| `light` \| `auto` | OS preference | Chrome theme; `auto` follows the operating-system preference on load |
| `accent` | six-digit hex | theme default | Chrome accent without `#` (for example `FF6F00`); does not recolor sensors, classes, colormaps, or annotations |
| `origin` | URL origin | — | Allowed origin for postMessage (auto-derived from referrer if omitted) |

### Controls Modes

| Surface | `full` | `minimal` | `none` |
|---|---|---|---|
| Layer panel (coordinate, sensors, colormap, perception) | shown | hidden | hidden |
| Floating buttons (BEV, Pin, Keys) | shown | hidden | hidden |
| Axis gizmo, POV indicator | shown | shown | hidden |
| Timeline (play/pause, scrubber, counter, buffer) | shown | shown | hidden |
| Timeline annotation lanes | shown | hidden | — |
| Playback-range handles | draggable | ticks only | — |
| Camera strip | shown | shown | hidden by default |

`none` is view-only: orbit/pan/zoom still work, but nothing is drawn over the
3D view. The camera strip is content rather than chrome, so `cameras=`
overrides its default in every mode — `controls=none&cameras=all` is a bare
viewer that still shows camera images.

Keyboard shortcuts follow their surfaces: the playback-range trim shortcuts
(`Cmd/Ctrl+Shift+←/→`) need the timeline and are unavailable under `none`.

### Colormap Values

`intensity` | `range` | `elongation` | `distance` | `segment` | `panoptic` | `camera`

### Deep links are fast

A `scene` parameter alongside a multi-scene `data` URL (an AV2 split/root, or
a sharded nuScenes root) loads that scene **directly** — the scene list is
discovered in the background and fills the selector afterwards. Embeds that
point at one scene each start rendering without paying discovery cost.

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

// Switch to another scene — no iframe reload needed. The scene must be one
// of the discovered scenes (unknown ids reply with an 'error' message).
iframe.contentWindow.postMessage({ type: 'setScene', scene: 'scene-0103' }, '*')

// Clip playback to a [t0, t1] sensor-time interval (int64 as strings).
// Pass t0: null to clear the window.
iframe.contentWindow.postMessage({ type: 'setWindow', t0: '1533151608548020', t1: '1533151613398020' }, '*')
iframe.contentWindow.postMessage({ type: 'setWindow', t0: null }, '*')

// Repaint chrome without reloading the iframe. `accent: null` restores the
// selected theme's default; omit accent to preserve the current custom value.
iframe.contentWindow.postMessage({ type: 'setTheme', theme: 'light', accent: 'FF6F00' }, '*')

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

  if (type === 'sceneChange') {
    // Scene switched (host- or user-initiated) — { scene: string, totalFrames: number }
    console.log(`Scene: ${event.data.scene}`)
  }

  if (type === 'stateReply') {
    // Response to getState — { frame, totalFrames, isPlaying, colormap,
    // status, scene, window, theme, accent }
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

Only relevant if you self-host. Set these response headers on the EgoLens HTML:

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
  src="...?dataset=argoverse2&data=...&embed=true&controls=none&theme=dark"
  width="800" height="450"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

### Auto-Playing with Minimal Controls
```html
<iframe
  src="...?dataset=argoverse2&data=...&embed=true&controls=minimal&autoplay=true&colormap=distance&theme=light&accent=FF6F00"
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
