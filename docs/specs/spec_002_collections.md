# Spec 002 — Collections (index.json curation metadata)

**Status**: planned · **Date**: 2026-08-15 · **Revised**: 2026-08-15 after
adversarial review (27 confirmed findings, 4 blocking) · **Estimated
effort**: ~1 week
**Relationship to spec_001**: replaces its item 4 (Collections). spec_001's
Status line records the hand-off; its items 1–3 and 5 stand.

## Why

`index.json` exists so a hosted mirror can say *which* logs it holds. Two
independent teams then built, on their own, the thing it can't say: *which
ones are worth opening, and why*.

- A downstream fork of this viewer carries a hand-authored scenario index —
  169 scenes tagged by safety type and city, with a quality score — and that
  index is the reason the fork exists. Its list, filters and review flow are
  app code we don't have, wrapped around a viewer we do.
- A scenario-mining team (CVPR AV2 challenge) drives the viewer from their
  own results browser: natural-language query, matching log, matching time
  interval, score. They open one URL per result, hundreds of times a day, and
  extended our embed URL with their own interval parameters to do it (adopted
  in spec_001 as `t0`/`t1`).

Both are the same shape: **an ordered, annotated list of (scene, interval)
pairs**. Neither could express it in a file, so both expressed it in code.
This spec makes the file able to say it.

The deliberate consequence: an `index.json` stops being "a directory listing
for our mirror" and becomes **a standalone curation file** — a fork-free way
to publish "these 169 scenarios are worth labelling" or "here are 50 mining
hits, worst score first", pointing at data hosted anywhere.

## Scope

**In**: schema, discovery plumbing, per-entry range application, selector
filter/sort generalisation, generator support, docs.

**Out — deliberately** (see Non-goals): card galleries, thumbnail grids,
batch selection, in-app collection editing. Those belong to host apps; the
fork built them, and building our own before we know how people curate is
exactly the speculative work to avoid. Prediction/ground-truth comparison is
roadmap Phase 4 and orthogonal.

## Schema

Both index schemas gain the same optional fields. Every field is optional; an
existing `index.json` keeps working untouched. Note the id key and the
existing count field differ per dataset — that asymmetry already ships.

```jsonc
// AV2 — entries in `logs[]`
{
  "log_id": "02678d04-…",
  "num_frames": 157,                          // existing
  "thumbnail": "02678d04-…/thumbnail.jpg",    // existing

  "tags": ["near-miss", "pittsburgh"],
  "score": 0.41,
  "description": "pedestrian crossing in front of a turning vehicle",
  "url": "https://host/api/…/av2/prediction/",
  "t0": "315969909862964000",
  "t1": "315969916359611000"
}

// nuScenes — entries in `scenes[]`: `name` instead of `log_id`,
// `num_samples` instead of `num_frames`; `description` already exists.
```

| Field | Meaning | Rules |
|---|---|---|
| `tags` | Free-form grouping labels | Cap 8 per entry; extras dropped with a console warning. Tags group, they do not identify |
| `score` | Ordering hint | Any finite number, may be negative. Entries without a score sort last, keeping collection order among themselves |
| `description` | One-line human context | Searchable; second row line on desktop |
| `url` | Absolute URL for this entry's data | **`https://` only**, matching the app's existing data-URL policy (`http://localhost` and `http://127.0.0.1` also allowed, as today). Anything else: entry keeps its derived URL, console warning |
| `t0` / `t1` | Playback range for this entry | int64 timestamps **as strings**; resolved by `resolveWindowToFrames`. Both required or both ignored |

### URL resolution

- **Entry base** = `url` when present and valid, else `{indexRoot}{id}/`.
- **`thumbnail`** resolves against the *entry base*, not the index root, and
  may itself be absolute. (Without this rule a cross-host collection shows
  broken thumbnails — the headline feature half-broken.)
- Entry base is normalised to a trailing slash. A relative `url` is resolved
  against the index root via the URL constructor, so `../shared/log-a/` works.

### Range precedence

1. **Page-level `t0`/`t1` wins on arrival** for the initially selected scene.
2. **If the page-level range fails to resolve** (wrong scene, malformed), the
   entry's range applies — a failed page range must not suppress a valid
   entry range, which would leave the user with no range at all.
3. **`?frame=` and a range together**: the range wins and seeks to its start
   (spec_001 already gives `t0` precedence over `frame`); this must be
   resolved in one place at load, not left to effect ordering.
4. **Scene switch** applies the newly selected entry's range, or clears it
   when that entry has none.
5. **A host `setWindow` always wins** over an entry range and is not
   overwritten by a later scene switch within the same host session; the
   viewer emits `rangeChange` (below) whenever the range changes for any
   reason, so a host is never silently overridden.
