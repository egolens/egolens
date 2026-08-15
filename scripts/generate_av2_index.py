#!/usr/bin/env python3
"""
Build a split-level index.json from the mirror state file.

The browser app discovers logs under a split URL by fetching
{split}/index.json (see src/adapters/argoverse2/remote.ts, fetchAV2Index).
S3 buckets can answer discovery with ListObjectsV2, but R2 public domains
cannot — this file is what makes a mirrored split browsable.

The mirror script (mirror_av2_to_r2.sh) appends one JSON line per uploaded
log to a state file; this script dedupes, sorts, and emits the index.

Usage:
    python scripts/generate_av2_index.py --state work/state-val.jsonl \
        --split val --out work/index-val.json

Schema (consumed by fetchAV2Index):
    {
      "version": 1,
      "dataset": "argoverse2",
      "split": "val",
      "logs": [
        {"log_id": "...", "num_frames": 157, "duration_s": 15.7,
         "thumbnail": "{log_id}/thumbnail.jpg"},
        ...
      ]
    }
"""

import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, help='JSONL state file from mirror_av2_to_r2.sh')
    parser.add_argument('--split', required=True, choices=['train', 'val', 'test'])
    parser.add_argument('--out', required=True, help='Output index.json path')
    args = parser.parse_args()

    state_path = Path(args.state)
    if not state_path.is_file():
        print(f'Error: state file {state_path} not found', file=sys.stderr)
        sys.exit(1)

    # Last entry wins on duplicate log_id (re-mirrored logs)
    logs: dict[str, dict] = {}
    for lineno, line in enumerate(state_path.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as e:
            print(f'Error: bad JSON at {state_path}:{lineno}: {e}', file=sys.stderr)
            sys.exit(1)
        if 'log_id' not in entry:
            print(f'Error: missing log_id at {state_path}:{lineno}', file=sys.stderr)
            sys.exit(1)
        logs[entry['log_id']] = entry

    index = {
        'version': 1,
        'dataset': 'argoverse2',
        'split': args.split,
        'logs': [
            {k: v for k, v in entry.items() if k in ('log_id', 'num_frames', 'duration_s', 'thumbnail')}
            for _, entry in sorted(logs.items())
        ],
    }

    out_path = Path(args.out)
    out_path.write_text(json.dumps(index, indent=1))
    print(f'✓ Wrote {out_path} — {len(logs)} logs, {out_path.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
