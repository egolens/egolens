# Teachable Lens public release execution log

Updated: 2026-09-11

Execution record for [spec 015](specs/spec_015_teachable_lens_public_release.md). The spec remains a point-in-time plan; this log tracks completed milestones, the framing refined with the author, and the remaining work.

## Completed and verified

- **CLUSTER lightning talk application:** the author reported submission complete on September 10. Selection is pending. The exact submitted fields and a submission receipt have not been retrieved; the wording discussed in chat should not be treated as an independently verified submission copy.
- **Last discussed title:** The AI Built the Data Loader. How Do We Design for Visual Review?
- **Supporting materials:** [demo video](https://www.youtube.com/watch?v=wlGWJBTKFbY), [Devpost project](https://devpost.com/software/egolens-teach-your-browser-any-driving-dataset), and [speaker portfolio](https://happyhj.github.io/).
- **Existing software archive:** the [concept DOI](https://doi.org/10.5281/zenodo.20460188) resolves to the public [webmcp-sample record](https://zenodo.org/records/22267255), published September 3, 2026. Its version DOI is [10.5281/zenodo.22267255](https://doi.org/10.5281/zenodo.22267255). The page also lists v1.0.0, published May 30, under [10.5281/zenodo.20460189](https://doi.org/10.5281/zenodo.20460189). These were verified on the public record page. A software citation already exists; the later paper should cite the version actually studied.

## Framing agreed during the application

AI can generate a dataset adapter, while a person still has to inspect cameras, point clouds, boxes, poses, and their relationships. The practical design question is how a review view can make errors missed by the current automated checks easy to notice with minimal cognitive effort.

The five-minute talk shares one concrete failure, the feedback and correction, and the unresolved review burden. The coordinate alignment error was corrected; a generally effective design for low-effort human review remains an open question. Do not describe reduced cognitive load as an evaluated result or suggest that all visual errors are inherently beyond AI.

The existing video's transcript describes ego/point-cloud drift and correction at 1:04 to 1:45. The Devpost text additionally describes a 90-degree box-yaw error. Keep these cases distinct when preserving evidence or writing a paper.

## Public-entry observations before spec 017

- `src/App.tsx` starts teaching when folder scanning finds an unrecognized, nonempty inventory. The previous public-entry audit still applies: make the capability discoverable before requiring this drop.
- The README offers downloadable PandaSet samples with 6 frames (32 MB) and 80 frames (439 MB). These are candidate sample inputs, not a verified one-click public teaching experience.
- Existing authoring, review, export, reuse, and portable-sharing components should be exercised before extending them. This follow-up did not rerun the complete workflow.
- The challenge documentation says no finished sample recipe is published. Locate and verify the intended reviewed recipe when preparing the public result path.

## Spec 017 local implementation

The user authorized implementation after asking to preserve existing wording and to use English in all specs. Spec 016 was translated, and spec 017 records the additive implementation scope. No deployment was performed.

- Preserved the hero, built-in dataset badges, existing preset labels and prefill behavior, URL form, and Select Folder entry. Added a compact other-format card above the existing URL section.
- Added an independent recipe-consumption dialog for JSON files and remote URLs. Remote recipes still require the expected recipe hash. Recipe and dataset selection remain independent.
- Imports preserve original provenance and do not create authoring revisions, personal review records, or a finalized artifact. Shared artifact checks now run before data selection; source-layout checks run before rendering.
- Unrecognized-folder selection offers reuse, saved compatible recipes, or AI creation while keeping the selected inventory. Import and rendering errors retain the folder; pending imports and folder matching can be canceled.
- AI creation prioritizes Codex guidance and uses the existing sensor-layout confirmation before starting the authoring session. Zero inferred sensors produces a recoverable validation message rather than a navigation exception.

Validation:

- `npm run build` passed. Vite reports the existing large-bundle advisory.
- `npm run lint` passed with 0 errors and 64 warnings.
- Final complete suite: `npm test -- --pool=forks --maxWorkers=2`, 102 files and 1,122 tests passed. An earlier default-thread run passed; a later repeat terminated inside the native `webgpu` Dawn addon with `napi_define_properties`. Process isolation completed the final suite without changing GPU code or the default pool setting.
- Browser checks in the local Codex in-app browser: file recipe + local synthetic timeline rendered; remote recipe fetched from a separate loopback origin with its expected hash + local Waymo-format fixtures rendered five LiDAR streams and 3D boxes across a 199-frame timeline; frame stepping worked.
- Verified preset URL state survives opening and canceling adapter setup, unrecognized folders reach the reuse/creation choice, and confirmed sensors reach the existing authoring screen. Inspected narrow and desktop layouts.
- Automated dialog tests cover an environment without WebMCP, stale-recipe rejection after a failed replacement, retained files after rendering errors, cancellation during pending matching, missing sensor configuration, and successful handoff of confirmed sensors.

These checks establish the local entry and reuse implementation. They do not constitute a new live AI authoring run, a generalization evaluation on another real dataset, or a deployed public example. The public sample, its hosting/catalog, and deployment remain later approval steps.

## Spec 018 local implementation

The user approved URL-only import, an optional advanced hash field, and preserving version verification in existing shared links. Spec 018 supersedes the mandatory import hash described in the spec 017 record above.

- Ordinary remote import now accepts a URL alone. The optional expected hash appears in a collapsed Advanced options section, which indicates when a version check is enabled.
- Added a distinct import transport entry point. Portable sharing retains its required-hash API. URL-only imports fetch the current contents with `cache: 'no-store'`; only an explicit pin can select a previously verified recipe from the identity cache.
- The transport verifies supplied semantic, operator-set, and artifact hashes before cache promotion, and checks cached artifacts on reuse. Existing URL, size, credentials, redirect, schema, and operator restrictions remain in effect.
- Editing the URL or optional hash invalidates the previously loaded recipe. A mismatch preserves the selected dataset folder; clearing the optional hash allows a fresh import.

Validation:

- Focused transport, import, dialog, portable-share runtime, and Phase 10 negative-gate tests: 5 files, 41 tests passed.
- Complete suite: `npm test -- --pool=forks --maxWorkers=2`, 102 files and 1,133 tests passed.
- `npm run build` passed with the existing large-bundle advisory. `npm run lint` passed with 0 errors and 64 existing warnings. `git diff --check` passed.
- Browser check: the default URL form hides the optional hash, enables Import URL with a URL alone, and successfully imports the exported Waymo fixture from a separate loopback origin without an expected hash. The page displays the checked recipe and its sensor summary. Automated integration tests also bind an imported URL-only recipe to local data and read the timeline.
- Inspected the narrow viewport and left the empty URL form open for review. The temporary fixture server was stopped; the local Vite preview remains available. No deployment was performed.

## Specs 019 and 020 local implementation

The user approved replacing the separate landing card with a fourth format chip. During review, the user also requested removing the intermediate sensor-confirmation page and replacing abstract agent terminology with a concrete app instruction. Spec 020 records the final direct-entry behavior.

- Added a dotted-border `＋ Other formats` button after the three existing dataset links. It matches their typography and opens a single choice dialog. A tooltip appears on hover or keyboard focus and supports Escape dismissal. Existing hero, dataset links, presets, URL form, and local drop controls retain their wording and behavior.
- Removed the standalone other-format card and its duplicate local-folder sentence. Recipe reuse changes the existing dialog to file/URL import; the spec 018 optional hash behavior remains intact.
- Following copy review, the choice dialog is titled `Open your dataset with an adapter`; the landing chip remains `Other formats`.
- AI creation directly opens the folder picker or reuses an already selected folder, then closes the dialog and starts the existing authoring screen. The separate sensor-setup component, route, and tests were removed. Valid sensor defaults are inferred; an unknown or unusable inferred layout uses the existing unspecified-configuration state. Optional corrections remain in the existing Edit control, with recoverable inline errors for invalid edits.
- The creation option now says `Use the in-app browser in the Codex desktop app.` Codex is the locally verified environment; this wording does not claim that the separate ChatGPT desktop app supports the same flow. Recipe reuse remains available without a browser tool host.
- File-picker cancellation leaves the choice dialog open and resets the pending selection purpose. Canceling a pending scan prevents later handoff. The chip isolates keyboard events from viewer shortcuts that otherwise blur buttons and break native keyboard activation.

Final validation on September 11:

- `npm run build` passed with the existing large-bundle advisory; `npm run lint` passed with 0 errors and 64 existing warnings.
- `npm test -- --pool=forks --maxWorkers=2`: 102 files and 1,138 tests passed. `git diff --check` passed.
- Browser checks verified the fourth chip, keyboard tooltip and dismissal, keyboard dialog activation, one-dialog recipe import navigation, and a narrow choice-dialog layout. The temporary viewport override was reset.
- In a separate background QA tab, selecting a synthetic LiDAR folder reached the authoring screen immediately with inferred sensor values, zero open dialogs, and no sensor-confirmation screen. A folder without recognizable sensors also entered directly. An invalid manual edit stayed recoverable, and a corrected count saved successfully.
- No live agent generation, external publication, or deployment was performed. The user's current preview remains available for review.

## Next work from spec 015

| Order | Work | Completion evidence |
|---|---|---|
| 1 | Preserve the failure and correction | Dataset identity, frame range, relevant app/runtime revision, adapter revisions where available, human feedback, and before/after evidence refer to the same case. Identify any missing artifacts rather than reconstructing them silently. |
| 2 | Make one public example accessible | A new visitor can find Teachable Lens and open an interactive result from a reviewed adapter in a clean ordinary browser. The data and recipe are reachable without the author's local files or saved browser state. |
| 3 | Exercise the live core loop | In a compatible agent host, a new person can start the sample, inspect a revision, request a correction, approve/save, and reuse the adapter. Check another compatible sequence as well as reopening the same folder. |
| 4 | Get initial review feedback | Observe a few first-time reviewers using the current interface. Record what they inspect, where they hesitate, which errors they miss, and how much help they need. Use this to choose one focused review-view improvement. |
| 5 | Publish the LinkedIn announcement | The existing demo and a verified experience link support a clear invitation to try the tool and discuss review problems. A new video and the paper are not prerequisites. |
| 6 | Develop the paper alongside the product work | A complete manuscript explains the system, the documented failures and corrections, reuse evidence, limitations, and the still-open review question. Publish only claims supported by the retained evidence. |

For an ordinary browser, a prepared interactive result can provide immediate access. The recorded review example can explain how the adapter was corrected; label it as recorded. Live agent authoring has its own host requirements. These paths should be described clearly at entry.

The public UX completion target does not require solving every review-design question first. It requires a usable journey and enough observation to identify where the review still imposes work on people.

For analytics, follow spec 015's stage events so authored-scene loads and review completion can be measured. Use counts of attempts and outcomes, not unsupported claims about unique people or trust. Keep private filenames and free-text feedback out of analytics.

## Publication and event follow-through

- Start a short manuscript outline and evidence inventory while completing the demo. A 4-to-6-page initial draft is a working target, not an arXiv length requirement.
- arXiv expects complete article drafts and typically does not accept demo abstracts, slides, or very short work. The talk's open question can motivate the article, while the implemented system and documented observations provide its substance. [arXiv content policy](https://info.arxiv.org/help/policies/content-types.html), rechecked September 10.
- Initial usability observations are for product learning. If they will become research data, establish the applicable participant-consent and research-review requirements before collecting that data; follow the evidence distinctions in spec 015.
- Preserve the five-minute outline and existing clip now. Prepare final presentation materials once the organizers respond.
- The earlier VISxGenAI late-contribution inquiry remains optional and unsent. It should not block the public experience or manuscript.
- No recurring monitoring, outbound messages, LinkedIn publication, software release, or paper submission was performed by the assistant in this follow-up.


## Spec 021 hosted teaching sample and local ZIP alternative

The user approved two paths for the complete PandaSet 001 log: **Teach PandaSet**
opens a hosted source directly in authoring; **Download ZIP (439 MB)** links to
the full release archive with an unzip-and-drop hint. Both contain all 80 frames.
The new preset supplies original data and a transport catalog, with no adapter
recipe. Existing preset wording/actions and local loading controls remain.

- Added a catalog-backed remote inventory using the existing inspection,
  binding, validation, and review interfaces. Entry reads the catalog only.
- Added no-agent guidance, abort/retry handling, and source-aware teaching copy.
  Choosing a different path cancels pending entry; the authoring session owns
  the source after handoff. Revocation clears the remote capability/cache.
- Found all 744 data/license files already hosted at `data.egolens.org/pandaset/001/`.
  Their sizes and MD5 hashes matched the independently SHA-256-verified ZIP
  extraction. Uploaded only README.txt and source-catalog.json with immutable
  copy operations, leaving the existing catalog.json and dataset files intact.
- The sample uses verified whole-file GETs because the existing host does not
  expose Content-Range to browsers. Partial readers receive a slice only after
  the complete requested file passes its SHA-256 check. Other remote consumers
  retain their existing Range behavior and limits. The sample's cumulative
  transfer budget is 4 GiB because its raw files total about 875 MB.
- Browser QA verified remote entry, actual LiDAR byte/schema inspection and
  timestamp reading, the full ZIP's local folder recognition, and desktop/mobile
  layouts. No PandaSet adapter was created or finalized in the QA session.
- Final validation: 104 Vitest files / 1,160 tests; seven staging-script tests;
  production build; lint with zero errors and 64 existing warnings.

The sample host is ready; application changes are local, pending a separate
application deployment phase. See [hosting and verification runbook](PANDASET_SAMPLE_HOSTING.md)
for exact source identity, public paths, and repeatable preparation commands.

### Hosted sample re-entry correction (September 11)

The user reported that reopening PandaSet after sealing an adapter showed the
unknown-format introduction again. The preset did not query saved recipes, and
the App entry handler always cleared the recognized-recipe list. Re-entry now
looks up sealed adapters using catalog path/extension metadata and preserves
those matches through the entry handler. The existing recognized-format screen
offers **Render now**; an unmatched source still opens the teaching introduction.
Explicit AI-creation actions continue to start fresh. Cancellation covers the
lookup, and lookup failures remain retryable instead of becoming false misses.

Verification: 53 tests across the hosted preset, remote inventory, adapter entry,
and authoring suites passed, including sealing a synthetic remote recipe and
recognizing it after reopening with only a catalog request. In a separate browser
QA tab, the actual saved **Six-camera driving log** appeared with eight
capabilities and **Render now**. Build and lint passed (zero lint errors, 64
existing warnings); `git diff --check` passed. Application deployment remains
separate from this local correction.
