# Teachable Lens telemetry operations

## Architecture
Existing GA4 events remain intact. New tl_* events cover discovery, preset selection, loading, recipe import, recognition, authoring, WebMCP calls, human review, sealing, and export. Private Cloudflare R2 batches add allowlisted operator, diagnostic, shape, and revision-change summaries. See src/utils/teachableTelemetrySchema.ts for the exact event and field vocabulary.

VITE_TEACHABLE_TELEMETRY_ENDPOINT enables R2 delivery. VITE_BUILD_ID identifies the deployed commit. VITE_ANALYTICS_DISABLED=true disables the new telemetry as well. The GitHub deployment workflow supplies the endpoint and build ID; local development settings are not changed.

## Deployment
Run `wrangler deploy --config workers/teachable-telemetry/wrangler.jsonc`.
The bucket is `egolens-teachable-telemetry`; events/ objects expire after 30 days. The Worker accepts production origins only and exposes no read endpoint. INGEST_ENABLED=false is the collection kill switch.

## Reading a case
Download private event batches through the authenticated R2 dashboard, or use `wrangler r2 object get egolens-teachable-telemetry/<object-key> --remote --file batch.json` for a known key. The ingestion response includes X-EgoLens-Receipt for operational write/read verification.

Run `node scripts/summarize-teaching-telemetry.mjs batch.json other-batch.json` to group records by case and sort attempts/reviews by sequence. Collect all relevant batches before interpreting missing events. GA4 case_id can be used to correlate exported events with R2 records; it is not a persistent visitor identity.

## GA4 analysis
Suggested funnel: tl_preset_select → tl_load_start → tl_session_start → tl_tool_call (apply_revision success) → tl_human_review (accepted) → tl_seal.
Track engine validation failures separately from human rejections. Suggested event-scoped custom dimensions: tool, phase, outcome, issue, capability, sample. Registration is a separate GA4 Admin step and is not performed by frontend instrumentation. Avoid registering UUIDs as report dimensions because of high cardinality. Existing URL dimensions are preserved.

## Limits and interpretation
Batches contain at most 8 records and 15 KiB; the Worker accepts at most 16 KiB. Collection stops at 500 records per case. Delivery is best effort, without retries or offline persistence. Blocking, navigation, network failures and rate limits can leave gaps. No seal event is not proof of failure.

Rate limiting is 20 requests/minute per IP per Cloudflare location. It is not a global storage budget; origin checks also are not authentication for a public endpoint. Monitor R2 usage and disable ingestion if needed. The free allowance is not a hard spending cap. Worker request logs are disabled, and IPs are used only for rate limiting, not stored in diagnostic objects.

Structure summaries cannot replay a private dataset exactly. Use them to identify common failing operators and review issues, then reproduce with public or synthetic fixtures. Expansion of automatically collected fields must preserve the allowlist boundary; never log raw WebMCP payloads as a shortcut.

## Browser capability attribution
Every `tl_*` record now includes detected `agent` and numeric `available` (WebMCP surface present). `tl_browser_context` records the initial page observation and changes. Detection retries for 30 seconds to handle delayed host injection, and checks again on focus, visibility restoration, and manual setup checks. `tl_codex_visit` is emitted at most once per page lifetime when Codex-specific host markers are found, so standard GA4 event reports can count detected Codex page visits without custom-dimension registration. Register event-scoped `agent` and `available` for funnel breakdowns; this code does not register GA4 Admin dimensions.

Use `tl_tool_call` to distinguish actual agent tool use from mere browser availability. A generic WebMCP surface is labelled `chrome`, not proof of a connected agent; an undetected host is `unknown`, not proof that Codex was absent. Counts are page lifetimes, not unique people. These additions are prospective and cannot identify historical Chrome visits. Existing URL tracking and analytics opt-out remain unchanged. Deploy the Worker allowlist before publishing the frontend that sends the new event names.
