#!/usr/bin/env python3
"""
Shard a nuScenes version into per-scene mini-datasets for URL hosting.

Why: full trainval metadata is one set of giant JSON tables (sample_data.json
~600MB) that a browser cannot parse, which is what kept URL mode mini-only.
Each shard this script emits is a tiny, self-contained nuScenes version dir
(one scene, keyframes only, ~1MB of JSON), so the existing browser loader
works on it unchanged. A split-level index.json lists the scenes for the
app's scene selector (see src/adapters/nuscenes/remote.ts).

Output layout (upload this directory as-is):
    out/
    ├── index.json                      # scene list + thumbnails
    └── scene-0001/
        ├── v1.0-trainval/*.json        # tables filtered to this scene
        ├── samples/CAM_FRONT/...jpg    # keyframe files only (no sweeps)
        ├── lidarseg/... panoptic/...   # when present in the source
        └── thumbnail.jpg               # 480px CAM_FRONT (requires Pillow)

Usage:
    python scripts/shard_nuscenes.py /path/to/nuscenes out/ --version v1.0-trainval
    python scripts/shard_nuscenes.py /path/to/nuscenes out/ --version v1.0-mini --scenes 2

RAM: the source tables are loaded whole — budget ~10GB for trainval.
"""

import argparse
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

# Tables copied whole into every shard (small, version-wide)
SHARED_TABLES = ['sensor.json', 'category.json', 'attribute.json', 'visibility.json']
THUMB_WIDTH = 480


def load_table(version_dir: Path, name: str):
    path = version_dir / name
    if not path.exists():
        return None
    print(f'  loading {name}...', flush=True)
    with open(path) as f:
        return json.load(f)


def dump_table(shard_version_dir: Path, name: str, rows):
    with open(shard_version_dir / name, 'w') as f:
        json.dump(rows, f, separators=(',', ':'))


