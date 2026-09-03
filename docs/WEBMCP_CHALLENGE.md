# EgoLens × WebMCP: Teachable Lens

EgoLens is a browser-only 3D perception explorer for autonomous-driving
datasets (https://egolens.org). **Teachable Lens** is the WebMCP surface: when
you drop a dataset folder that EgoLens does not recognize, the page opens an
authoring session and registers five tools on `document.modelContext`. An
agent (ChatGPT's in-app browser, Chrome 146+ with WebMCP, or Codex through the
counted broker) inspects the files within strict byte limits, reads the
operator contract, and submits adapter *recipes* (declarative JSON, never
code). EgoLens validates and renders each revision; the human reviews the
rendering (BEV and camera thumbnails with projected LiDAR, declared-sensor
summary) and accepts or rejects per capability with a concrete issue; the
agent revises from that feedback; the finished recipe is exported and can be
shared as a hash-verified URL that renders the dataset in the production
viewer with no install.

## Prior work vs. work in the submission period

**Prior work (before 2026-08-25, 213 commits):** the viewer itself — Waymo,
nuScenes, and Argoverse 2 adapters, LiDAR/camera/box/keypoint/segmentation
rendering, timeline, POV cameras, share links, embed themes, GA4, SEO.

**Work in the submission period (2026-08-25 → 2026-09-03, 80+ commits):**

| Date | Commits | What |
|---|---|---|
| 08-29 | ea61af2, db6a3f7, f2f1ad0, d7550a3, a657d58 | Teachable Lens recipe schema, graph operators, runtime (recipes as data, hash-bound) |
| 08-30 | 076e78a (#23), 058b822 (#25) | **WebMCP authoring session**: `document.modelContext.registerTool` × 5 tools (`egolens_teachable_inspect`, `get_contract`, `apply_revision`, `get_state`, `finalize`), isolated author workspace, self-hosting loop |
| 09-01 | 193d087 (#34) | Counted evidence boundary: broker shim for `document.modelContext`, audit of every tool call |
| 09-02 | #56, #58, #59, #64, #68, #70 | Human-agent loop: confirmed sensor layout before authoring, declared-sensor summary, rendered review thumbnails (camera projections + BEV), per-capability accept/reject with issue, one-click revision request text |
| 09-02 | #61, #62, #66–#69, #73–#81 | Dataset-neutral vocabulary discovered by authoring held-out datasets (A2D2, KITTI Raw, PandaSet): JSON/text/XML/NPZ/pickle readers, derive/explode/unpivot, matrix/quaternion pose forms, world-frame conversion, apply-time diagnostics |
| 09-02 | #82 | Native WebMCP compatibility: string results for `execute(params, { signal })` |

Every commit is on `main` of https://github.com/egolens/egolens with CI.

## How the agent–human loop works

1. Human drops a folder. EgoLens keys the files, finds no bundled adapter,
   and asks the human to **confirm the sensor layout** (counts and names).
   Raw bytes never leave the browser; the agent sees only bounded inspections.
2. Agent calls `egolens_teachable_inspect` (inventory, metadata, bounded
   text/JSON/table-schema — including pandas pickles and Arrow/Parquet
   schemas), then `egolens_teachable_get_contract` (operator vocabulary with
   JSON-schema params).
3. Agent calls `egolens_teachable_apply_revision` with a complete recipe.
   EgoLens compiles, binds, samples three frames, and returns diagnostics
   that name the input and the kind received, plus self-consistency warnings
   (camera projection empty, timeline spacing irregular, ego pose jump).
4. Human reviews the rendered preview: per-sensor sample counts against the
   confirmed layout, camera thumbnails with projected LiDAR, BEV thumbnail,
   or the same recipe live in the interactive viewer.
   Accept, or reject with an issue (`mirrored`, `wrong-scale`, `out-of-sync`,
   …). `egolens_teachable_get_state` carries the review back to the agent.
5. Agent revises; human finalizes; `egolens_teachable_finalize` seals the
   artifact with recipe/format/operator-set hashes; Export JSON.
6. The finalized recipe is also saved in the browser: dropping a folder with
   the same layout later offers "Render with <recipe>" before any authoring,
   so a format taught once renders immediately next time.
7. The recipe renders in the production viewer through an inline share URL
   (`shareVersion=1`, catalog + recipe + hashes), so anyone can open the
   dataset with the same adapter and no install.

Evidence from this week (each agent turn under ten minutes):
- A2D2 preview: 3 turns → 6 cameras + 6 LiDAR fused, rendered in the viewer.
- KITTI Raw drive 0001: 7 turns → 4 cameras with per-camera rectified
  calibration, Velodyne, tracklet boxes, correct LiDAR→camera projection.
- PandaSet 001: 3 turns → 6 cameras, Pandar64+PandarGT, world-frame cuboids
  and semantic labels; the first turn exposed the world-frame gaps (#81, #85,
  #86), the third fixed the y-forward lidar axis in 80 seconds.

## Testing instructions for judges

1. Chrome 146+ (152 tested): enable `chrome://flags/#enable-webmcp-testing`
   and relaunch. ChatGPT's in-app browser needs no flag.
2. Open https://egolens.org. The five tools are registered on the top-level
   document as soon as the page loads (DevTools → Application → WebMCP).
3. Download a sample dataset (PandaSet 001, CC BY 4.0 with attribution) from
   https://github.com/egolens/egolens/releases/tag/webmcp-sample:
   `egolens-sample-pandaset-001-6frames.zip` (32 MB, quick) or
   `egolens-sample-pandaset-001-full.zip` (439 MB, all 80 frames for
   playback). Unzip and drop the folder on the page. Confirm the layout: 6 cameras (front_camera, front_left_camera,
   front_right_camera, back_camera, left_camera, right_camera), 1 lidar
   (lidar), 0 radar. The defaults are inferred from the folder; just confirm.
4. Ask the agent in plain words, for example: *"Teach EgoLens this dataset."*
   The tools describe themselves: `get_state` returns the confirmed layout and
   a `nextStep` hint, `get_contract` carries an `authoringGuide` with the
   order of steps and the frame conventions, and every diagnostic names the
   field to fix. No scripted tool sequence is needed.
5. As soon as a revision validates, the full 3D viewer loads it against your
   folder and the review panel docks beside it: orbit, POV cameras,
   LiDAR→camera overlay, boxes, colormaps, and playback all work on the real
   rendering while the agent keeps iterating (each accepted revision
   reloads the scene). Accept or reject each capability with an issue and
   let the agent revise. Finalize and Export JSON when the rendering is right.
   A scene rendered later from the saved recipe offers **✎ Edit recipe** to
   reopen authoring on the same folder.
6. Shortcut: import the finished recipe from the same release
   (`pandaset-001.egolens-adapter.json`, sealed against this six-frame sample)
   with **Import JSON** after confirming the layout to see the end state
   without authoring; `pandaset-001-review.png` and
   `pandaset-001-viewer.png` show the expected review page and viewer.

Nothing in this flow uploads dataset bytes; inspection is bounded and audited.

## Demo video storyboard (under 3 minutes)

| Time | Screen | Voice |
|---|---|---|
| 0:00–0:20 | egolens.org with Waymo scene playing | "EgoLens renders driving datasets in the browser. But every team has a dataset it does not know." |
| 0:20–0:45 | Drop the PandaSet folder → "Unknown dataset" → confirm 6 cameras / 1 lidar | "Drop an unknown folder. EgoLens asks you to confirm the sensor layout and registers five WebMCP tools on document.modelContext. No bytes leave the browser." |
| 0:45–1:30 | Agent chat: inspect → get_contract → apply_revision; DevTools WebMCP panel showing calls | "The agent inspects files within byte limits, reads the operator contract, and submits a recipe — declarative JSON, never code. EgoLens validates and renders three sample frames." |
| 1:30–2:10 | Review panel: thumbnails with projected points, BEV, declared sensors; reject one with `misaligned`; agent revises; accept all | "The human reviews the rendering and rejects with a concrete issue. get_state carries that back to the agent, which revises. Every call is audited." |
| 2:10–2:40 | Finalize → Export JSON → share URL → viewer renders PandaSet with POV camera and LiDAR→camera overlay | "Finalize seals the recipe with hashes. Anyone can open the dataset with this adapter from a link." |
| 2:40–3:00 | KITTI and A2D2 renders side by side | "Three unknown datasets this week, each in a handful of agent turns, adding only dataset-neutral vocabulary. That is Teachable Lens." |
