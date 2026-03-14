# Change to ".../validation" for the validation split
BUCKET="gs://waymo_open_dataset_v_2_0_1/training"
COMPONENTS="vehicle_pose lidar_calibration camera_calibration lidar_box camera_box camera_to_lidar_box_association lidar camera_image stats lidar_segmentation camera_segmentation lidar_hkp camera_hkp"

# ---------------------------------------------------------------------------
# Download mode: by INDEX or by COUNT
# ---------------------------------------------------------------------------
# Option A: Download specific segments by their index in the sorted list.
#   Indices are 0-based. Segments are sorted alphabetically by name in GCS.
#   Set INDICES to a space-separated list of numbers.
INDICES="23 114 172 327 552 621 703 788"

# Option B: Download the first N segments (comment out INDICES above to use).
# N=15

# ---------------------------------------------------------------------------

# Fetch sorted segment list from GCS
ALL_SEGMENTS=$(gsutil ls "$BUCKET/vehicle_pose/*.parquet" 2>/dev/null | xargs -I{} basename {} .parquet | sort)

if [ -n "$INDICES" ]; then
  # Index-based: pick specific segments by line number (0-based → awk 1-based)
  SEGMENTS=""
  for IDX in $INDICES; do
    LINE=$((IDX + 1))
    SEG=$(echo "$ALL_SEGMENTS" | awk "NR==$LINE")
    if [ -n "$SEG" ]; then
      SEGMENTS="$SEGMENTS $SEG"
    else
      echo "Warning: index $IDX out of range, skipping"
    fi
  done
else
  # Count-based: first N segments
  SEGMENTS=$(echo "$ALL_SEGMENTS" | head -${N:-15})
fi

for SEGMENT in $SEGMENTS; do
  echo "Downloading segment: $SEGMENT"
  for COMP in $COMPONENTS; do
    mkdir -p waymo_data/$COMP
    gsutil -m cp "$BUCKET/$COMP/$SEGMENT.parquet" "waymo_data/$COMP/" 2>/dev/null
  done
done