6. Applying any range goes through `setPlaybackWindow`, so the URL reflects
   it and a re-share carries what is on screen.

New outbound embed message (additive, backward-compatible):

```ts
{ type: 'rangeChange', t0: string, t1: string, f0: number, f1: number } |
{ type: 'rangeChange', t0: null }   // cleared
```

### Deep links and the fast path

spec_001 landing 1 made `?scene=` skip discovery by constructing
`{root}/{scene}/` and probing it. That path is load-bearing for the flagship
AV2 preset, which has **no `index.json` at all** (it is the public Argoverse
S3 bucket), and for a sensor-root URL it probes three splits in parallel.

An earlier draft of this spec proposed "fetch `index.json` first". That was
wrong: it would add a guaranteed-miss request to every deep link on the
no-index preset and does not even apply to a sensor root. Replaced with:

> **Race, don't reorder.** On a `?scene=` deep link, fire the existing
> constructed-URL probe *and* an `index.json` fetch concurrently. Whichever
> resolves first wins: no-index hosts are unaffected (the index fetch 404s in
> parallel and is discarded), collections with `url` overrides resolve
> correctly, and a collection additionally yields the entry's range **before**
> the scene loads, so first-paint batch prioritisation (spec_001 landing 2)
> can target the range instead of frame 0.

A deep link that must have prioritisation on a no-index host should carry
`t0`/`t1` explicitly — which is what a link shared out of a collection
already does, since applying an entry range syncs it to the URL.

## Selector generalisation

`SearchableSelect` already renders one `tag` per row with filter chips above
the list (AV2 split). Generalise, keeping the component dataset-agnostic:

```ts
export interface SelectTag { label: string; tone?: 'default' | 'warning' }

export interface SelectItem {
  value: string
  label: string
  tags?: SelectTag[]        // was: tag?: string + tagTone?
  score?: number
  description?: string
}
```

- **Chips OR-combine** (union). AND would break the case that ships today:
  AV2 splits are mutually exclusive, so `train AND val` is always empty. OR
  preserves current behaviour and generalises; AND can return later if tags
  ever gain facets.
- **Sorting reorders `availableSegments` itself**, not just the display.
  That array is the app's single source of scene order — prev/next arrows,
  `#N` numbering and embed `setScene` validation all read it — so a
  display-only sort would desynchronise the selector from the buttons beside
  it. `#N` is therefore positional in the *current* order, like a playlist.
  Sort choice is session state, not URL state, in v1.
