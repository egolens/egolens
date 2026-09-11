# Teachable Lens browser loop validation

Date: 2026-09-11

## Scope

Manual UI regression in the Codex in-app browser against the local working tree
on port 5182. This separate origin started without saved recipes and did not
replace the user's port-5181 recipe storage. Remote PandaSet logs 001 and 002
each contain 745 catalog entries and 80 frames.

The initial teaching draft reused a previously validated mapping, submitted
through WebMCP `apply_revision`; it was not imported as a saved recipe. This
validates the authoring, review, persistence, and reuse lifecycle. It does not
measure an agent's ability to infer an unfamiliar format from scratch. Review
and seal actions were performed through the UI as delegated by the user.

## Results

1. **Fresh 001 lifecycle: passed.** The sample populated the source form;
   Load found no saved recipe; Create an adapter with AI opened teaching.
   Source inventory and representative tables were inspected through WebMCP.
   A draft rendered three validation frames. Seven review capabilities were
   accepted through the UI, and Finalize produced a sealed, export-ready recipe.
   Render this dataset opened the viewer with six camera images.
2. **002 reuse and revision lifecycle: passed with a selection UX issue.**
   Load recognized the 001 seal. Render now opened 002. Edit recipe resumed
   review from that recipe. Projection was rejected with a note, a changed
   mapping was submitted with the original hash as its provenance parent,
   all seven capabilities were reviewed again, and the new revision was sealed.
   After reload, the new hash was still offered and rendered successfully.

Both logs reached frame 80/80 with a full buffer bar. Sampled LiDAR point counts:

| Log | Frame 0 | Frame 39 | Frame 79 |
| --- | ---: | ---: | ---: |
| 001 | 169,171 | 171,514 | 167,388 |
| 002 | 166,768 | 166,448 | 172,020 |

Camera images, 3D boxes, LiDAR projection, and segmentation were visually
inspected. This is a visual smoke test, not a numerical calibration accuracy
measurement or a controlled loading-performance benchmark. No browser console
errors were reported at the inspected rendering checkpoints.

## Findings

- **Fixed in application:** recipes with class colors but no explicit semantic
  palette fell back to unrelated dataset colors/labels. The compatibility
  bridge now constructs a palette and indexes labels by renderer ID, preserving
  explicit palettes. The legend no longer suppresses class 31 for all datasets;
  it remains visible for PandaSet's Pedestrian with Object class.
- **Fixed in the test recipe:** camera calibration contained log 001's initial
  LiDAR quaternion as a constant. The revision joins the current log's initial
  LiDAR pose into camera calibration and derives the inverse transform from
  those fields. This addresses a portability defect even when one log looks
  acceptable. This test recipe change does not migrate users' saved recipes.
- **Found during validation (subsequently fixed):** matching recipes showed both the original and its newer
  revision with the same name and separate Render now buttons. The abbreviated
  hash was their main distinguishing label. The recognition screen now shows
  only the matching recipe with the latest finalizedAt timestamp. Earlier
  recipes remain stored.
- Invalid revision attempts (unknown property, missing parent, and a reversed
  join-field mapping) were rejected with diagnostics; the prior valid review
  remained available. The corrected revision then succeeded.

Original recipe hash:
`sha256:5ccdc724d530966449676e11c2bf2b522e5394e980a1d50acc6db4b93c16e4a7`

Revised recipe hash:
`sha256:5a763a42ded3eb9a12857fb8cd5833b43af272ba40129cb4214353a8debe3518`

The revised draft is retained outside the application source at
`/Users/heejaekim/Workspace/egolens-hosted-samples/loop-validation-20260911/revised-draft.json`.

## Automated checks

- Vitest: 107 test files, 1,181 tests passed, including two new semantic
  taxonomy regression cases.
- Production type-check and build: passed; bundle-size warning remains.
- ESLint: zero errors, 64 warnings across the working tree.

No production deployment or commit was performed for this validation.
