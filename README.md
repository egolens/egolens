<h1 align="center">EgoLens</h1>

<p align="center">
  Explore the most widely used autonomous driving datasets<br/>
  — Waymo, nuScenes, and Argoverse 2 —<br/>
  directly in your browser, straight from the original files.<br/>
  No conversion, no preprocessing.
</p>

<p align="center">
  <a href="https://waymo.com/open/download/"><img src="https://img.shields.io/badge/Waymo_Open_Dataset-Perception_v2.0-4285F4?style=for-the-badge" alt="Waymo" /></a>&nbsp;
  <a href="https://www.nuscenes.org/"><img src="https://img.shields.io/badge/nuScenes-v1.0-00B4D8?style=for-the-badge" alt="nuScenes" /></a>&nbsp;
  <a href="https://www.argoverse.org/"><img src="https://img.shields.io/badge/Argoverse_2-sensor-FF6F00?style=for-the-badge" alt="Argoverse 2" /></a>
</p>

<p align="center">
  <a href="https://egolens.github.io/egolens"><strong>Live Demo</strong></a> ·
  <a href="#url-loading">URL Loading</a> ·
  <a href="#share-view">Share View</a> ·
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

| Feature | Waymo v2 | nuScenes | Argoverse 2 |
|---------|:--------:|:--------:|:-----------:|
| LiDAR point cloud | ✓ (5 sensors) | ✓ (1 sensor + 5 radar) | ✓ (2 sensors) |
| Camera images | ✓ (5 cams) | ✓ (6 cams) | ✓ (7 cams) |
| 3D bounding boxes | ✓ | ✓ | ✓ |
| 2D camera boxes | ✓ | — | — |
| Cross-modal hover linking | ✓ | — | — |
| Trajectory trails | ✓ | ✓ | ✓ |
| 3D human keypoints | ✓ | — | — |
| 2D camera keypoints | ✓ | — | — |
| LiDAR segmentation | ✓ (23-class) | ✓ (32-class) | — |
| Camera panoptic seg | ✓ (29-class) | — | — |
| POV camera switching | ✓ | ✓ | ✓ |
| Local (drag & drop) | ✓ | ✓ | ✓ |
| URL loading | ✓ | ✓ | ✓ |

Dataset format is auto-detected from folder structure.

## Quick Start

### Local files (drag & drop)

1. Open the [live demo](https://egolens.github.io/egolens)
2. Drag & drop your dataset folder into the browser
3. Done — browse frames, toggle sensors, play the timeline

### URL Loading

Load data directly from S3 or any static file server by providing a URL.

**Two modes:**

- **URL only** — auto-discovers all segments/scenes in the directory
- **URL + Segment ID** — loads a specific segment directly (works with any static file server)

```
https://egolens.github.io/egolens/?dataset=argoverse2&data=https://your-server.com/av2/sensor/val/
https://egolens.github.io/egolens/?dataset=nuscenes&data=https://your-server.com/nuscenes/
https://egolens.github.io/egolens/?dataset=waymo&data=https://your-server.com/waymo_data/&scene=SEGMENT_ID
```

The URL should point to a directory containing the dataset's standard folder structure. Works with S3 buckets, any HTTP server, or localhost.

> **Note:** Waymo's license prohibits data redistribution, so no hosted demo data is available. You'll need to host your own copy after accepting the [Waymo Open Dataset License](https://waymo.com/open/terms/).

### Share View

When data is loaded via URL, a **Share View** button appears in the header. It copies a link that captures your exact view state — frame position, colormap, sensor toggles, overlays, point settings, and more. Anyone with the same data URL can open the link and see exactly what you see.

## Dev Setup

```bash
git clone https://github.com/egolens/egolens.git
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

**Chrome / Edge recommended.** Safari may crash on large datasets due to WebKit memory limits. Firefox works but lacks the folder picker API.

## Feedback

Found a bug? Have a feature idea? Want support for another dataset? [Open an issue](https://github.com/egolens/egolens/issues) — all feedback is welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) · Built by [Heejae Kim](https://github.com/happyhj)
