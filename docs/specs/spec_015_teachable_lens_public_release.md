# Spec 015 — Teachable Lens: public experience, VIS talk, and citable research

**Status**: in-progress · **Date**: 2026-09-10

Research and proposed execution plan. Based on repository revision `0a9bf37`, a read-only inspection of the live homepage, the challenge documentation, and the official sources linked below. This document does not record a completed product release, submission, or publication.

**Relationship**: builds on specs 006 and 014. It preserves the 2026-09-02 decision that useful human–agent collaboration is the objective. It does not reinstate the suspended blind-authoring/exact-parity gate.

## Intended outcome

Turn the WebMCP Challenge contribution into a coherent public research artifact:

1. A first-time visitor understands what was added, experiences it, and can reach a useful result.
2. A person can teach a supported-by-the-runtime but previously unrecognized layout, review the render, correct it, and reuse the resulting adapter.
3. A recipient can use a learned format without repeating the authoring session.
4. LinkedIn brings people to that experience and invites useful feedback.
5. A VIS presentation introduces the design problem to visualization researchers and practitioners.
6. A self-contained paper and an archived software release make the work attributable and citable.

Proposed research framing:

> **Teachable Lens: Human-Guided Dataset Adaptation for Browser-Based 3D Visualization**

The central contribution to investigate is the combination of a constrained adapter language, agent access to the application's data boundary, visual human review, and a portable artifact. A reviewer should be able to follow the complete chain from unfamiliar data to corrected rendering to reuse.

## What exists, and what remains unproven

| Area | Evidence found | Implication |
|---|---|---|
| Five WebMCP tools | `src/teachable/authoring/webMcp.ts`; all five were advertised by the live page | The extension surface exists. |
| Authoring and review | `TeachableLensPanel.tsx`: setup, teaching, review, sealed stages; production viewer docking in `App.tsx` | Reuse the existing flow; this is not a proposal to rebuild it. |
| Persistence and export | Sealed screen exposes render, JSON export/import, URL import, and saved-format reuse | Verify these with someone who has not built the app. |
| Public homepage | Live page showed nuScenes/AV2 presets, a three-dataset selector, and local-folder instructions naming the three built-ins | The new capability is effectively undiscoverable before an unknown-folder drop. |
| Public teaching sample | README links to 32 MB / 6-frame and 439 MB / 80-frame archives | Download → unzip → use a compatible agent host is substantial first-visit friction. |
| Portable sharing | Descriptor/catalog/recipe transport and hash verification exist | A recipient needs accessible data as well as the recipe. Exporting a recipe cannot give access to the author's local folder. |
| Finalized local result | Sealed UI offers export and render; Share View is restricted to URL-backed data | Add clear next steps for local recipe sharing and public demo sharing, rather than promising a universal local-data link. |
| Host detection | `agentDetection.ts` mostly detects API objects and host hints | API availability does not prove that an agent is attached and ready to execute. Show readiness separately from tool exposure. |
| Analytics | No GA4 tracking calls found in the authoring/review/share modules. Authored and portable-share load entry points do not call `trackDatasetLoad` | The existing load funnel does not measure the new UX reliably. A successful render can lack a matching load/success pair. |
| Generalization evidence | A2D2, KITTI Raw, PandaSet are documented development cases | Useful feasibility evidence; not a controlled comparison or proof of arbitrary-format support. |

Implementation references: [challenge record](../WEBMCP_CHALLENGE.md), [README](../../README.md), [review UI](../../src/components/TeachableLens/TeachableLensPanel.tsx), [host detection](../../src/teachable/authoring/agentDetection.ts), [app entry points](../../src/App.tsx), [scene loading](../../src/stores/useSceneStore.ts), [inspection outputs](../../src/teachable/authoring/inspection.ts), [development run log](../SPEC014_IMPLEMENTATION_HANDOFF.md).

This was a source and entry-page audit. It did not rerun full authoring, cold-browser sharing, or the existing performance/conformance suite.

## Close the public UX loop

The intended journey is:

