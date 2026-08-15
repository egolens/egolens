# Argoverse 2 Full Mirror on R2 — Runbook

Mirror the full AV2 sensor dataset (train + val, 850 logs) to Cloudflare R2 so
EgoLens serves every log from `data.egolens.org` instead of pointing the preset
at Argoverse's S3 bucket.

## Why mirror at all

The official bucket (`argoverse.s3.us-east-1.amazonaws.com`) is public, CORS-enabled,
and listable — the current preset uses it directly. Mirroring buys:

- **Fast discovery**: one `index.json` request instead of paginated ListObjectsV2
  (700 logs in train), and a pre-resized `thumbnail.jpg` per log instead of a
  listing request + full-size camera frame per selector card.
- **Fast first frame**: every log carries `manifest.json`, so the app never falls
  back to S3 listing for frame discovery.
- **CDN locality**: Cloudflare edge vs. us-east-1 only.
- **Independence** from the official bucket's availability and policy.

## Numbers (measured 2026-08 from the official tars)

| Split | Logs | Tars | Size |
|---|---|---|---|
| train | 700 | 14 | ~790GB |
| val | 150 | 3 | ~167GB |
| test (excluded — no annotations) | 150 | 3 | ~168GB |

Stereo cameras are excluded by default (viewer uses the 7 ring cameras only),
bringing train+val to roughly **800GB → ~$12–15/month** at R2's $0.015/GB.
Egress is free. One-time upload ops (~2M objects Class A at $4.50/M): ~$10.

## License

AV2 is **CC BY-NC-SA 4.0**: redistribution is permitted with attribution, for
non-commercial use, share-alike. EgoLens is free OSS, so hosting a mirror is
within the license — but the site must attribute: add a visible
"Data: Argoverse 2 © Argo AI, CC BY-NC-SA 4.0" note wherever the preset is
offered, and do not put the mirror behind anything paid.

## Prerequisites

- A machine with ≥130GB free disk and good bandwidth (~1TB total download;
  a cloud VM in us-east-1 makes the download leg fast and free).
- `rclone` configured with an R2 remote:
  ```
  rclone config        # type: s3, provider: Cloudflare, endpoint from R2 dashboard
  ```
- `python3` with Pillow (`pip install Pillow`).
- R2 bucket CORS must allow GET from `https://egolens.org` (the nuScenes mini
  config already does this if it's bucket-wide — verify it covers `av2/`).

## Run

```bash
R2_REMOTE="r2:egolens-data/av2/sensor" ./scripts/mirror_av2_to_r2.sh val
R2_REMOTE="r2:egolens-data/av2/sensor" ./scripts/mirror_av2_to_r2.sh train
```

Interrupt/resume is safe at any point: tar downloads resume (`curl -C -`),
finished logs and tars are recorded in `WORK_DIR/state-*.{jsonl,txt}` and
skipped on re-run. `index.json` is refreshed after every tar, so a partial
mirror is already browsable — val first gives a usable preset within hours.

Per-log output on R2:

```
av2/sensor/{split}/index.json                 ← split-level log index (+ thumbnails)
av2/sensor/{split}/{log_id}/manifest.json     ← frame discovery (no listing needed)
av2/sensor/{split}/{log_id}/thumbnail.jpg     ← 480px selector thumbnail
av2/sensor/{split}/{log_id}/calibration/…     ← original data, minus stereo cameras
av2/sensor/{split}/{log_id}/sensors/…
```

## Verify

```bash
curl -s https://data.egolens.org/av2/sensor/val/index.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['split'], len(d['logs']), 'logs')"
```

Then load `https://data.egolens.org/av2/sensor/val/` through the app's URL
loader — the selector should populate from index.json (one request) and each
log should report "Using manifest.json for frame discovery" in the console.

## Cut over the preset

Once both splits verify, point the preset at the mirror in
`src/utils/presets.ts` (and consider a second entry for train):

```ts
url: 'https://data.egolens.org/av2/sensor/val/',
note: 'Hosted by EgoLens · 150 logs · CC BY-NC-SA 4.0',
```

`isPresetUrl` is an exact match, so the analytics preset/user distinction
keeps working after the URL change. The old S3 URL keeps working for anyone
who bookmarked it — the S3 listing path remains as fallback.
