# Specs

Numbered, point-in-time planning documents: `spec_NNN_<name>.md`.

A spec captures a decision and its plan as of its date. Unlike runbooks and
guides (which live in `docs/` and are edited in place), a spec is only ever
updated in two ways: its **Status** line advances, or a later spec supersedes
it. Every spec starts with:

```
**Status**: planned | in-progress | shipped | superseded (→ spec_NNN) · **Date**: YYYY-MM-DD
```

Numbers are permanent and never reused. Pre-existing planning docs in `docs/`
(TECHNICAL_PLAN, URL_DATA_LOADING_PLAN, EMBED_SYSTEM_DESIGN, …) predate this
convention and keep their names.

| # | Spec | Status |
|---|------|--------|
| 001 | [Integration contract — deep-link fast path, setScene, time window, collections](spec_001_integration_contract.md) | in-progress (item 4 → spec 002) |
| 002 | [Collections — index.json curation metadata](spec_002_collections.md) | planned |
| 003 | [Embed view composition — controls, cameras](spec_003_embed_view_composition.md) | planned |