```text
Discover Teachable Lens
  → choose a small sample or own dataset
  → understand what the app does not know
  → agent proposes an adapter
  → inspect the rendered scene and flag a concrete problem
  → agent revises
  → accept and save the adapter
  → reopen another compatible sequence / hand the adapter to another person
```

### Entry paths

| Visitor | Entry | Completion |
|---|---|---|
| Ordinary browser, no agent | Open a small public dataset using a published learned recipe | Interactive scene, clear explanation that this format was added through a recipe, visible path to teaching. No account or local archive required for this result-viewing path. |
| Ordinary browser, wants to understand review | Optional guided review of recorded revisions, explicitly labeled as a recorded example | Visitor identifies the misalignment, compares the correction, and sees the saved result. This is not reported as live AI authoring. |
| Compatible agent host | Start a teaching sample, confirm layout, copy the prompt, review live revisions | Finalize → render → export → reuse on another sequence. |
| Own local dataset | Select folder and follow the live teaching flow | Saved adapter plus an honest unsupported-reader/operator diagnostic when the runtime cannot express the format. |

Opening a finished result alone does not demonstrate the teaching loop. The live path must also be executable by a new user. Conversely, a recorded walkthrough must not impersonate a fresh agent run. A live agent inside every ordinary browser would require a separate model/authentication/cost design; WebMCP tool registration by itself does not provide that agent.

