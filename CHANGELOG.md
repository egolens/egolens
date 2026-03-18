# Changelog

All notable changes to EgoLens will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-18

First public release.

### Added

- **Multi-dataset support** — Waymo Open Dataset v2.0, nuScenes, and Argoverse 2 with auto-detection from folder structure
- **LiDAR point clouds** — up to 5 sensors (~168K points/frame) with 7 colormap modes: intensity, height, range, elongation, semantic segmentation, panoptic segmentation, and GPU camera projection
- **3D bounding boxes** — wireframe or GLB model rendering (vehicle, pedestrian, cyclist) with class-colored tracking
- **2D camera bounding boxes** — Canvas overlay on camera panels, synced with box mode toggle
- **Cross-modal hover linking** — hover a 2D box to highlight its 3D counterpart and vice versa
- **5 synchronized camera views** — preloaded JPEG panels with POV switching (quaternion slerp transitions)
- **Camera frustum visualization** — base-only wireframe by default, full wireframe on hover
- **Trajectory trails** — past N frames of object positions as fading polylines
- **3D human keypoints** — 14-joint skeleton per pedestrian (Waymo only)
- **2D camera keypoints** — Canvas 2D overlay with occluded joint indicators (Waymo only)
- **Camera panoptic segmentation** — 29-class colored overlay (Waymo only)
- **LiDAR segmentation** — 23-class semantic coloring (Waymo), 32-class (nuScenes)
- **Timeline** — frame scrubber, play/pause (spacebar), speed control (0.5×–4×), buffer bar, per-feature annotation markers
- **URL loading** — load from S3 or any static file server; auto-discovery (manifest → S3 listing → directory listing) and direct segment access via URL params
- **Share View** — copies a URL encoding full view state (frame, colormap, sensors, overlays, point settings) to clipboard
- **URL state sync** — browser URL auto-updates on segment switch (replaceState)
- **Embed mode** — iframe embedding with bidirectional postMessage API
- **Preset example pills** — one-click URLs for nuScenes mini and Argoverse 2
- **Searchable segment selector** — combobox dropdown with filtering for large segment lists
- **Parallel worker pools** — 4 LiDAR + 2 camera workers for fast decompression
- **GPU camera colormap** — custom ShaderMaterial for zero-CPU camera color projection
- **Local file support** — drag & drop or folder picker (Chrome/Edge)

[0.1.0]: https://github.com/happyhj/egolens/releases/tag/v0.1.0
