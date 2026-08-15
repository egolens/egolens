# nuScenes Full Hosting — Runbook

Host all 850 trainval scenes on `data.egolens.org` alongside the existing
mini. The blocker was never license or size — it was that trainval metadata
is one set of giant JSON tables (`sample_data.json` ~600MB) no browser can
parse. The answer is sharding: each scene becomes a tiny self-contained
nuScenes version dir the existing loader handles unchanged, listed by an
`index.json` the app's scene selector reads (one request).

## License

nuScenes is CC BY-NC-SA 4.0 with Motional's additional Dataset Terms
(nuscenes.org/terms-of-use, last updated 2021-11-16). The additional terms
contain **no redistribution restriction** — they cover no-endorsement,
no-trademark-use, warranty disclaimer, and termination. Requirements for us:

- Attribute neutrally: "Data: nuScenes © Motional, CC BY-NC-SA 4.0" — and
  never imply Motional sponsors or endorses EgoLens (their terms are explicit
  about this).
- Non-commercial, share-alike — same posture as the AV2 mirror.
- Downloading the source tars requires a nuscenes.org account; the download
  step is yours, not the pipeline's.

## Numbers

| | |
|---|---|
| Scenes (trainval) | 850 (~40 keyframes each) |
| Shard size | ~65MB/scene measured on mini (keyframes + lidarseg + panoptic) |
| Total upload | **~55GB → <$1/month** on R2 |
| Source download | ~300GB tars (includes sweeps, which shards drop) |
| Pipeline RAM | ~10GB (tables are loaded whole) |

## Run

1. Download and extract v1.0-trainval (metadata + keyframe blobs +
   lidarseg/panoptic if wanted) with your nuScenes account, merged into one
   root: `nuscenes/{v1.0-trainval, samples, lidarseg, panoptic}`.

2. Shard:

```bash
python3 scripts/shard_nuscenes.py /path/to/nuscenes out/ --version v1.0-trainval
```

   (`--scenes 5` limits scene count for a dry run. Pillow enables thumbnails:
   `pip install Pillow`.)

3. Upload the output directory as-is:

```bash
rclone copy out/ r2:egolens-data/nuscenes-full/ --transfers 16 --checkers 16
```

4. Verify: point the app's nuScenes URL form at
   `https://data.egolens.org/nuscenes-full/` — the selector should list 850
   scenes with thumbnails from index.json, and each scene should load its
   shard on selection. (Locally testable the same way: serve `out/` with any
   CORS-enabled static server.)

## Cut over the preset

Once verified, update the nuScenes preset in `src/utils/presets.ts`:

```ts
url: 'https://data.egolens.org/nuscenes-full/',
note: 'Hosted by EgoLens · 850 scenes · CC BY-NC-SA 4.0',
```

Keep the old mini URL recognized (add it to the preset's `splits`-style list
or leave the mini directory in place) so existing bookmarks and shared links
keep working and keep classifying as preset visits. Add the attribution line
wherever the preset is shown.

## How it fits the loader

- `index.json` present at the URL → sharded mode: scene list + thumbnails
  from the index, shard fetched on scene select
  (`src/adapters/nuscenes/remote.ts`, `fetchNuScenesVersionData` in the store).
- No `index.json` → classic single version dir (v1.0-mini style), unchanged.
- Shards cut `sample_data` prev/next links (they'd dangle into dropped
  sweeps); the viewer never follows them.
