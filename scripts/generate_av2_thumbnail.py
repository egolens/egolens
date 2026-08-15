#!/usr/bin/env python3
"""
Generate thumbnail.jpg for an Argoverse 2 log directory.

Takes the first ring_front_center JPEG, resizes it to 480px width, and writes
{log_dir}/thumbnail.jpg. The scene selector loads one thumbnail per visible
log, so serving the full ~500KB camera frame per log would be wasteful; the
resized thumbnail is ~30KB.

Requires Pillow:  pip install Pillow

Usage:
    python scripts/generate_av2_thumbnail.py /path/to/av2/sensor/val/{log_id}
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print('Error: Pillow is required. Install with: pip install Pillow', file=sys.stderr)
    sys.exit(1)

THUMB_WIDTH = 480
JPEG_QUALITY = 80


def main():
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} /path/to/av2/log_dir', file=sys.stderr)
        sys.exit(1)

    log_dir = Path(sys.argv[1]).resolve()
    cam_dir = log_dir / 'sensors' / 'cameras' / 'ring_front_center'
    if not cam_dir.is_dir():
        print(f'Error: {cam_dir} not found', file=sys.stderr)
        sys.exit(1)

    jpgs = sorted(cam_dir.glob('*.jpg'))
    if not jpgs:
        print(f'Error: no .jpg files in {cam_dir}', file=sys.stderr)
        sys.exit(1)

    out_path = log_dir / 'thumbnail.jpg'
    with Image.open(jpgs[0]) as img:
        ratio = THUMB_WIDTH / img.width
        thumb = img.resize((THUMB_WIDTH, round(img.height * ratio)), Image.LANCZOS)
        thumb.save(out_path, 'JPEG', quality=JPEG_QUALITY)

    print(f'✓ Wrote {out_path} ({out_path.stat().st_size / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
