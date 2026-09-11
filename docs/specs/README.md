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
| 006 | [Teachable Lens — portable full-scene adapter recipes](spec_006_teachable_lens.md) | in-progress (Phases 2–9 shipped; Phase 10 original-data generalization ladder → spec 014) |
| 007 | [Teachable Lens Phase 2 contract lock](spec_007_teachable_lens_phase2_contract_lock.md) | shipped; normative addendum to spec 006 Phase 2 |
| 008 | [Teachable Lens Phase 3 implementation findings](spec_008_teachable_lens_phase3_findings.md) | shipped; normative addendum to spec 006 Phase 3+ |
| 009 | [Teachable Lens Phase 3 live-data contract hardening](spec_009_teachable_lens_phase3_live_data_contracts.md) | shipped; normative addendum to specs 006 and 008 |
| 010 | [Teachable Lens Phase 4 implementation findings](spec_010_teachable_lens_phase4_findings.md) | shipped; normative addendum to spec 006 Phase 4+ |
| 011 | [Teachable Lens Phase 5 implementation findings](spec_011_teachable_lens_phase5_findings.md) | shipped; normative addendum to spec 006 Phase 5+ |
| 012 | [Teachable Lens Phase 6 performance and lifecycle gate](spec_012_teachable_lens_phase6_performance_gate.md) | complete; three-dataset performance, lifecycle, and exact-head promotion gates passed |
| 013 | [Teachable Lens hidden-oracle retention](spec_013_teachable_lens_hidden_oracle_retention.md) | complete; Phase 6 promotion and Phase 9 Adapter Amnesia retention gates passed |
| 014 | [Teachable Lens Phase 10 original-data generalization ladder](spec_014_teachable_lens_phase10_generalization_ladder.md) | in-progress; preflight 10.P1–P5 implemented, 10.P6–P7 ordered before A2D2 → KITTI Raw → ONCE → PandaSet original-drop evidence |
| 015 | [Teachable Lens public experience, VIS talk, and citable research](spec_015_teachable_lens_public_release.md) | in-progress; CLUSTER submission reported complete September 10; [execution log](../TEACHABLE_LENS_PUBLIC_RELEASE_LOG.md) |
| 016 | [Landing personas and adapter entry](spec_016_landing_personas_and_adapter_entry.md) | superseded for implementation scope by spec 017; translated into English at the user's request |
| 017 | [Additive adapter entry and agent-free recipe reuse](spec_017_additive_adapter_entry.md) | in-progress; implemented and verified locally with existing wording preserved; deployment pending |
| 018 | [URL-only recipe import with optional version verification](spec_018_url_only_recipe_import.md) | in-progress; implemented and verified locally, deployment pending |
| 019 | [Other formats chip and direct AI setup](spec_019_other_formats_chip.md) | in-progress; implemented locally, sensor-confirmation step superseded by spec 020; deployment pending |
| 020 | [Direct authoring entry with editable sensor defaults](spec_020_direct_authoring_entry.md) | in-progress; implemented and verified locally; deployment pending |
| 021 | [Hosted teaching sample and local ZIP alternative](spec_021_hosted_teaching_sample.md) | in-progress; implemented and verified locally; sample connected on R2, application deployment pending |
| 022 | [Recipe playback scheduling and worker execution](spec_022_recipe_playback_scheduling.md) | in-progress; Phases 1 and 2 validated locally; Worker parity in spec 024; deployment pending |
| 023 | [Continuous recipe buffering within byte budgets](spec_023_continuous_recipe_buffering.md) | superseded for browser worker playback by spec 024; fallback validated |
| 024 | [Recipe and built-in playback parity](spec_024_recipe_worker_parity.md) | in-progress; implemented and validated locally; deployment pending |
| 025 | [Remove payload hash verification](spec_025_remove_payload_hash_verification.md) | implemented; validated locally |
| 026 | [Resume recognized recipe](spec_026_resume_recognized_recipe.md) | implemented; validated locally |
