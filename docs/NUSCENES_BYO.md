# Bringing your own data through the nuScenes layout

EgoLens reads three dataset formats. If you have your own vehicle recordings
and want to look at them, the nuScenes directory layout is the one people
reach for, so this page states exactly what EgoLens requires of it and what it
does when you get something wrong.

**Read this first, though: nuScenes is probably not the layout you want.**
See [Which layout should I target?](#which-layout-should-i-target) below.

## Which layout should I target?

| | Argoverse 2 | nuScenes | Waymo Open v2 |
|---|---|---|---|
| Frame identity | the filename is the timestamp | a UUID token graph across six tables | parquet rows |
| Cross-file linking | none needed | `prev`/`next` linked lists + four token references per row | — |
| LiDAR geometry | cartesian x/y/z | cartesian, in `.pcd.bin` | **spherical range images** |
| Files per log | one per sweep | monolithic tables | parquet set |
| Container | feather (Arrow IPC) | JSON + binary | parquet |

**Prefer Argoverse 2.** It has no token graph, which removes the single most
expensive and most error-prone part of writing a converter — and the one class
of mistake (a reference pointing at nothing) that nothing can catch for you at
write time. Its per-sweep files also sidestep the metadata size problem
described below. `pyarrow.feather.write_feather` is one line.

**Do not target Waymo v2.** Its LiDAR is stored as range images, so you would
have to project your cartesian points back into spherical range images with
matching beam inclinations. It is a poor conversion target and we do not
recommend attempting it.

**nuScenes is documented here because people are already on it**, not because
we recommend it. If you have a working conversion, none of this is a reason to
redo it.

### A caution about "nuScenes format"

The layout is copied more often than it is conformed to, and the copies differ
in ways that will not announce themselves:

- **[TIER IV T4](https://github.com/tier4/tier4_perception_dataset/blob/main/docs/t4_format_3d_detailed.md)**
  states: *"While all extrinsic parameters are given with respect to the ego
  vehicle body frame in the original nuScenes dataset, they are given with
  respect to the world coordinate in this format."* Loading T4 data through a
  reader that assumes the nuScenes convention renders **without error and with
  wrong geometry**. Ships `log`/`map` as dummy files.
- **[MAN TruckScenes](https://github.com/TUMFTM/truckscenes-devkit)** drops the
  `log` and `map` tables and adds `ego_motion_*`.

EgoLens implements the original nuScenes conventions. If your data follows a
dialect, convert to the conventions below rather than assuming compatibility.

## The layout EgoLens reads

```
<root>/
├── v1.0-mini/            # the directory name matters — see below
│   ├── scene.json  sample.json  sample_data.json  ego_pose.json
│   ├── calibrated_sensor.json  sensor.json
│   └── sample_annotation.json  instance.json  category.json  log.json
├── samples/
│   ├── LIDAR_TOP/<file>.pcd.bin
│   └── CAM_FRONT/<file>.jpg          # one directory per channel
├── lidarseg/<split>/<sample_data_token>_lidarseg.bin    # optional
└── panoptic/<split>/<sample_data_token>_panoptic.npz    # optional
```

**For the local drag-and-drop path the version directory must be named
`v1.0-mini`.** Folder detection requires both `samples/` and a directory with
that exact name; `v1.0-trainval` alone is not recognised. Serving over HTTP is
more forgiving — the split is probed in the order `v1.0-mini`,
`v1.0-trainval`, `v1.0-test`.

Sensor file paths come from `sample_data.filename` and are resolved relative to
the root, so they must stay relative and must start with `samples/`.

## Required and optional tables

**Required — the load fails, by name, without these:**

| Table | Drives |
|---|---|
| `scene.json` | the list of scenes |
| `sample.json` | the frame sequence |
| `sample_data.json` | which file belongs to which frame and sensor |
| `ego_pose.json` | vehicle position — without it every frame renders at the origin |
| `calibrated_sensor.json` | sensor extrinsics and camera intrinsics |
| `sensor.json` | sensor channel names |

**Optional — absent is a normal state, and the console says what is switched off:**

| Table | Gates |
|---|---|
| `sample_annotation.json` | 3D boxes |
| `instance.json` | 3D box tracking |
| `category.json` | 3D box class colours |
| `log.json` | location and time-of-day labels |
| `lidarseg.json` | LiDAR segmentation colouring |
| `panoptic.json` | panoptic colouring |

Only presence and parseability are checked, never row count. A table that is
present and empty is fine — `v1.0-test` legitimately ships an empty
`sample_annotation.json`, and raw recordings have no labels at all.

`attribute.json` and `visibility.json` are fetched in URL mode but never
parsed; `map.json` is not touched at all. None of the three affect rendering,
so you do not need to produce them.

## Sensor channels are a fixed vocabulary

`sensor.channel` must be one of exactly these twelve strings:

```
LIDAR_TOP
CAM_FRONT  CAM_FRONT_LEFT  CAM_FRONT_RIGHT  CAM_BACK  CAM_BACK_LEFT  CAM_BACK_RIGHT
RADAR_FRONT  RADAR_FRONT_LEFT  RADAR_FRONT_RIGHT  RADAR_BACK_LEFT  RADAR_BACK_RIGHT
```

Anything else is not displayed. If none of your channels match, the load fails
and names both what you sent and what is accepted; if some match, the rest are
dropped with a console warning naming them.

**This is a capacity limit, not just a naming convention.** There is **one**
LiDAR slot, **six** camera slots and **five** radar slots. A vehicle with two
LiDARs or seven cameras cannot express its full sensor set through this layout
— renaming will not help. Argoverse 2 has seven camera slots and the same
single LiDAR slot.

## Conventions that must be right

These are the ones nothing can check for you: the values are the right type and
the right count either way, so a mistake renders without an error.

| Field | Convention |
|---|---|
| `rotation` | quaternion, **scalar-first `[w, x, y, z]`** |
| `translation` | `[x, y, z]` metres |
| `size` | **`[width, length, height]`** — not `[l, w, h]` |
| `ego_pose` | global/map frame |
| `calibrated_sensor` | relative to the **ego vehicle body** frame |
| `sample.timestamp` | microseconds |
| `.pcd.bin` | flat float32, **5 per point**: `[x, y, z, intensity, ring]`, sensor frame |

## Size limits

nuScenes' metadata is monolithic: a full `trainval` `sample_data.json` is
around 600 MB, past what a browser can hold as a single string. EgoLens rejects
any single JSON table over 400 MB with instructions rather than crashing.

If your conversion produces tables that large, shard per scene — one
self-contained version directory per scene plus an `index.json` listing them.
`scripts/shard_nuscenes.py` does this for official nuScenes and shows the
output shape. This is another reason to prefer Argoverse 2, whose per-sweep
files never accumulate into one file.

## What EgoLens tells you when it goes wrong

| Mistake | What you see |
|---|---|
| Required table missing or unreadable | Load fails naming **every** affected table at once, and what each drives |
| A host serving `index.html` for a missing file | Load fails quoting the opening bytes |
| A table that is valid JSON but not an array | Load fails saying so |
| No channel recognised | Load fails listing yours and the accepted twelve |
| Some channels unrecognised | Loads; console warning names them |
| Optional table absent | Loads; console lists what is switched off |
| `prev`/`next` cycle | Loads what it walked; console warns rather than hanging |
| Wrong quaternion order, axis order, or frame | **Nothing.** Renders wrongly — see Conventions above |

That last row is the honest limit of what a reader can do for you.
