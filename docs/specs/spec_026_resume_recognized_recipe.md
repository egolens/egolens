# Resume teaching from a recognized recipe

**Status**: implemented; authoring tests and build passed locally · **Date**: 2026-09-11

Expose the existing Edit recipe action after rendering a recognized sealed recipe,
including when recognition leaves the authoring session in its initial inspecting
phase. The tooltip explains that the loaded recipe becomes the base revision.

Reuse the authorized local or remote inventory and the recipe sensor layout.
Record the loaded recipe hash as the parent of the resumed revision, reset human
review, and use the existing review dock and agent revision flow. Do not mutate or
overwrite the saved sealed artifact. Hide the action while validation or review
is already active.
