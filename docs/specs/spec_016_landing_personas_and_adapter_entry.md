# Landing personas and adapter entry

**Status**: superseded (→ spec_017 for implementation scope) · **Date**: 2026-09-10

Phase 1 analysis and design proposal supporting spec 015. Translated into English at the user's request. This document records the original proposal; spec 017 incorporates the subsequent instruction to preserve existing wording and entry points, and the authorization to begin implementation. Deployment and later phases still require separate approval.

## Evidence and limits

- Inspected the live egolens.org landing page and accessibility tree, and the local entry, authoring, and reuse code.
- The personas below are hypotheses derived from the product and intended LinkedIn/VIS referrals. They are not measured visitor segments from GA4 or interviews.
- Inspected the landing UI but did not download every dataset or execute every rendering path during this analysis. Runtime support is distinct from a verified first-visit experience.
- Agent availability is an environmental condition across personas, not a persona itself.

## Main personas and first success

| Persona | Intent and starting material | What must make sense first | First success | Required entry |
|---|---|---|---|---|
| P1. Researcher or engineer inspecting their data | A local folder or hosted data URL; may not know whether the format is supported | Can I open my data? What happens if its format is absent from the supported list? | Open their first scene and inspect relationships across sensors and time | Existing data loading plus a visible path for another format |
| P2. Recipe recipient or returning collaborator | Compatible data and a recipe file/URL, or a complete shared scene link | How easily can I reproduce the result? | Render without repeating AI authoring | Use an adapter recipe, saved recipes, shared links |
| P3. First-time evaluator | A LinkedIn, VIS, or portfolio referral; possibly no data, recipe, or agent | What does the product do? Can I try its recipe-based extensibility? | Interact with a prepared example and understand the next step for their own data | An example, a concise explanation of its adapter, and optional video |

P1 is the core practitioner. P2 determines whether an adapter transfers beyond its creator. P3 determines the first public-release experience. The original proposal therefore emphasized a prepared example while also exposing direct P1/P2 entries on the first screen.

Existing Waymo, nuScenes, and AV2 users are an important P1 subgroup. Preserve their folder and URL access. AI-assisted authoring is a problem-solving stage for P1, not a role every visitor must adopt.

## Current flows at the time of analysis

| Entry | Actual behavior | Persona gap |
|---|---|---|
| Try nuScenes mini / Try Argoverse 2 | Prefills dataset and URL; requires a subsequent Load click | P3 may expect immediate execution; built-in examples do not demonstrate adapter-based extension |
| Dataset + data URL + Load | Supports three built-in formats, optionally a specific scene/segment | Could be mistaken for arbitrary remote-format teaching |
| Folder drop / Select Folder | Detects built-ins; nonempty unrecognized folders enter Teachable Lens | Copy names only three formats; the extension becomes visible only after dropping another format |
| Unrecognized folder + saved compatible recipe | Finds recipes in this browser and offers Render now | A recipient in a fresh browser has no equivalent entry for a received file |
| Unrecognized folder + new authoring | Sensor configuration, agent request, review, revision, finalize/export | Host requirements appear after selecting files |
| Import JSON / Import URL | Lives on the finalized screen; URL requires an expected recipe hash; import is an authoring revision | Does not provide a first-visit consumption path |
| Data deep link / portable share link | Runtime can load built-in links or recipe/catalog-backed remote scenes | Little landing-page visibility; a new public link was not fully verified in this analysis |

The landing communicates a viewer for three datasets. The missing message is that other formats can be opened with recipes. The Teachable Lens name alone does not explain the visitor's next action.

## Original landing proposal

This was an information-architecture proposal, not an approved visual redesign. Its hero replacement and relocation of existing forms were subsequently withdrawn in favor of additive entry points; see spec 017.

```text
EgoLens
Explore 3D driving data in your browser.
Open a built-in format, or use an adapter recipe for another format.

[ Explore an example ]
No dataset or AI agent needed.
Other examples: nuScenes mini · Argoverse 2

Open your data                         Working with another format?
Waymo · nuScenes · Argoverse 2           Open it with an adapter recipe.
[ Select folder ] [ Data URL ]          [ Use an adapter recipe ]
Other formats can use adapters.         File or link. No AI agent needed.
                                       [ Create an adapter with AI ]
                                       Requires a connected agent.
```

- Keep extension entry points visible before long form and folder-structure details, including on mobile.
- The intended public example uses a reviewed recipe. Do not advertise a working example before verifying its data and link. Existing built-in examples remain useful.
- A future immediate-start example should begin loading when selected; any intermediate selection should be clearly explained. Changing current preset behavior needs its own scope decision.
- The example viewer should remain interactive and explain that it opened with a recipe, with paths to reuse or create an adapter. Video provides optional context.
- Do not promise arbitrary format support: recipes are limited by available readers and operators.

## Flow A: Use an existing recipe

```text
Use an adapter recipe
  → Recipe file / Recipe URL / Saved in this browser
  → Inspect recipe identity, sensors, capabilities, and engine compatibility
  → Select the data folder
  → Check required files and engine support
  → Render the first scene
  → Optionally review or refine
```

This path does not require an agent, another authoring session, acceptance of every capability, or finalization. Importing must not imply that the recipient personally reviewed the recipe.

