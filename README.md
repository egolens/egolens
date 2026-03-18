<p align="center">
  <img src="assets/banner.png" alt="EgoLens" width="720" />
</p>

<p align="center">
  Browser-native 3D perception explorer for autonomous driving datasets<br/>
  <strong>Waymo · nuScenes · Argoverse 2</strong><br/>
  No install. No server. Your data never leaves your browser.
</p>

<p align="center">
  <a href="https://happyhj.github.io/egolens"><strong>Live Demo</strong></a> ·
  <a href="#url-loading">URL Loading</a> ·
  <a href="#dev-setup">Dev Setup</a>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/ca5566ed-f2f2-42ad-8c13-b05d9150aacc" alt="EgoLens screenshot" width="720" />
</p>

## What It Does

Drop in a dataset folder (or provide a URL) and instantly explore autonomous driving scenes in 3D — no Python, no preprocessing, no uploads.

- **LiDAR point clouds** from up to 5 sensors with 6 colormap modes (intensity, height, range, elongation, semantic segmentation, camera projection)
- **3D bounding boxes** rendered as wireframes or 3D models (vehicle, pedestrian, cyclist) with color-coded tracking
- **5 synchronized camera views** with POV switching — click a camera to jump into its viewpoint
- **Cross-modal hover linking** — hover a 2D camera box and its 3D counterpart highlights, and vice versa
- **Trajectory trails** showing object movement over past frames
- **Human keypoints** — 14-joint 3D skeleton per pedestrian, with 2D camera overlay
- **Semantic segmentation** — LiDAR (23-class) and camera panoptic (29-class) overlays
- **Timeline** with play/pause, speed control (0.5x–4x), and buffer progress bars

<table>
  <tr>
    <td><img src="https://private-user-images.githubusercontent.com/3903575/556982733-8ca4aa6e-5818-4d2f-bed2-58687dd825d8.gif" alt="LiDAR point cloud driving scene" /></td>
    <td><img src="https://private-user-images.githubusercontent.com/3903575/556980659-0c99b33b-59d8-4fcb-9a47-cba7bdaa51fa.gif" alt="3D model rendering and POV switching" /></td>
  </tr>
</table>

## Supported Datasets

| Dataset | Local (drag & drop) | URL loading |
|---------|:------------------:|:-----------:|
| [Waymo Open Dataset v2.0](https://waymo.com/open/) | ✓ | ✓ |
| [nuScenes](https://www.nuscenes.org/) | ✓ | ✓ |
| [Argoverse 2](https://www.argoverse.org/) | ✓ | ✓ |

Dataset format is auto-detected from folder structure.

## Quick Start

### Local files (drag & drop)

1. Open the [live demo](https://happyhj.github.io/egolens)
2. Drag & drop your dataset folder into the browser
3. Done — browse frames, toggle sensors, play the timeline

### URL Loading

Provide a URL to load data directly from S3 or any HTTP server.

**Two modes:**

- **URL only** — auto-discovers all segments/scenes in the directory
- **URL + Segment ID** — loads a specific segment directly (works with any static file server)

```
https://happyhj.github.io/egolens/?dataset=argoverse2&data=https://your-bucket.s3.amazonaws.com/av2/sensor/val/
https://happyhj.github.io/egolens/?dataset=nuscenes&data=https://data.egolens.org/nuscenes/
https://happyhj.github.io/egolens/?dataset=waymo&data=https://your-server.com/waymo_data/&scene=SEGMENT_ID
```

> **Note:** Waymo's license prohibits data redistribution, so no hosted demo data is available. You'll need to host your own copy after accepting the [Waymo Open Dataset License](https://waymo.com/open/terms/).

## Dev Setup

```bash
git clone https://github.com/happyhj/egolens.git
cd egolens
npm install
npm run dev
```

```bash
npm run build   # Type-check + production build
npm run lint    # ESLint
npm test        # Vitest
```

## Built With

React 19 · TypeScript · Three.js · React Three Fiber · Vite · Zustand · hyparquet · Web Workers

## Browser Support

Chrome / Edge recommended (folder drag & drop + folder picker). Firefox / Safari support folder drag & drop only.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) · Built by [Heejae Kim](https://github.com/happyhj)
