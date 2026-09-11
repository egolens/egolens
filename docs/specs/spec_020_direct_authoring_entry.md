# Direct authoring entry with editable sensor defaults

**Status**: in-progress · **Date**: 2026-09-10

During local review of spec 019, the user explicitly requested removing the intervening sensor-confirmation screen. This addendum supersedes that step only; the fourth format chip, tooltip, choice dialog, and recipe-import path remain approved.

## Approved behavior

Choosing `Create an adapter with AI` opens the folder picker directly. After a valid folder is selected, close the dialog and enter the existing authoring screen immediately. Reuse an already selected folder without another picker.

Initialize the session with valid sensor counts and IDs inferred from the folder. If the layout cannot be inferred into a valid configuration, enter with the existing unspecified-layout state rather than block navigation or invent sensors. The existing `Detected sensors` summary and `Edit` control remain available for optional corrections. Invalid manual edits must show a recoverable inline error and preserve the selected files.

Remove the separate sensor-setup component, route state, and its obsolete tests. Keep recipe schema checks, human review, finalization, and explicit expected-layout validation intact. Selecting AI creation must enter authoring even if saved recipes are available.

## Validation

Verify immediate folder-to-authoring navigation, inferred defaults, optional Edit, and recovery from unknown layouts. Run the affected entry and sensor tests, build, lint, and the complete regression suite. Record this revision with the final spec 019 implementation evidence. Deployment and live AI generation remain outside this local UI change.
