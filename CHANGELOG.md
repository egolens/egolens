# Changelog

All notable changes to EgoLens will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Moved to `https://egolens.org`** — the app now lives on its own domain instead of
  `egolens.github.io/egolens`. Existing links, including Share View URLs, are 301-redirected
  with their query strings intact, so no bookmarks or embeds break.

  > **If you host your own data:** the browser's request origin is now `https://egolens.org`.
  > Should your S3 bucket or file server allowlist `https://egolens.github.io` specifically in
  > its CORS configuration, add the new origin (or use `*`) or data loading will fail. Servers
  > already using `"AllowedOrigins": ["*"]` — the setup described in the docs — need no change.

### Added

- Page metadata for search engines and link previews — description, canonical URL,
  Open Graph / Twitter cards, and `SoftwareApplication` structured data
- `robots.txt`, `sitemap.xml`, and a proper favicon (the previous icon reference was broken)

## [1.0.0] - 2026-05-30

First stable release. Archived on Zenodo with a citable DOI.

### Added

- **`CITATION.cff`** — repository metadata for the GitHub "Cite this repository" button and Zenodo DOI

### Changed

- Promoted to a stable 1.0 release; no breaking changes from 0.1.0

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
- **Timeline** — play/pause, frame scrubber, buffer bar
- **URL loading** — load data from S3 or any static file server with auto-discovery or direct segment access
- **Share View** — copy a link that captures your exact view state (frame, colormap, sensors, overlays)
- **Embed mode** — iframe embedding with postMessage API
- **Local file support** — drag & drop or folder picker

[1.0.0]: https://github.com/egolens/egolens/releases/tag/v1.0.0
[0.1.0]: https://github.com/egolens/egolens/releases/tag/v0.1.0