def make_thumbnail(shard_dir: Path, cam_front_rel: str, src_root: Path) -> bool:
    try:
        from PIL import Image
    except ImportError:
        return False
    src = src_root / cam_front_rel
    if not src.exists():
        return False
    with Image.open(src) as img:
        ratio = THUMB_WIDTH / img.width
        thumb = img.resize((THUMB_WIDTH, round(img.height * ratio)), Image.LANCZOS)
        thumb.save(shard_dir / 'thumbnail.jpg', 'JPEG', quality=80)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('src', help='nuScenes root (contains v1.0-*/ and samples/)')
    parser.add_argument('out', help='Output directory for shards')
    parser.add_argument('--version', default='v1.0-trainval')
    parser.add_argument('--scenes', type=int, default=None, help='Limit scene count (testing)')
    args = parser.parse_args()

    src_root = Path(args.src).resolve()
    out_root = Path(args.out).resolve()
    version_dir = src_root / args.version
    if not (version_dir / 'scene.json').exists():
        print(f'Error: {version_dir}/scene.json not found', file=sys.stderr)
        sys.exit(1)
    out_root.mkdir(parents=True, exist_ok=True)

    print(f'Loading {args.version} tables from {src_root}')
    scenes = load_table(version_dir, 'scene.json')
    samples = load_table(version_dir, 'sample.json')
    sample_data = load_table(version_dir, 'sample_data.json')
    ego_poses = load_table(version_dir, 'ego_pose.json')
    calibrated = load_table(version_dir, 'calibrated_sensor.json')
    annotations = load_table(version_dir, 'sample_annotation.json') or []
    instances = load_table(version_dir, 'instance.json') or []
    logs = load_table(version_dir, 'log.json')
    lidarseg = load_table(version_dir, 'lidarseg.json') or []
    panoptic = load_table(version_dir, 'panoptic.json') or []
    shared = {name: load_table(version_dir, name) for name in SHARED_TABLES}

    print('Indexing...')
    samples_by_scene = defaultdict(list)
    for s in samples:
        samples_by_scene[s['scene_token']].append(s)
    # Keyframes only — the viewer never reads sweeps (metadata.ts skips them)
    keyframes_by_sample = defaultdict(list)
    for sd in sample_data:
        if sd['is_key_frame']:
            keyframes_by_sample[sd['sample_token']].append(sd)
    ego_by_token = {e['token']: e for e in ego_poses}
    calib_by_token = {c['token']: c for c in calibrated}
    anns_by_sample = defaultdict(list)
    for a in annotations:
        anns_by_sample[a['sample_token']].append(a)
    instance_by_token = {i['token']: i for i in instances}
    log_by_token = {l['token']: l for l in logs}
    seg_by_sd = defaultdict(list)
    for row in lidarseg:
        seg_by_sd[('lidarseg.json', row['sample_data_token'])] = row
    for row in panoptic:
        seg_by_sd[('panoptic.json', row['sample_data_token'])] = row

    scenes = sorted(scenes, key=lambda s: s['name'])
    if args.scenes:
        scenes = scenes[:args.scenes]

    index_entries = []
    for i, scene in enumerate(scenes):
        name = scene['name']
        print(f'[{i + 1}/{len(scenes)}] {name}', flush=True)
        shard_dir = out_root / name
        shard_version_dir = shard_dir / args.version
        shard_version_dir.mkdir(parents=True, exist_ok=True)

        scene_samples = samples_by_scene[scene['token']]
        scene_sd = [sd for s in scene_samples for sd in keyframes_by_sample[s['token']]]
        scene_anns = [a for s in scene_samples for a in anns_by_sample[s['token']]]
        used_instances = {a['instance_token'] for a in scene_anns}
        scene_seg = {}
        for table in ('lidarseg.json', 'panoptic.json'):
            rows = [seg_by_sd[(table, sd['token'])] for sd in scene_sd if (table, sd['token']) in seg_by_sd]
            if rows:
                scene_seg[table] = rows

        # Keyframe-only shards would leave sample_data prev/next dangling into
        # sweeps; the viewer never follows them, so cut the links explicitly.
        scene_sd = [{**sd, 'prev': '', 'next': ''} for sd in scene_sd]

        dump_table(shard_version_dir, 'scene.json', [scene])
        dump_table(shard_version_dir, 'sample.json', scene_samples)
        dump_table(shard_version_dir, 'sample_data.json', scene_sd)
        dump_table(shard_version_dir, 'ego_pose.json',
                   [ego_by_token[sd['ego_pose_token']] for sd in scene_sd])
        dump_table(shard_version_dir, 'calibrated_sensor.json',
                   [calib_by_token[t] for t in sorted({sd['calibrated_sensor_token'] for sd in scene_sd})])
        dump_table(shard_version_dir, 'sample_annotation.json', scene_anns)
        dump_table(shard_version_dir, 'instance.json',
                   [instance_by_token[t] for t in sorted(used_instances)])
        dump_table(shard_version_dir, 'log.json', [log_by_token[scene['log_token']]])
        for table, rows in scene_seg.items():
            dump_table(shard_version_dir, table, rows)
        for table_name, rows in shared.items():
            if rows is not None:
                dump_table(shard_version_dir, table_name, rows)

        # Copy referenced sample + segmentation files
        rel_files = [sd['filename'] for sd in scene_sd]
        rel_files += [row['filename'] for rows in scene_seg.values() for row in rows]
        missing = 0
        for rel in rel_files:
            src = src_root / rel
            dst = shard_dir / rel
            if not src.exists():
                missing += 1
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            if not dst.exists():
                shutil.copy2(src, dst)
        if missing:
            print(f'  warning: {missing} referenced files missing in source', file=sys.stderr)

        cam_front = next(
            (sd['filename'] for sd in scene_sd if '/CAM_FRONT/' in sd['filename']), None)
        has_thumb = bool(cam_front) and make_thumbnail(shard_dir, cam_front, src_root)

        entry = {
            'name': name,
            'num_samples': len(scene_samples),
            'description': scene.get('description', ''),
        }
        if has_thumb:
            entry['thumbnail'] = f'{name}/thumbnail.jpg'
        index_entries.append(entry)

    index = {
        'version': 1,
        'dataset': 'nuscenes',
        'split': args.version,
        'scenes': index_entries,
    }
    with open(out_root / 'index.json', 'w') as f:
        json.dump(index, f, indent=1)
    print(f'✓ {len(index_entries)} shards + index.json written to {out_root}')


if __name__ == '__main__':
    main()
