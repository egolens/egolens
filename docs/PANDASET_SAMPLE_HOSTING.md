# PandaSet sequence 001 sample hosting

Status: **sample connected and verified; application changes remain local**.
The existing 744 hosted source files were verified against the approved ZIP.
Only the missing README and the new catalog were uploaded. No existing objects
were overwritten, and no bucket configuration was changed.

## Prepared sample and application pin

The approved source is the [full 80-frame release ZIP](https://github.com/egolens/egolens/releases/download/webmcp-sample/egolens-sample-pandaset-001-full.zip).
The release page title still mentions six frames; select the asset ending in
`001-full.zip`, not the smaller excerpt.

```ts
rootUrl: 'https://data.egolens.org/pandaset/001/',
catalogUrl: 'https://data.egolens.org/pandaset/001/source-catalog.json',
catalogHash: 'sha256:1739c7780cdac2c667c5cfab80aee1784595f2a6edd742eb23b720338c4d40df',
```

This is the canonical catalog payload hash consumed by `SourceCatalogV1`, not
the SHA-256 of the formatted JSON file. The pin is ready for the separately
owned `src/utils/teachingSample.ts`; these URLs are now publicly available and have been exercised from the
local application in the Codex in-app browser.

Local staging parent:

```text
/Users/heejaekim/Workspace/egolens-hosted-samples/pandaset-001-full-20260911/
  original/egolens-sample-pandaset-001-full.zip
  extracted/egolens-sample-pandaset-001-full/  # untouched extraction
  publish/                                  # the eventual upload root
    LICENSE.txt
    README.txt
    annotations/...
    camera/...
    lidar/...
    meta/...
    source-catalog.json                     # the only added public file
  archive-entries.txt
  staging-summary.json
  review.json
```

Only `publish/` is intended for hosting. Keep the archive, extraction, and review
artifacts local. Do not add recipes, mapping hints, derived manifests, thumbnails,
or this runbook to the hosted data tree.

## Verified contents

| Item | Result |
| --- | --- |
| Original ZIP size | 439,238,634 bytes |
| Original ZIP SHA-256 | `e77e255357cdf6e2ffdd844df5c152094d927c1d0cf035c19946be45a2e71532` |
| ZIP entries | 745 files and 13 directories |
| Original file bytes | 874,548,830 bytes |
| Catalog size | 305,449 bytes |
| Publish tree | 746 files; 874,854,279 bytes (about 834.33 MiB) |
| Catalog schema | `egolens-source-catalog-v1` |
| Catalog entries | 745; hard maximum 50,000 |
| Chunk size | 1,048,576 bytes (1 MiB), with a shorter final chunk as needed |
| Verified chunks | 1,396 |
| Source manifest hash | `sha256:53d99ef0b6121db382bc8fbc92382cce5af2d65912e12a37d14417c7c7ce7dce` |

The ZIP digest and size match the public GitHub release asset metadata. Each of
the 745 staged files was also compared with its independently streamed ZIP entry
using its full size and SHA-256. The staging script separately re-read every
copied file and checked both full-file and chunk hashes. The archive file list
equals the catalog path list after removing the single wrapper directory.

| Original file group | Frame files | Other original files |
| --- | --- | --- |
| LiDAR | 80 | 2 JSON files |
| Six cameras | 480 (80 per camera) | 18 JSON files |
| Cuboids | 80 | 0 |
| Segmentation | 80 | 1 JSON file |
| Meta | 0 | 2 JSON files |
| Attribution and release description | 0 | `LICENSE.txt`, `README.txt` |

Every frame group contains exactly `00`–`79`, with no gaps or extra frame IDs.
All 16 original timestamp, pose, and GPS arrays contain 80 entries. These are
preparation checks only: no pickle payload was executed and no adapter recipe
or interpretation of data fields was generated.

The archive wrapper is `egolens-sample-pandaset-001-full/`. Its contents become
the hosting root, consistent with browser folder selection stripping a common
wrapper. Thus catalog paths include `lidar/00.pkl` and
`camera/front_camera/00.jpg`, not the ZIP wrapper or another `001/` prefix.
All inner paths, file extensions, and file bytes are preserved. The generated
catalog contains only `path`, `size`, `sha256`, and `chunks` per entry.

## Attribution

Use: **PandaSet — Hesai and Scale AI — CC BY 4.0; additional Dataset Terms
included in LICENSE.txt.** Link the [release attribution](https://github.com/egolens/egolens/releases/tag/webmcp-sample)
and [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The original
`LICENSE.txt` identifies Scale AI, Inc. and Hesai Photonics Technology Co., Ltd
and includes the Dataset Terms. Preserve both attribution files exactly:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `LICENSE.txt` | 5,507 | `b198d2cb6ce184a0cc586ffd4513dd7e9060b0e10686b94768c845f8b94cdcf7` |
| `README.txt` | 488 | `9652e624b18447967d81622e681871b38bb401430f04441f0dd4eda01b7c3562` |

The public data files are unchanged from the approved release; the added
transport catalog is the only packaging addition.

## Repeat preparation

Requirements: Node.js 22 or newer, this repository's installed dependencies,
`curl`, `unzip`, and about 2.2 GB of free space for the ZIP, extraction, and
publish copy. `rclone` is needed for destination checks and publication.

Start in the repository. Choose a **new directory outside the repository**:

```bash
SAMPLE_STAGE='/absolute/path/outside/repository/new-pandaset-staging'
mkdir -p "$SAMPLE_STAGE/original" "$SAMPLE_STAGE/extracted"
curl --fail --location --silent --show-error \
  --output "$SAMPLE_STAGE/original/egolens-sample-pandaset-001-full.zip.part" \
  'https://github.com/egolens/egolens/releases/download/webmcp-sample/egolens-sample-pandaset-001-full.zip'

node --input-type=module - "$SAMPLE_STAGE/original/egolens-sample-pandaset-001-full.zip.part" <<'JS'
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
const filename = process.argv[2];
const hash = createHash('sha256');
for await (const bytes of createReadStream(filename)) hash.update(bytes);
if ((await stat(filename)).size !== 439238634 || hash.digest('hex') !==
    'e77e255357cdf6e2ffdd844df5c152094d927c1d0cf035c19946be45a2e71532') {
  throw new Error('Approved release ZIP size or digest mismatch; do not extract');
}
await rename(filename, filename.slice(0, -5));
JS
```

Proceed only after the digest check succeeds. For this pinned, verified archive:

```bash
unzip -q "$SAMPLE_STAGE/original/egolens-sample-pandaset-001-full.zip" \
  -d "$SAMPLE_STAGE/extracted"

node scripts/prepare-hosted-sample.mjs \
  --root "$SAMPLE_STAGE/extracted/egolens-sample-pandaset-001-full" \
  --output "$SAMPLE_STAGE/publish" \
  > "$SAMPLE_STAGE/staging-summary.json"

node scripts/prepare-hosted-sample.mjs --verify "$SAMPLE_STAGE/publish"
node --test scripts/prepare-hosted-sample.node.mjs
```

The generic script does no download, extraction, upload, data parsing, or remote
configuration. It copies every regular source file, including original hidden
files and attribution; rejects symlinks and special files; refuses overlapping,
repository-local, or existing output directories; and refuses an original
`source-catalog.json` collision. It detects source drift and removes only its
own incomplete output directory on failure. A successful run includes a full
readback verification. A hard interruption can leave a partial directory; use
a fresh output path rather than merging into it.

Catalog paths are sorted by code unit, hashes use the existing canonical JSON
helper, and the script enforces the schema's 50,000-entry and 16 MiB limits.
`--verify` checks the complete staged file set and every full-file/chunk digest.
The Node test also validates a generated catalog with the application's actual
`validateSourceCatalogV1` consumer and checks browser wrapper stripping,
determinism, chunk boundaries, corruption, limits, and refusal behavior.

## Publication and live verification

The destination is `r2:egolens-data/pandaset/001/`, served at
`https://data.egolens.org/pandaset/001/`. The prefix already contained 744 source
files plus `catalog.json`. Its source entries matched the staged catalog in
path, size, SHA-256, and chunk hashes. Independently, every hosted source file's
S3 MD5 and size matched the corresponding local file (744 matches, no drift).
The only missing archive file was `README.txt`.

The following additive uploads completed, using immutable destination behavior:

```bash
rclone copyto "$SAMPLE_STAGE/publish/README.txt" \
  r2:egolens-data/pandaset/001/README.txt --immutable --s3-no-check-bucket
rclone copyto "$SAMPLE_STAGE/publish/source-catalog.json" \
  r2:egolens-data/pandaset/001/source-catalog.json --immutable --s3-no-check-bucket
```

The existing `catalog.json` remains unchanged. The new preset explicitly pins
`source-catalog.json`; it does not enumerate every object in the bucket.
`--s3-no-check-bucket` is needed because the existing object credentials cannot
create or administer buckets. The bucket already exists and was listed before
uploading. No credentials were printed or changed.

### Browser transport profile

The public host supports CORS GET from both the application and local preview.
A 1 MiB LiDAR Range request returned HTTP 206 with the correct length, range,
and chunk digest. However, the response does not expose `Content-Range` to
browser JavaScript. The preset therefore sets `preferFullObjects: true`:
inspection or playback fetches each requested file in full, verifies its
catalog SHA-256, and only then returns the requested bytes to its reader.
The catalog still contains verified chunks for other compatible consumers.
No Range validation was weakened and no CORS settings were changed.

The raw source tree is 874,548,830 bytes, larger than the 439 MB ZIP. The preset
uses a bounded 4 GiB cumulative session transfer budget to allow repeated
inspection/review; the default 64 MiB per-object and 64 MiB source cache limits
remain unchanged. Initialization fetches only the 305,449-byte catalog.

Browser checks confirmed immediate authoring entry with 745 authorized files,
six inferred camera streams and one combined LiDAR stream; a 16-byte inspection
of the real LiDAR file passed full-file validation, and the existing pickle
reader decoded its 169,171 rows and six columns. Original camera timestamps
also loaded successfully. The extracted full ZIP was recognized through local
folder selection as the same 745-file source. No completed PandaSet adapter,
human approval, or finalization was manufactured during these checks.

Desktop and 375 px layouts were inspected in a temporary QA tab. The QA tab
was closed and a fresh landing preview was left for the user. Validation: 1,160 Vitest tests across 104 files;
seven staging-script tests; production build; lint with zero errors and the
64 existing warnings. Application deployment is still a separate phase.

## Sequence 002 (September 11, 2026)

The sample selector now offers 001 and 002. Selection changes the preset root URL
and ZIP link; pressing the preset still only fills the form. Existing sealed
recipes are matched when the user presses Load.

002 source: `/Users/heejaekim/Workspace/_datasets/autonomy/pandaset/002`.
Staging: `/Users/heejaekim/Workspace/egolens-hosted-samples/pandaset-002-full-20260911`.
The full log contains 80 frames and 745 files (836,340,552 bytes). The staging
script verified all copied bytes. The 744 pre-existing remote source objects
matched local paths and sizes; this was not a remote full-content checksum audit.
Only README.txt and source-catalog.json were added to the existing remote prefix.

Root: https://data.egolens.org/pandaset/002/
Catalog hash: `sha256:953cfbf7d3a88fd202234b1553da6ff82576dbb238230b746279e3fb7c148406`.
ZIP: `egolens-sample-pandaset-002-full.zip`, 415,772,433 bytes, in the existing
`webmcp-sample` GitHub release. The archive preserves the full local source tree,
including LICENSE.txt and README.txt. No recipe was added to the sample.

This verifies sample availability and selector routing, not that an arbitrary
001-trained recipe renders 002 correctly. That remains the user's cross-log test.
