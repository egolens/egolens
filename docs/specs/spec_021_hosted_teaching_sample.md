# Hosted teaching sample and local ZIP alternative

**Status**: in-progress · **Date**: 2026-09-11

## Approved experience

Add a third landing preset, **Teach PandaSet**, alongside the existing nuScenes
and Argoverse presets. Use the complete PandaSet sequence 001 (80 frames), not
the six-frame excerpt. Preserve the existing preset actions, supported-format
chips, URL inputs, folder picker, and drag-and-drop behavior.

The main button opens the hosted source directly in the existing entry stage.
Before entering, look up sealed recipes saved in this browser using the existing
format fingerprint. If a match exists, show **You taught EgoLens this format**
and **Render now**. Otherwise, show the existing AI authoring introduction.
This lookup uses catalog metadata only and must not fetch dataset file bodies.
Keep explicit **Create an adapter with AI** actions as fresh authoring requests.
Cancellation also applies while looking up saved recipes. A failed lookup must
be retryable instead of silently presenting the source as an unknown format.

The secondary **Download ZIP (439 MB)** link points to the existing full
release archive. Its hint says to unzip it and drop the extracted folder below.
Both routes use the same original files. No extra source-choice modal is added.

AI authoring needs an available browser agent API. Explain the Codex desktop
in-app browser requirement beside the sample. In a browser without that API,
clicking the main button highlights the instruction without fetching data;
the download link remains usable. API availability does not imply an agent
has started working: the existing authoring prompt remains the next step.

## Source and runtime

- Publish the existing full sequence archive's original contents beneath a new
  `pandaset/001/` prefix on the existing EgoLens data host.
- Add a content catalog listing normalized logical paths, sizes, and hashes,
  with verified transport chunks. Preserve original attribution files.
- Extend source inventory to use the existing verified remote byte source.
  Initialization fetches only the bounded catalog; source files are fetched
  when inspection or playback requests them.
- Reuse the authoring session, readers, recipe compiler, binding, and human
  review. Supply no PandaSet adapter or semantic mapping with the preset.
- Abort pending entry on cancellation, another loading path, or unmount.
  Once handed off, the authoring session owns the source until revoked.
- Remote copy and the copied teaching prompt must accurately describe a
  public hosted source, without claiming it is the visitor's local data.
- Keep transport limits, catalog validation, and hash checks intact. Per-frame
  compressed files may be downloaded in full when their decoder needs them.

## Verification and delivery

Test catalog-only entry, actual remote inspection and generic recipe binding,
revocation, corrupt or failed responses, retry, no-agent behavior, cancellation,
and the unchanged local selection route. Verify public object counts, CORS and
Range responses after uploading. Inspect the landing page at desktop and
narrow widths in an isolated preview tab. Run the relevant suite, build and
lint. App deployment remains a separate phase; the sample hosting is part of
this approved implementation.
