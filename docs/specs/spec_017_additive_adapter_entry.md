# Additive adapter entry and agent-free recipe reuse

**Status**: in-progress · **Date**: 2026-09-10

Implementation scope authorized by the user after spec 016, with an explicit requirement to respect existing wording and returning users. The user also requested English throughout the specs; spec 016 was translated in place under that authorization.

## Approved scope

- Preserve the existing hero, dataset badges, preset names and behavior, URL controls, Select Folder, and folder guidance. Add a supplemental sentence where the existing supported-format list is incomplete.
- Add a compact `Have a different dataset format?` section with `Use an adapter recipe` and `Create an adapter with AI`. Explain that reuse needs no agent and creation needs a connected browser agent.
- Offer local recipe files and remote URLs, retaining expected-hash verification for remote recipes. Recipes and source data remain separate inputs.
- Open local data with the imported recipe without starting an AI authoring session or fabricating review/finalization history. Preserve the selected folder during import errors and route selection.
- For unrecognized folder drops, offer reuse or teaching, including saved compatible recipes.
- Prioritize Codex setup guidance for teaching; distinguish exposed tools from an actual agent response.
- Verify the consumption path and familiar landing behavior with focused tests and local browser checks.

## Deferred work

A new hosted adapter example, publishing source data/catalogs, arbitrary remote-data teaching, new recipe-link formats, changes to preset behavior, and deployment remain outside this implementation. Present a concrete plan and obtain approval before advancing those phases.

## Implementation approach

Use a dialog over the existing landing so cancellation preserves its form state. Keep schema/engine/artifact checks in a reusable consumption module, with source compatibility checked after selecting files. Reuse the existing scene loader and surface failures in the dialog so the recipient can correct the recipe or folder. Keep imported recipe provenance unchanged.

## Completion criteria

A visitor can find the new entry on the unchanged landing, import a recipe file or URL, select local data, and render without WebMCP or finalization. An unrecognized-folder visitor can choose the same path without selecting the folder again. Failed import, canceled selection, or incompatible data permits recovery. Existing built-in controls retain their labels and behavior. English specs and implementation evidence are recorded before reporting completion.