- **Score sort** is offered only when at least one entry has a score;
  descending by default (the observed workflow is "worst first", which is
  ascending — both directions are offered, defaulting to ascending when the
  collection's scores are all ≤ 1, otherwise descending). Entries without a
  score sort last.
- **Description** renders as a second line on desktop rows (hidden on
  mobile, where rows are already 44px) and joins the text-filter haystack.
- Chip and sort state key off **collection identity** (index URL + entry
  count), not array identity, so background discovery backfilling the
  selector does not reset an active filter.
- Filtering/sorting live in pure helpers with their own tests. No per-dataset
  branches inside the component.

## Plumbing

- `AV2IndexLog` / `NuScenesIndexScene` — new optional fields.
- `AV2DiscoveredLog` / `NuScenesDiscoveredScene` — carry `tags`, `score`,
  `description`, `t0`, `t1`; honour `url`.
- **AV2 `split`** is currently derived from the index root's URL path. With a
  `url` override that inference is wrong, so: when `url` is present, split is
  taken from an explicit tag (`"train"`/`"val"`/`"test"`) or omitted. The
  test-split *warning* stays data-driven — `getLoadedAV2HasAnnotations()`
  already reports the real absence of annotations at load time.
- Store — add `getCollectionMeta(): Map<string, CollectionEntryMeta> | null`,
  folding today's AV2-only `getSegmentSplits()` into it as a tag.
  **This is not the same thing as the existing `segmentMetas` state**, which
  is per-scene stats derived at load time (location, time of day) and
  therefore populated only for scenes the user has already opened, for every
  dataset. Collection metadata comes from the index and covers every entry up
  front. The names must not be confusable — hence `getCollectionMeta`, not
  `getSegmentMeta`.
- **Row composition** must not change shape as scenes are visited: the index
  `description` is the row's second line; the load-time `location · timeOfDay`
  suffix stays on the label line as today. Where nuScenes stores its scene
  description in `segmentMeta.weather` (unrendered today), the index
  `description` wins.
- `selectSegment` — apply the entry's range per the precedence rules.

## Error surfacing

A cross-host collection fails on CORS in a way that reads as our bug. Today's
CORS message names neither host: `DataLoadError.url` exists but `failLoad`
stores only `.message`, and the error screen renders only that. Landing 1
therefore includes a small UI change:

- `failLoad` keeps `errorUrl` (from `DataLoadError.url`).
- `LoadErrorScreen` renders the failing **origin** (not the raw URL, which is
  often an S3 listing query) — "Couldn't load data from `cdn.example.com`" —
  so an entry host is distinguishable from the index host.

## Generators

- `generate_av2_index.py` — `--meta <file.jsonl>`, one JSON object per line
  keyed by `log_id`. Its emitted-key whitelist is extended to the new fields;
  unknown keys are **dropped** (as today), because the loader ignores them
  anyway and silent passthrough would foreclose future field names.
- `shard_nuscenes.py` — `--meta`, plus a new **`--index-only`** mode that
  regenerates `index.json` from an existing shard directory without the
  source dataset. Without it the spec's promise is false: `src` is a required
  positional, the full pipeline loads ~10GB of source tables and rewrites
  every shard, and a publisher who kept only their uploaded shards could not
  annotate their mirror at all.

Annotating an existing mirror then means regenerating `index.json` only — no
re-upload of sensor data.

## Acceptance

- An `index.json` carrying tags/score/description renders chips, sort and
  description rows with no code change for its author.
- A collection whose entries use absolute `url`s loads scenes from a
  different host than the index — including thumbnails, and including via
  `?scene=` deep link (the race resolves to the entry URL).
- A `?scene=` deep link on a host **without** `index.json` is no slower than
  today (measured: first-paint time within noise of the current build).
- An entry with `t0`/`t1` applies its range on selection; switching to an
  entry without one clears it; a page-level range wins on arrival; a
  page-level range that fails to resolve falls through to the entry range.
- A host that called `setWindow` is not overridden by a scene switch, and
  receives `rangeChange` whenever the range changes.
- Chips OR-combine: selecting `train` then `val` shows both, never zero.
- Sorting by score reorders the selector **and** the prev/next arrows
  consistently; `#N` matches visible position.
- Datasets with no metadata behave exactly as today.
- Malformed metadata (non-https `url`, non-numeric score, `t0` without `t1`,
  >8 tags, unresolvable range, missing scene) degrades with a console
  warning — never a failed load. Where the user's action caused it (choosing
  a scene that 404s), the error screen names the failing origin.

## Non-goals

Card/gallery layouts, thumbnail grids, batch selection and batch actions,
saved filters, in-app editing of collections, server-side search, URL-encoded
sort state, and any collection UI beyond chips + sort + description. The host
app owns curation UX; we own the format and the viewer.

## Risks

- **`SearchableSelect` scope creep** — three new concerns in a component every
  dataset uses. Mitigation: pure helpers + tests, no dataset branches, the
  Non-goals above.
- **Row height** — description and multiple pills land in a virtualised list
  with fixed row heights (60px with thumbnails, 32px without). The second
  line and pill overflow must fit those constants or the constants change
  once, deliberately, in landing 2.
- **Tag cardinality** — per-scene unique tags turn the chip row into noise.
  Mitigation: cap chips shown with an overflow count; document that tags
  group rather than identify.
- **`SelectItem.tag` → `tags[]`** is a breaking shape change for its one
  in-repo caller; the migration lands in the same commit.
- **int64 again** — `t0`/`t1` stay strings end-to-end.

## Landings

1. **Schema, discovery, ranges, error origin** — index parsing, `url` and
   `thumbnail` resolution, the deep-link race, entry-range precedence,
   `rangeChange`, `errorUrl` plumbing. Tests for parsing, precedence,
   malformed input, and a no-index deep-link timing check.
2. **Selector generalisation** — `tags[]`, OR chips, score sort with
   `availableSegments` reordering, description line, pure helpers + tests,
   App migration.
3. **Generators + docs** — `--meta` for both, `--index-only` for
   `shard_nuscenes.py`, a worked example collection file, "Collections" in
   EMBEDDING.md and both hosting runbooks.

On landing 3, this spec goes **shipped**. spec_001 advances separately: its
item 5 documentation pass is not fully done (the "host action button" recipe
is still unwritten), so it stays in-progress until that lands.

## Consumer (next spec)

Two demo host pages — a scenario-mining review queue and a labelling triage
queue — will consume collections through the public contract only (URL params
+ postMessage, static pages under `public/demos/`). They are the external
validation of both this format and the embed API: whatever they cannot
express becomes input to the SDK spec (roadmap Phase 2). Their data files
double as the reference examples of a collection.

Note the boundary: those demos build list/filter/batch UI **in the host
page**, which is precisely what this spec's Non-goals keep out of the viewer.
That is the point — the demo shows the composition we want people to copy.
