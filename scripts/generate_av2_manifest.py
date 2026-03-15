#!/usr/bin/env python3
"""
Generate manifest.json for an Argoverse 2 log directory.

This manifest is REQUIRED for URL-based loading in Perception Studio.
It provides frame discovery data (LiDAR timestamps + per-camera image timestamps)
that replaces the local file-path scanning used in drag-and-drop mode.

Usage:
    python scripts/generate_av2_manifest.py /path/to/av2/sensor/val/01bb304d-7bd8-...

    # Multiple logs:
    for d in /path/to/av2/sensor/val/*/; do
        python scripts/generate_av2_manifest.py "$d"
    done

Output:
    {log_dir}/manifest.json  (~50KB for 150 frames × 7 cameras)

Schema:
    {
      "version": 1,
      "dataset": "argoverse2",
      "log_id": "01bb304d-...",
      "num_frames": 150,
      "duration_s": 15.0,
      "frames": [
        {
          "timestamp_ns": "315966265659927216",
          "cameras": {
            "ring_front_center": "315966265649927222",
            "ring_front_left": "315966265649927333",
            ...
          }
        },
        ...
      ]
    }

Notes:
    - timestamp_ns values are JSON strings (not numbers) because JavaScript
      cannot represent nanosecond timestamps as Number (exceeds 2^53).
    - Camera timestamps are the actual image file timestamps, matched to the
      nearest LiDAR sweep by the generation script (same logic as the browser app).
    - The manifest is ~50KB for a typical 150-frame log — negligible overhead.
"""

import json
import sys
from pathlib import Path

RING_CAMERAS = [
    'ring_rear_left',
    'ring_side_left',
    'ring_front_left',
    'ring_front_center',
    'ring_front_right',
    'ring_side_right',
    'ring_rear_right',
]


def find_closest(sorted_list: list[int], target: int) -> int:
    """Binary search for closest value in a sorted list."""
    if not sorted_list:
        raise ValueError('Empty list')
    lo, hi = 0, len(sorted_list) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_list[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    # Check neighbor
    if lo > 0 and abs(sorted_list[lo - 1] - target) < abs(sorted_list[lo] - target):
        return sorted_list[lo - 1]
    return sorted_list[lo]


def generate_manifest(log_dir: Path) -> dict:
    log_id = log_dir.name

    # 1. Discover LiDAR timestamps
    lidar_dir = log_dir / 'sensors' / 'lidar'
    if not lidar_dir.exists():
        print(f'Error: {lidar_dir} not found', file=sys.stderr)
        sys.exit(1)

    lidar_timestamps = sorted(
        int(f.stem) for f in lidar_dir.glob('*.feather')
    )

    if not lidar_timestamps:
        print(f'Error: no .feather files in {lidar_dir}', file=sys.stderr)
        sys.exit(1)

    # 2. Discover camera timestamps per camera
    cam_timestamps: dict[str, list[int]] = {}
    for cam_name in RING_CAMERAS:
        cam_dir = log_dir / 'sensors' / 'cameras' / cam_name
        if cam_dir.exists():
            ts_list = sorted(int(f.stem) for f in cam_dir.glob('*.jpg'))
            if ts_list:
                cam_timestamps[cam_name] = ts_list

    # 3. Match each LiDAR frame to nearest camera timestamp
    frames = []
    for lidar_ts in lidar_timestamps:
        cameras = {}
        for cam_name, cam_ts_list in cam_timestamps.items():
            closest = find_closest(cam_ts_list, lidar_ts)
            cameras[cam_name] = str(closest)
        frames.append({
            'timestamp_ns': str(lidar_ts),
            'cameras': cameras,
        })

    # 4. Compute duration
    duration_s = 0.0
    if len(lidar_timestamps) >= 2:
        duration_s = (lidar_timestamps[-1] - lidar_timestamps[0]) / 1e9

    return {
        'version': 1,
        'dataset': 'argoverse2',
        'log_id': log_id,
        'num_frames': len(frames),
        'duration_s': round(duration_s, 2),
        'frames': frames,
    }


def main():
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} /path/to/av2/log_dir', file=sys.stderr)
        print(f'       {sys.argv[0]} /path/to/av2/sensor/val/01bb304d-...', file=sys.stderr)
        sys.exit(1)

    log_dir = Path(sys.argv[1]).resolve()

    if not log_dir.is_dir():
        print(f'Error: {log_dir} is not a directory', file=sys.stderr)
        sys.exit(1)

    if not (log_dir / 'sensors' / 'lidar').exists():
        print(f'Error: {log_dir}/sensors/lidar/ not found', file=sys.stderr)
        print('Make sure you point to a single AV2 log directory.', file=sys.stderr)
        sys.exit(1)

    manifest = generate_manifest(log_dir)
    out_path = log_dir / 'manifest.json'
    with open(out_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    size_kb = out_path.stat().st_size / 1024
    print(f'✓ Wrote {out_path}')
    print(f'  {manifest["num_frames"]} frames, {manifest["duration_s"]}s, {size_kb:.1f} KB')
    print(f'  Cameras: {", ".join(manifest["frames"][0]["cameras"].keys()) if manifest["frames"] else "none"}')


if __name__ == '__main__':
    main()
