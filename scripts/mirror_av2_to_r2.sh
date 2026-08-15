#!/usr/bin/env bash
#
# Mirror the Argoverse 2 sensor dataset to Cloudflare R2, one tar at a time.
#
# For each official tar (≈56GB): download → extract → per-log manifest.json +
# thumbnail.jpg → rclone upload → delete local copy. Peak disk usage stays
# around 120GB regardless of how many tars a split has. Fully resumable: both
# tar downloads (curl -C -) and completed logs/tars (state files) survive
# interruption, so re-running continues where it stopped.
#
# Prerequisites:
#   - rclone configured with an R2 remote (rclone config; type = s3, provider = Cloudflare)
#   - python3 + Pillow (pip install Pillow)
#   - ~130GB free disk in WORK_DIR
#
# Usage:
#   R2_REMOTE="r2:egolens-data/av2/sensor" ./scripts/mirror_av2_to_r2.sh val
#   R2_REMOTE="r2:egolens-data/av2/sensor" ./scripts/mirror_av2_to_r2.sh train
#
# Env:
#   R2_REMOTE       (required) rclone destination, e.g. r2:bucket/av2/sensor
#   WORK_DIR        scratch directory (default: ./av2_mirror_work)
#   INCLUDE_STEREO  set to 1 to keep stereo cameras (default: excluded — the
#                   viewer only uses the 7 ring cameras; saves ~15% storage)
#   TRANSFERS       rclone parallel transfers (default: 16)

set -euo pipefail

SPLIT="${1:?Usage: mirror_av2_to_r2.sh <train|val|test>}"
case "$SPLIT" in train|val|test) ;; *) echo "Split must be train, val, or test" >&2; exit 1;; esac

R2_REMOTE="${R2_REMOTE:?Set R2_REMOTE, e.g. r2:egolens-data/av2/sensor}"
WORK_DIR="${WORK_DIR:-./av2_mirror_work}"
INCLUDE_STEREO="${INCLUDE_STEREO:-0}"
TRANSFERS="${TRANSFERS:-16}"

S3_BASE="https://s3.amazonaws.com/argoverse/datasets/av2/tars/sensor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_LOGS="$WORK_DIR/state-$SPLIT.jsonl"       # one JSON line per uploaded log
STATE_TARS="$WORK_DIR/state-$SPLIT-tars.txt"    # one line per fully processed tar
EXTRACT_DIR="$WORK_DIR/extract-$SPLIT"

mkdir -p "$WORK_DIR" "$EXTRACT_DIR"
touch "$STATE_LOGS" "$STATE_TARS"

log() { echo "[$(date +%H:%M:%S)] $*"; }

require_disk_gb() {
  local need_gb=$1
  local free_gb
  free_gb=$(df -g "$WORK_DIR" 2>/dev/null | awk 'NR==2 {print $4}') \
    || free_gb=$(df -BG "$WORK_DIR" | awk 'NR==2 {gsub("G","",$4); print $4}')
  if [ "$free_gb" -lt "$need_gb" ]; then
    echo "Error: need ${need_gb}GB free in $WORK_DIR, have ${free_gb}GB" >&2
    exit 1
  fi
}

# Discover this split's tar names from the public bucket listing
list_tars() {
  curl -sf "https://s3.amazonaws.com/argoverse/?list-type=2&prefix=datasets/av2/tars/sensor/$SPLIT-" \
    | grep -oE "<Key>[^<]+</Key>" \
    | sed -E 's|</?Key>||g; s|.*/||'
}

process_log() {
  local log_dir=$1
  local log_id
  log_id=$(basename "$log_dir")

  if grep -q "\"log_id\": \"$log_id\"" "$STATE_LOGS"; then
    log "  ↷ $log_id already mirrored, skipping"
    return
  fi

  python3 "$SCRIPT_DIR/generate_av2_manifest.py" "$log_dir" > /dev/null
  python3 "$SCRIPT_DIR/generate_av2_thumbnail.py" "$log_dir" > /dev/null

  rclone copy "$log_dir" "$R2_REMOTE/$SPLIT/$log_id" \
    --transfers "$TRANSFERS" --checkers "$TRANSFERS" --s3-no-check-bucket -q

  # Record for index.json (num_frames/duration from the manifest we just wrote)
  python3 - "$log_dir" >> "$STATE_LOGS" <<'PY'
import json, sys
from pathlib import Path
log_dir = Path(sys.argv[1])
m = json.loads((log_dir / 'manifest.json').read_text())
print(json.dumps({
    'log_id': m['log_id'],
    'num_frames': m['num_frames'],
    'duration_s': m['duration_s'],
    'thumbnail': f"{m['log_id']}/thumbnail.jpg",
}))
PY
  log "  ✓ $log_id uploaded"
}

upload_index() {
  local index_file="$WORK_DIR/index-$SPLIT.json"
  python3 "$SCRIPT_DIR/generate_av2_index.py" \
    --state "$STATE_LOGS" --split "$SPLIT" --out "$index_file"
  rclone copyto "$index_file" "$R2_REMOTE/$SPLIT/index.json" --s3-no-check-bucket -q
  log "✓ index.json uploaded ($(grep -c . "$STATE_LOGS") logs)"
}

TAR_EXCLUDES=()
if [ "$INCLUDE_STEREO" != "1" ]; then
  TAR_EXCLUDES=(--exclude '*/stereo_front_left/*' --exclude '*/stereo_front_right/*')
fi

main() {
  local tars
  tars=$(list_tars)
  [ -n "$tars" ] || { echo "Error: no tars found for split $SPLIT" >&2; exit 1; }
  log "Split $SPLIT: $(echo "$tars" | wc -l | tr -d ' ') tars"

  for tar_name in $tars; do
    if grep -qx "$tar_name" "$STATE_TARS"; then
      log "↷ $tar_name already processed, skipping"
      continue
    fi

    require_disk_gb 130
    local tar_path="$WORK_DIR/$tar_name"

    log "↓ downloading $tar_name (resumable)"
    curl -fL -C - -o "$tar_path" "$S3_BASE/$tar_name"

    log "⤳ extracting $tar_name"
    rm -rf "${EXTRACT_DIR:?}"/*
    tar -xf "$tar_path" -C "$EXTRACT_DIR" "${TAR_EXCLUDES[@]}"

    # Layout-agnostic log discovery: a log dir is whatever contains sensors/lidar
    local found=0
    while IFS= read -r lidar_dir; do
      process_log "$(dirname "$(dirname "$lidar_dir")")"
      found=$((found + 1))
    done < <(find "$EXTRACT_DIR" -type d -name lidar -path '*/sensors/lidar')
    [ "$found" -gt 0 ] || { echo "Error: no logs found in $tar_name" >&2; exit 1; }

    rm -rf "${EXTRACT_DIR:?}"/* "$tar_path"
    echo "$tar_name" >> "$STATE_TARS"
    upload_index   # refresh after every tar so partial mirrors are already browsable
    log "✓ $tar_name done ($found logs)"
  done

  log "✓ Split $SPLIT complete"
}

main
