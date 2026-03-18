# Changelog

All notable changes to EgoLens will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-18

First public release.

### Added

- **Multi-dataset support** — Waymo Open Dataset v2.0, nuScenes, and Argoverse 2 with auto-detection
- **LiDAR point clouds** — up to 5 sensors with 7 colormap modes (intensity, height, range, elongation, segmentation, panoptic, camera projection)
- **3D bounding boxes** — wireframe or 3D model rendering with color-coded tracking
- **2D camera bounding boxes** — overlay on camera panels with cross-modal hover linking
- **5 synchronized camera views** with POV switching
- **Trajectory trails** — object movement history as fading polylines
- **3D/2D human keypoints** — 14-joint skeleton per pedestrian (Waymo)
- **Segmentation overlays** — LiDAR semantic (Waymo, nuScenes) and camera panoptic (Waymo)
- **Timeline** — play/pause, speed control (0.5×–4×), frame scrubber, buffer bar
- **URL loading** — load data from S3 or any static file server with auto-discovery or direct segment access
- **Share View** — copy a link that captures your exact view state (frame, colormap, sensors, overlays)
- **Embed mode** — iframe embedding with postMessage API
- **Local file support** — drag & drop or folder picker

[0.1.0]: https://github.com/egolens/egolens/releases/tag/v0.1.0
