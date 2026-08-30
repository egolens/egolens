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
| 003 | [Embed view composition — controls, cameras](spec_003_embed_view_composition.md) | shipped |
| 005 | [Chrome token hygiene and embed theming](spec_005_embed_theming.md) | in-progress |
| 006 | [Teachable Lens — portable full-scene adapter recipes](spec_006_teachable_lens.md) | in-progress (Phases 2–4 shipped; Phase 5 next) |
| 007 | [Teachable Lens Phase 2 contract lock](spec_007_teachable_lens_phase2_contract_lock.md) | shipped; normative addendum to spec 006 Phase 2 |
| 008 | [Teachable Lens Phase 3 implementation findings](spec_008_teachable_lens_phase3_findings.md) | shipped; normative addendum to spec 006 Phase 3+ |
| 009 | [Teachable Lens Phase 3 live-data contract hardening](spec_009_teachable_lens_phase3_live_data_contracts.md) | shipped; normative addendum to specs 006 and 008 |
| 010 | [Teachable Lens Phase 4 implementation findings](spec_010_teachable_lens_phase4_findings.md) | shipped; normative addendum to spec 006 Phase 4+ |
