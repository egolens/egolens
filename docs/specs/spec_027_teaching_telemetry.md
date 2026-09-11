# Teachable Lens telemetry

Status: Implemented locally; ingestion deployed; production frontend rollout pending.

## Purpose
Connect discovery, loading, WebMCP calls, recipe attempts, human review, and sealing. GA4 provides aggregate funnels; private R2 batches provide structural diagnostic detail.

## Revision history
Each apply_revision attempt gets a random revision_id. parent_id identifies the last engine-accepted revision in the current in-memory case, including when the current attempt fails. Sequence orders events within the case. Changes compare the candidate against the current accepted artifact, not the previous rejected attempt. Human reviews and sealing carry the accepted revision identifier.

The comparison records operator additions/removals/modifications, changed engine-owned parameter names, and whether inputs changed. Parameter values are compared locally but never uploaded. A changed value is evidence of a modification, not proof of improvement. Compare diagnostics and explicit human reviews separately. A validation pass does not prove visual correctness.

## Boundaries
Only pipeline-node differences are currently summarized. Scene/source declarations and changes outside pipeline nodes are not captured. Revision lineage resets on reload or a new case; existing saved recipes have no cross-session telemetry identity. Phase transitions may occur before the apply_revision result and therefore reference the previously accepted revision; use tool_call as the authoritative attempt outcome.

No raw tool arguments/results, dataset files, file paths, customer keys, recipe constants, notes, or request headers are stored in R2. Existing GA4 URL tracking remains unchanged. Structural summaries support prioritization and synthetic regression fixtures, not faithful reconstruction of arbitrary private datasets.

## Delivery and limits
See ../TEACHABLE_TELEMETRY.md for deployment, retention, retrieval, and operational limits.