When a folder is selected first, preserve it while offering a saved compatible recipe, import, or new authoring. Avoid a dead end that only offers AI authoring.

### Recipe location and data location are independent

| Input | Contains | Additional data selection | Agent |
|---|---|---|---|
| Local recipe JSON | Instructions for interpreting data | Required | Not required |
| Remote recipe URL | The same kind of recipe, fetched remotely | Required | Not required |
| Recipe saved in this browser | Previously saved interpretation | Required | Not required |
| Complete EgoLens scene link | Recipe location, remote data/catalog, presentation | Not required if complete | Not required |

A remote recipe can open local data. Prioritize local data with either local or remote recipes, plus complete prepared remote scene links.

The remote recipe runtime requires a source catalog and data identity. Do not imply that an arbitrary unsupported data URL can already be opened or taught. Remote-data authoring is a separate capability.

Current remote import requires a URL and expected hash. Preserve verification. A future recipe import link can carry both values to reduce manual entry, but requires separate design and validation. Distinguish such a reference from a complete scene share link.

## Flow B: Create an adapter

```text
Create an adapter with AI
  → Explain whether this environment supports teaching
  → Select local data
  → Confirm detected sensors
  → Ask the agent
  → Receive an actual tool call
  → Review render → report an issue → revise
  → Approve, save, export
  → Use the existing-recipe path next time
```

- Make Codex's in-app browser the primary environment EgoLens guides and verifies. This is a product support decision, not a claim of exclusive platform support.
- Keep the entry visible in ordinary browsers. Offer setup guidance and useful recipe/example alternatives.
- If a control only provides instructions, label it accordingly rather than promising automatic app handoff. Explain that changing browsers requires selecting local files again.
- Chrome documents an origin trial from Chrome 149, a local testing flag, and a separate Inspector/agent experimentation workflow. API availability and an attached conversational agent are distinct. [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
- Existing host guidance lists Codex, ChatGPT, and Chrome equally. Public support claims should follow verified end-to-end teaching, not merely detection code.

| State | Meaning | Next action |
|---|---|---|
| No tool API | Browser is not ready for AI authoring | Codex setup, recipe reuse, or example |
| Tool API exists; no calls received | Tools exposed; waiting for the agent | Copy prompt and explain where to ask |
| Actual tool call received | Agent responded in this session | Progress and next review action |

Current `available` detects modelContext presence. It must not imply that an agent is connected. `agentEngaged` provides evidence of a response at a point in time, not a permanent connection guarantee.

## Persona acceptance criteria

These are proposed checks, not completed results.

| Persona | Task | Evidence to collect |
|---|---|---|
| P1 | Arrive with an unsupported local folder | Discover extension without reading the README; choose reuse or authoring while preserving the folder |
| P2 | Use a received recipe in a fresh ordinary browser | Local-file and remote-URL recipes work without authoring or an agent; required data is clear |
| P3 | Arrive without preparation | Explain the product, interact with a public recipe example, and distinguish result viewing from live authoring |
| Existing built-in user | Open a familiar URL or folder | Find familiar controls without mandatory adapter onboarding |

Provide recovery for back navigation, canceled file selection, invalid recipes, incompatible folders, unavailable engine functions, and network failures.

## Implementation boundaries

1. Separate entry intent and recipe consumption from the AI authoring session. Do not force consumption through `applyRevision`.
2. Reuse `loadAuthoredScene` and portable-share runtime where appropriate, preserving schema, hash, engine, and source-binding checks.
3. Finalized-screen import follows parent-revision, author provenance, and sensor-configuration rules. Moving that button alone is insufficient.
4. Keep recipe reuse and personal review history distinct; do not fabricate finalization or review records to cache an import.
5. Verify public data, catalog, and recipe accessibility without the creator's IndexedDB or local files.

## Decisions originally submitted for approval

1. Use the three personas above.
2. Expose examples, built-in data entry, and recipe reuse versus AI creation.
3. Make reuse agent-free; initially cover local data with local/remote recipes and complete remote shares.
4. Prioritize Codex guidance while distinguishing tools exposed from agent response.

The subsequent user approved implementation with existing wording respected. Spec 017 records the narrowed, additive scope. Later phases and deployment require their own approval.

## Inspected code

- `src/App.tsx`: DropZone, presets, folder detection, share autoload, authored rendering.
- `src/utils/presets.ts`: built-in example URLs.
- `src/components/TeachableLens/TeachableLensPanel.tsx`: saved recipes, review, finalized import/export.
- `src/components/TeachableLens/stages.tsx`: host guidance.
- `src/teachable/authoring/agentDetection.ts`: API and host detection.
- `src/teachable/authoring/AuthoringSession.ts`: matching, revisions, import, agent engagement.
- `src/teachable/authoring/SourceInventory.ts`: local-file authoring inventory.
- `src/teachable/authoring/persistence.ts`: finalized recipes and review metadata.
- `src/teachable/share/RecipeTransport.ts`: remote URL/hash checks.
- `src/teachable/share/ShareDescriptor.ts`, `PortableShareRuntime.ts`: remote scene assembly.
- `src/stores/useSceneStore.ts`: authored and portable-share loading.
