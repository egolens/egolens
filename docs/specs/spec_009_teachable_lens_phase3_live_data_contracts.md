# Spec 009 — Teachable Lens Phase 3 live-data contract hardening

**Status**: shipped · **Date**: 2026-08-29

**Relationship to Specs 006 and 008**: this is the normative live-data addendum
for [`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phase 3 and
[`spec_008_teachable_lens_phase3_findings.md`](spec_008_teachable_lens_phase3_findings.md).
It records two constraints discovered while running the strict nuScenes recipe
against an official mini drop and a local SPA development host.

## Decision

Strict readers and matchers remain fail-closed. A real format exception is
accepted only through an explicit, bounded recipe contract; an HTTP success is
not treated as dataset evidence without validating what it represents.

## 1. Declared PCD records may be followed by bounded zero padding

Official nuScenes radar PCD files may contain more bytes after the binary
records declared by `POINTS`. The observed suffix is zero padding, not another
record stream. Inferring record count from all remaining bytes creates phantom
points at the sensor origin and violates the PCD header.

`binary.pcd_records@1` therefore decodes exactly the declared point count and
keeps the default rule from Spec 008: a longer payload is rejected. A recipe
may opt into the single supported exception by declaring both:

```json
{
  "trailingPadding": "zero",
  "maxTrailingBytes": 4096
}
```

When that policy is present, the reader must:

- reject a suffix larger than `maxTrailingBytes`;
- verify every suffix byte is zero;
- exclude the suffix from record and allocation counts;
- reject non-zero data, undeclared padding, and short payloads;
- use the same parameters in the recipe runtime and compatibility worker.

This is an encoding-level option. It must not be named after nuScenes or enabled
globally for other PCD sources.

## 2. Remote version-root evidence must be complete and content-aware

SPA hosts commonly return `200 OK` plus `index.html` for missing paths. A probe
of only `{candidate}/scene.json`, or a check of `response.ok` alone, can make
every allowlisted nuScenes version root appear viable and produce a false
ambiguity.

Remote version-root matching must therefore:

- probe every file in `match.versionRoot.requiredFiles` for every candidate;
- accept a candidate only when every required response is successful and has
  JSON content evidence;
- reject HTML SPA fallbacks even when their status is 200;
- apply the same exactly-one-root rule used by local inventory binding;
- report incomplete roots as missing and multiple complete roots as ambiguous.

The check remains a bounded candidate-selection step. Full JSON parsing and
schema validation happen later through the normal metadata reader.

## Acceptance evidence

- [x] Official mini radar PCD decodes its header-declared 125 records while a
      zero suffix is ignored only under the bounded recipe policy.
- [x] Deterministic fixtures reject undeclared, non-zero, and oversized PCD
      suffixes.
- [x] URL-mode tests cover mini, trainval, test, incomplete roots, ambiguous
      roots, and `200 text/html` SPA fallbacks.
- [x] The live nuScenes mini scene renders LiDAR, radar, six camera streams,
      boxes, timeline state, and camera POV switching after strict binding.
