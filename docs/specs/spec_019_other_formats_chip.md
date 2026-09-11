# Other formats chip and direct AI setup

**Status**: in-progress · **Date**: 2026-09-10

The user approved a fourth, dotted-border format chip after Waymo v2, nuScenes, and Argoverse 2. This supersedes spec 017's separate landing card and AI introduction dialog. Spec 018's URL-only import and optional version verification remain in effect.

## Approved interaction

- Preserve the existing dataset links, hero, presets, URL controls, and local drop controls. Replace the separate adapter card with a `＋ Other formats` button beside the three dataset chips, matching their dimensions and typography with a dotted border.
- Explain the capability on hover and keyboard focus: `Use an adapter recipe, or create one with AI.` Keep the meaning available in the button label and dialog for touch users. Allow dismissal of the tooltip with Escape.
- Open one choice dialog. `Use an adapter recipe` changes that same dialog to file/URL import. `Create an adapter with AI` opens the folder picker directly, or reuses an already selected folder.
- After selecting a folder for AI creation, close the dialog and show the existing sensor confirmation component on the page. Start the authoring session only after the person confirms a valid configuration. An explicit creation choice must not return to the saved-recipe recommendation instead of authoring.
- Explain the browser-agent requirement beside the creation option. If no browser tool host is available, keep recipe reuse available and give brief Codex setup guidance. Host API availability does not establish that an agent has responded.
- Canceling the folder picker leaves the choice dialog intact. Returning from sensor setup restores the same inventory and saved recipe choices. Canceling setup releases files only when the user leaves the selection flow.

## Validation and boundaries

Check the chip's placement, tooltip, keyboard access, and narrow layout in the browser; exercise recipe reuse in the same dialog and direct AI folder selection through sensor confirmation. Cover cancellation, retained-file handoff, missing-host guidance, and invalid sensor configuration with focused tests. Run build and lint plus the relevant import and authoring checks.

All new specification text is English. This phase changes local navigation only; new hosted examples, live AI generation, publication, and deployment remain separate approval steps.