Current Chrome documentation offers WebMCP through an origin trial from Chrome 149 and a local testing flag. The current WebMCP specification is a Community Group draft, not a W3C standard. Therefore public copy should name verified environments and offer a useful fallback rather than assume universal agent availability. [Chrome documentation](https://developer.chrome.com/docs/ai/webmcp), [WebMCP draft](https://webmachinelearning.github.io/webmcp/).

### P0 release acceptance criteria

These are proposed acceptance targets, not measurements already achieved.

- The homepage explains the new capability and offers an obvious Teachable Lens action. The visitor does not need to discover the README first.
- A small, licensed public sample and a reviewed recipe open in a clean ordinary browser. Show progress, a recoverable error, and an alternative if graphics support is unavailable.
- The live teaching entry supplies one sample, a concise prompt, host-readiness guidance, and an explanation of what happens next. Prefer the existing 6-frame sample for the initial trial; measure whether it needs to be smaller.
- One fresh person completes a real correction cycle: review a wrong result → submit an issue → receive a revision → accept → finalize. Retain the actual sequence, not only the successful ending.
- Reloading and reopening compatible data uses the saved recipe. A second sequence is tested separately from reopening the identical source.
- A second clean browser renders the public sample using its public descriptor/data/recipe. It must not rely on the author's IndexedDB, filesystem, or localhost service.
- Local data uses “Export adapter” / “Use this adapter with your own files”; public samples may use “Copy demo link.” The UI explains the distinction at the point of sharing.
- First-time users can stop, recover from a failed revision, or restart without losing the selected-folder context unnecessarily.
- Public copy states the data boundary accurately: file processing is in the browser and EgoLens does not require a bulk dataset upload; bounded file contents and metadata are returned to the chosen agent host. Do not claim that no data of any kind can leave the browser.

### Minimum instrumentation

Capture stage transitions once per attempt, plus a final attempt summary. Suggested events: `teachable_start`, `teachable_agent_first_call`, `teachable_preview_ready`, `teachable_review`, `teachable_finalize`, `teachable_export`, `teachable_reuse`, and `teachable_recipient_ready`.

Use low-cardinality fields: `experience_mode` (prepared result / recorded review / live teaching), `entry_source`, host capability state, app version, outcome, and rejection/error category. Keep private paths, user-provided dataset names, inspection text, and free-form review notes out of analytics. Do not register per-attempt IDs or recipe hashes as GA4 custom dimensions.

The current random client ID prevents reliable person-level retention. Report attempt completion, time to first preview, correction rounds, saves, reuse attempts, and recipient renders as distinct measures. Instrument authored and portable-share loads explicitly; do not infer teaching completion from `engagedSessions` or `dataset_load_success` alone. Register the necessary custom dimensions before the public release.

## VIS 2026 opportunities as of September 10

| Route | Verified position | Recommended action |
|---|---|---|
| **CLUSTER Practitioners’ Summit** | Five-minute lightning talk; application deadline **September 14**; event **November 11**, Boston, in person | Immediate priority. Submit a practice-driven problem/lesson abstract. |
| **VISxGenAI** | Strong fit for human–agent collaboration and agent-augmented VIS. Short paper deadline **August 15**; separate challenge deadline **August 31**; workshop **November 9** | Regular calls are closed. Ask whether a late, non-archival demo/lightning contribution is possible. This is an inquiry, not an advertised open track. |
| VIS main short papers | Four content pages plus one references page; deadline **April 30** | Closed for 2026. Do not make this the current publication dependency. |
| VIS meetups | Community page lists rolling proposals through **September 25**, subject to resources | Backup only if there is a real discussion group to convene. It is organizing a meetup, not obtaining an accepted paper or an individual lightning slot. |

Sources: [CLUSTER](https://cluster-practitioners-summit.github.io/), [lightning application form](https://docs.google.com/forms/d/e/1FAIpQLSfSrCO17K_nqLKonilL3zvPUI403C1DHd_QMiFMAxxdzBuXjw/viewform), [VISxGenAI CFP](https://visxgenai.github.io/), [VIS short papers](https://ieeevis.org/year/2026/info/call-participation/shortpapers/), [VIS community](https://list.ieeevis.org/year/2026/info/community/community/).

CLUSTER prioritizes concrete unresolved challenges and lessons from practice. Its website distinguishes promotional product demos through a sponsorship option. The ordinary proposal should discuss verification failures and useful design lessons. Acceptance, publication, and sponsorship are different matters; do not describe a submitted or accepted lightning talk as a peer-reviewed paper. The application asks for names, affiliations/roles, title, abstract, one-sentence summary, and optional URLs. The public page does not specify a deadline timezone; aim to submit by September 13 Pacific time.

VISxGenAI's published invitation to posters/demos/lightning talks applies to accepted submissions. Its October 1 camera-ready date is not a new-submission deadline. Its AgenticVIS Challenge is a separate task involving generated visual reports; the existing WebMCP Challenge submission is not an entry to that competition. Contact: `visxgenai@ieeevis.org`.

For travel planning, the official registration page lists early registration through **September 25 AoE**. Boston one-day rates are **$289 IEEE member / $349 non-member**, and two-day rates **$369 / $449**; travel and accommodation are additional. Wednesday registration includes CLUSTER and the banquet. Workshop presenters are not automatically required to buy full-conference registration. Check which days a two-day pass covers before combining November 9 and 11. [Registration](https://ieeevis.org/year/2026/info/registration-and-travel/conference-registration/).

### Ready-to-review CLUSTER proposal

**Title**: When a 3D Viewer Says “Valid” but the Scene Is Wrong

**TL;DR**: Lessons from teaching a browser-based 3D viewer new dataset formats with an AI agent, and making visually plausible mistakes visible to the person who must approve them.

**Abstract**:

Adding a new driving-data format to a visualization tool often becomes a custom loader project. In building EgoLens, I explored a workflow where an agent inspects selected files through WebMCP and proposes a declarative adapter, while a person reviews the resulting 3D scene. The difficult part was deciding when the adapter was correct. During development, recipes could pass structural checks while omitting sensors, placing point clouds in the wrong coordinate frame, or misaligning moving boxes. This talk shares three practical lessons: ask the user to confirm the expected sensor layout, bring the production renderer into the review loop, and make the reviewed adapter reusable beyond the current session. I will use a short correction example to discuss an unresolved question: how can visualization tools help people verify agent-authored data interpretations without requiring them to become format or calibration experts?

**Links**: https://egolens.org and https://github.com/egolens/egolens. Add a verified short correction clip before submission if available.

**Name / affiliation**: confirm preferred professional name and affiliation at submission. “Creator of EgoLens / independent developer” is a possible role description, not an assertion about employer sponsorship.

**Five-minute outline**: 40 seconds on the data-format problem; 80 seconds on one wrong-but-plausible rendering; 100 seconds on review → correction → reuse; 60 seconds on design lessons; 20 seconds on the open question and public artifact.

### Ready-to-review VISxGenAI inquiry

**To**: visxgenai@ieeevis.org\
**Subject**: Late demo or lightning contribution inquiry — Teachable Lens

Hello VISxGenAI organizers,

I realize the regular submission deadlines have passed. I recently built Teachable Lens for EgoLens, a browser-based 3D perception viewer, during the WebMCP Challenge. An agent proposes declarative dataset adapters through page tools, and the user reviews the rendered scene, requests corrections, and saves a reusable adapter.

The work exposed a useful human–agent collaboration problem: a recipe can pass structural validation while still omitting sensors or producing a visually incorrect coordinate interpretation. I would like to share this experience and the review workflow with the workshop community.

Would there be room for a late, non-archival demo or short lightning contribution? I can provide a concise technical summary and a short recorded demonstration. I understand that a regular reviewed-paper submission may no longer be possible.

Project: https://egolens.org\
Code: https://github.com/egolens/egolens

Best,\
Heejae Kim

This is a local draft; no message has been sent.

## Publication and citation route

The intended repository is **arXiv**. It provides a persistent paper identity and DOI; it is not peer review. Registration, possible endorsement, subject fit, and moderation apply. A paper can be updated as a new version rather than resubmitted under a new identity. [Submission overview](https://info.arxiv.org/help/submit/index.html), [endorsement](https://info.arxiv.org/help/endorsement.html), [moderation](https://info.arxiv.org/help/moderation/index.html), [arXiv DOI announcement](https://blog.arxiv.org/2022/02/17/new-arxiv-articles-are-now-automatically-assigned-dois/).

**Recommended deliverable: a 4–6 page self-contained systems paper, plus references as needed.** This length is a planning choice, not an arXiv page requirement or an acceptance guarantee. arXiv explicitly lists demo abstracts, presentation slides, and very short work among types it typically does not accept. The paper needs original technical content and results, not a reformatted LinkedIn announcement. [Content policy](https://info.arxiv.org/help/policies/content-types.html).

Provisional category: `cs.HC`, because the contribution centers on the human–agent review interaction; `cs.GR` may be relevant as a secondary category if the final technical content warrants it. Choose based on the finished manuscript and arXiv's classification rules. [Category taxonomy](https://arxiv.org/category_taxonomy).

Publish an independently citable **software release on Zenodo** as well. Give it a version, license, authors, release notes, and `CITATION.cff`; link the eventual paper and software records. Use the version DOI for a reproducible experiment and the concept DOI when referring to the evolving project. This gives the software a citation route even if the manuscript needs more time. [GitHub citation guide](https://docs.github.com/en/repositories/archiving-a-github-repository/referencing-and-citing-content), [Zenodo software guide](https://help.zenodo.org/docs/github/), [DOI versioning](https://zenodo.org/help/versioning).

### Paper structure

1. **Problem and scope**: heterogeneous driving data, custom-loader burden, and the difficulty of checking semantic correctness.
2. **System**: selected-file inventory → WebMCP tools → declarative recipe → constrained runtime → normalized scene → renderer. Explain what can and cannot be expressed.
3. **Interaction**: confirmed sensor contract, rendered review, explicit correction, human acceptance, and portable reuse.
4. **Evidence**: development case studies and a small reproducible rerun on the release candidate, clearly separated.
5. **Failure analysis**: missing sensors, incorrect coordinate/heading conventions, and repeated diagnostics. Describe what automation checks and what the reviewer still has to judge.
6. **Limitations and implications**: runtime vocabulary, agent/host dependence, reviewer expertise, sample coverage, and data boundaries.

Use two central figures: one full workflow with a correction cycle; one real before/after scene pair showing the issue. Add a compact table identifying datasets, source variants, supported capabilities, revisions, human interventions, runtime changes, and reuse outcome.

### Evidence that must not be conflated

- The run log explicitly says Claude acted as operator/reviewer in the early A2D2, KITTI Raw, and PandaSet development runs. They are not three independent human-user studies.
- “Three turns” is not “three tool calls” or “three recipe revisions.” One PandaSet turn included 41 failed revisions. Do not publish the shorter number as an overall effort measure.
- The unfamiliar-dataset work included generic reader/operator additions and runtime fixes between attempts. Describe it as co-development/feasibility evidence, not zero-maintainer-effort generalization on a frozen system.
- A specific human finding is documented on September 3: moving PandaSet cuboids did not follow LiDAR. That is a strong candidate for the talk's correction example, after its retained artifacts are checked.
- The downloadable teaching sample and an original dataset distribution are different evidence conditions. Describe any repackaging or source selection explicitly.
- A correct rendering of three sample frames is not proof that every frame or semantic output is correct.
- Small GA4 counts, city labels, and internal-looking referrers do not establish research participants, verified customer adoption, or endorsement by another organization.

Sources for these distinctions: [development log](../SPEC014_IMPLEMENTATION_HANDOFF.md), [spec 014 findings](spec_014_teachable_lens_phase10_generalization_ladder.md), [challenge record](../WEBMCP_CHALLENGE.md).

### Small evaluation that supports the actual claims

| Question | Proposed check | Record |
|---|---|---|
| Can someone finish the loop? | 3–5 formative sessions with people who did not build the app; compatible agent host | Completion, assistance needed, first-preview time, correction rounds, failure reason. This is a small usability pilot, not a statistically powered study. |
| Does visual review help? | Retain one or more real wrong-but-valid revisions; compare automated diagnostics with issues noticed in review | What was missed, who noticed it, which correction fixed it. No claim of causal improvement without an appropriate comparison. |
| Is the artifact reusable? | Reuse on a different sequence with the same layout and in a clean second browser | What changed, what was automatic, whether the data and recipe were both accessible. |
| Where does runtime coverage end? | Attempt a small set of declared cases on one recorded release commit | All failures and any operator changes; avoid selecting only successes. |

For the first paper, descriptive results and transparent limitations are preferable to inventing a benchmark win. Record browser, agent/model, commit, sample identity, recipe hashes, reviewer type, and intervention counts. If participant sessions become publication evidence, obtain appropriate consent and determine the applicable ethics-review requirements before collecting that research data. Material use of AI in the work/manuscript must be described, and authors remain responsible for the content. [IEEE VIS submission guidance](https://ieeevis.org/year/2026/info/call-participation/paper-submission-guidelines/), [arXiv moderation policy](https://info.arxiv.org/help/moderation/index.html).

### Related work to read and position against

This is a targeted starting bibliography, not a systematic literature review or a claim of priority.

| Work | Relevant overlap | Teachable Lens angle to test |
|---|---|---|
| [Data Formulator 2, CHI 2025](https://www.microsoft.com/en-us/research/publication/data-formulator-2-iteratively-creating-rich-visualizations-with-ai/) | UI + language for iterative visualization/data transformation | Persistent input-format adaptation and spatial/sensor correctness in a 3D viewer. |
| [DynaVis, CHI 2024](https://arxiv.org/abs/2401.10880) | Natural language plus persistent interaction widgets and immediate feedback | A reusable data reader is the artifact; review changes the interpretation of source data. |
| [Vega-Lite, 2017](https://vis.mit.edu/pubs/vega-lite/) | Declarative visualization and interaction semantics | Describe the recipe as a constrained data/scene interpretation language; JSON alone is not the novelty. |
| [Foxglove custom data loaders](https://docs.foxglove.dev/docs/extensions/guides/create-data-loader) | Custom-format extensions running as WASM in the browser | Compare programmer-authored loaders with bounded recipe authoring and visual approval. Foxglove also supports local custom formats; do not claim it necessarily needs conversion or a desktop-only workflow. |
| [WebMCP draft](https://webmachinelearning.github.io/webmcp/) | Shared page context and application tools for agents | WebMCP is infrastructure. The application-level review and reuse design is the proposed contribution. |

## LinkedIn release package

Use a short clip that shows a visible error, a human correction request, the revised scene, and reuse. Link directly to the new public experience once verified. Use one primary call to action: try the example and explain where the review becomes confusing. A separate later post can announce the paper with its actual identifier.

**Draft, for use after the linked experience is ready:**

> I built a way to teach EgoLens a new driving-data format with WebMCP.
>
> You select a dataset folder. An agent inspects its structure and proposes an adapter. EgoLens renders it, and you review the point cloud, cameras, and annotations. If something is misaligned, your feedback becomes the next revision. The accepted adapter can be saved and reused.
>
> One lesson from building this: a recipe can pass validation and still put the scene in the wrong coordinate frame. Seeing the actual rendering—and giving the person a way to correct it—became central to the design.
>
> The adapter is declarative JSON executed by EgoLens's existing readers and operators. Dataset processing runs in the browser; the agent receives bounded inspection results. New encodings can still require additional runtime support.
>
> I built this extension during the WebMCP Challenge and explored it with A2D2, KITTI Raw, and PandaSet.
>
> Try the example: [insert verified Teachable Lens experience link]
>
> If you work with unfamiliar sensor data, I'd value your feedback: what would you need to see before trusting an adapter like this?

Do not publish the placeholder, imply an arXiv/VIS acceptance before it exists, or describe prepared playback as a live teaching run. Validate the “saved and reused” demonstration against the release candidate before recording it.

## Action items and proposed sequence

Dates below are targets for this work, except where identified as organizer deadlines. Estimates assume focused work and may move after the fresh-user audit.

| Priority | Target | Action | Done when |
|---|---|---|---|
| P0 | Sep 10–13 | Review the CLUSTER proposal and submit before the **Sep 14 organizer deadline** | User-approved identity/abstract and a submission receipt. Product completion is not a prerequisite. |
| P0 | Sep 10–13 | Send the VISxGenAI late-demo inquiry | User-approved message sent; response determines whether any late route exists. |
| P0 | Sep 10–11 | Choose one public sample, final recipe, and one correction example | Data/recipe reachable, source variant documented, relevant reuse verified. |
| P0 | Sep 11–15 | Add public entry and separate result-viewing/live-teaching paths | A new visitor can discover the feature, choose a path, and understand host requirements. |
| P0 | Sep 11–15 | Verify teaching → review → correction → save → second-sequence reuse → recipient render | Recorded end-to-end outcomes on the release candidate, including recoverable failure. |
| P0 | Before public post | Instrument the teaching funnel and load entry points | Live vs prepared/replayed attempts distinguishable; metrics confirmed with a small controlled run. |
| P1 | Sep 15–18 | Formative usability checks and focused fixes | Small session record, remaining blockers, verified working public link. |
| P1 | After UX gate | Publish the LinkedIn clip and direct demo link | User-approved post and a functional destination. |
| P1 | Sep 15–22 | Turn existing logs into a claim/evidence table; perform the small release rerun | Runtime changes and agent/human roles disclosed; outcomes supported by retained artifacts. |
| P1 | Sep 15–22 | Draft the systems paper and archive a software release with citation metadata | Complete manuscript draft; release identified independently of the moving main branch. |
| P1 | Before arXiv submission | Confirm author list, affiliation, category, endorsement, references, and final source package | Manuscript ready for the author's final review/submission; eventual identifier added only after announcement. |
| P1 | By Sep 25 if attending | Choose VIS attendance days and registration | Travel/attendance decision informed by talk outcome and official fees. |
| P2 | Before Nov 11 if accepted | Rehearse the five-minute talk with an offline clip backup | Clear problem, one correction case, reusable outcome, and one discussion question within time. |

**Immediate order**: protect the September 14 talk opportunity; close one public experience; use its evidence and visuals for the post and manuscript. The paper and software archive can proceed independently of a late workshop decision.

## Decisions still needed at execution time

- Whether Boston attendance on November 11 is feasible, and the preferred affiliation/role for the application.
- Which retained correction example is strongest and which public sample is easiest to redistribute and load.
- Whether the first general-browser release includes a recorded review exercise, or only an interactive result plus the live teaching path in compatible hosts.
- Whether “live teaching in every ordinary browser” is a subsequent product requirement; that would add an agent-service/authentication/cost decision.
- Author list, arXiv endorsement status, and whether participant feedback will be included as research evidence.

No outbound messages, application submissions, account connections, paid registrations, LinkedIn posts, or archive uploads were performed during this research task.
