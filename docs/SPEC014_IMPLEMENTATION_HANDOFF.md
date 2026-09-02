# Spec 014 implementation handoff

Status: **active, PR A trust hardening implemented and validated locally; not yet committed, not merged**  
Snapshot: 2026-09-02 02:00 PDT (America/Los_Angeles)

This is the continuation source of truth for the unfinished Spec 014 work in
this checkout. It deliberately distinguishes historical green results from the
current uncommitted tree. Update this document when a blocker is closed or the
branch/PR topology changes.

## Resume in one minute

1. Work in `/Users/heejaekim/Workspace/waymo-perception-studio` on
   `codex/spec014-p7-baseline-freeze`.
2. Read this document and
   `docs/specs/spec_014_teachable_lens_phase10_generalization_ladder.md` in full.
3. Preserve every tracked and untracked change. Do **not** reset, clean, stash,
   or overwrite the shared worktree.
4. Keep PR #34 Draft. Its current title/body describe evidence that is not valid
   for the present uncommitted tree; a replacement title/body draft is in
   [PR A title and body](#pr-a-title-and-body).
5. Held-out A2D2, KITTI Raw, ONCE, and PandaSet bytes may be opened for collaborative authoring sessions (direction change 2026-09-02; see Spec 014).
6. The six blockers in [Required next work](#required-next-work) are closed in
   the working tree (see [Blocker status](#blocker-status-2026-09-02)). What
   remains is a final human review of the whole diff, the commit, the push,
   and the PR #34 rewrite.

Suggested prompt for the next session:

> Read `docs/SPEC014_IMPLEMENTATION_HANDOFF.md` completely. PR A's blockers are
> closed in the dirty worktree and the validation matrix is green. Review the
> whole diff, then (with the owner's go-ahead) commit it as one PR A head, push,
> and rewrite PR #34's title/body from the draft in the handoff. Do not discard
> changes, open held-out dataset bytes, run counted evidence from a dirty tree,
> mark PR #34 ready, or merge it.

## Goal and current position

The goal is full Spec 014 completion: an unknown supported dataset should be
inspectable through the content-blind author boundary, produce an adapter recipe,
and then pass the held-out generalization ladder.

We are **not at a valid P7 baseline freeze yet**. The current position is the
trust/tooling hardening that must precede a new exact-head P7 evidence run:

```text
PR A: verifier/tooling/security hardening (current work)
  -> merge PR A
  -> PR B from merged main: exact-head three-dataset P7 evidence and freeze
  -> merge PR B
  -> only then open held-out bytes and execute the Phase 10 ladder
```

The current PR must become PR A. Do not combine PR A's self-modifying verifier
implementation with its supposedly trusted P7 evidence: a same-PR trust anchor
would be circular.

## Git and PR snapshot

| Item | Snapshot value |
| --- | --- |
| Branch | `codex/spec014-p7-baseline-freeze` |
| Local HEAD | `dc208e4c8ddec847344b12613cfd92aa1b5a1a72` |
| `origin/main` | `eccf266b3abd0cd3a3d9792527ba65fce3e6b661` |
| Ancestry | `origin/main` is an ancestor of local HEAD |
| Pull request | [#34](https://github.com/egolens/egolens/pull/34) |
| PR state | Open, Draft, reported mergeable |
| Current PR title | `feat: freeze Spec 014 shipped-dataset baseline` |
| Dirty tracked files | 52 modified |
| Untracked paths | 23 before this handoff file |
| Dirty diff | about 6,151 insertions and 563 deletions before this file |
| `git diff --check` | Passed at this snapshot |

The remote checks apply only to committed HEAD `dc208e4...`, not to the current
dirty tree. At this snapshot, ordinary CI and the old Phase 6 judge were green,
while the Phase 9 judge was skipped. None establishes that the current changes
are ready.

PR #34's current body claims a 9/9 recorder matrix, a frozen baseline, and other
exact-candidate evidence. Treat that body as stale. Before Ready-for-review, use
a trust-hardening title such as `feat: harden Spec 014 P7 evidence boundaries`
and list only validations actually rerun against the eventual committed head.

## Non-negotiable safety and evidence invariants

- Keep the PR Draft until all blockers, tests, and a whole-diff review are done.
- Do not merge the current PR without review.
- Never run real counted Phase 9 authoring or Phase 10 P7 evidence against a
  dirty worktree. The coordinator intentionally requires a clean exact commit.
- Keep the verifier checkout, candidate checkout, trust manifest, datasets,
  protected oracle material, capture configs, receipts, and evidence outputs in
  their required mutually disjoint roots.
- Never commit raw dataset bytes, protected traces, oracle inputs, private keys,
  auth tokens, browser profiles, source manifests, or owner-only trust material.
- Keep the held-out A2D2, KITTI Raw, ONCE, and PandaSet bytes unopened until the
  P7 baseline PR has merged. File names alone are not authorization to inspect
  contents.
- Public artifacts may expose commitments and signed receipts only where the
  schemas/runbooks permit them; local paths and protected source details stay
  private.

## External shipped-dataset inputs on this Mac

The prepared APFS clones still exist at:

`/private/tmp/egolens-spec014-preflight.eKHSlD`

They are ephemeral local inputs, not repository content. A cloud session will
not have them. Verify the root still exists and preserve its permissions before
using it.

| Dataset | Source root | Snapshot size | Files |
| --- | --- | ---: | ---: |
| Waymo | `sources/waymo` | 488 MiB | 13 |
| nuScenes | `sources/nuscenes` | 5.1 GiB | 32,042 |
| Argoverse 2 | `sources/argoverse2` | 1.2 GiB | 3,039 |

The root and config directory are mode `0700`; config files are `0600`; source
directories are `0500`; source files were prepared read-only. Config commitments:

| Config | SHA-256 |
| --- | --- |
| `configs/waymo.json` | `445939b42b4edc8b9dccac4e6001289b12b12635887d3e86cd59d12505b39aa1` |
| `configs/nuscenes.json` | `8122a71c452a5745c2d4144916e4adc29ecf1ce4d89e8d0c16c0d98db8ec5e1b` |
| `configs/argoverse2.json` | `e5890da03346527228a13e6924682bd371c2dc454f70bb0f2b05eaef64a895f6` |

Do not commit this path or its contents. Recreate equivalent owner-pinned inputs
if another host must run the counted work.

Runtime observed at the snapshot:

- Node: `/Users/heejaekim/.nvm/versions/node/v25.4.0/bin/node`, v25.4.0
- Chrome: canonical Google Chrome app, `152.0.7977.66`
- macOS Seatbelt: `/usr/bin/sandbox-exec`

## Work already present in the dirty tree

The following is implementation inventory, not a current green claim.

### Phase 9 author boundary and receipt chain

- Requirements schema v2 accepts recipe hashes only through signed author
  attestation rather than a static reviewed recipe hash.
- A protected boundary report and public path-free witness bind the three
  author cases.
- Evidence staging requires exactly three protected cases and binds each signed
  receipt to its boundary case, source fingerprint, candidate, and recipe.
- Workflow ordering was changed to stage protected evidence, run privacy
  scanning, and only then publish renamed receipts.
- The macOS counted-author coordinator uses deny-default Seatbelt profiles,
  fresh roots, exact source closure, one source at a time, and exactly five
  public tools.
- Arbitrary session-scoped compiled recipes can drive Waymo, nuScenes, and AV2
  through managed scene creation, workers, conformance, and reload behavior.

### Phase 10 build and verifier trust

- Phase 6 benchmark serving snapshots `dist` into an immutable in-memory server
  and checks the disk inventory around each run.
- A mandatory external verifier trust manifest binds a clean disjoint verifier
  checkout, Node binary, exact verifier commit, and the resolved dependency
  closure.
- The reviewed build no longer installs candidate dependencies. It stages a
  `.git`-free exact source tree, rejects symlinks/non-regular files, checks
  reviewed config bytes, and builds against the verifier's dependency closure.
- Exact original Phase 6 signed receipts and their aggregate gate are carried
  through the freeze/final verification path.
- Local/share/remote source classification was corrected so inline
  `shareVersion=1` remains remote URL mode and only referenced `share=` payloads
  are portable-share mode.

### Test-gate and browser-boundary hardening in progress

- Gate CLIs no longer accept caller-supplied JSON/TAP as proof.
- Reviewed test/harness profiles, an exact Git archive, reviewed test byte
  checks, process containment, and a fixed Vitest config are present.
- The strict probe previously denied candidate-repository reads, home reads,
  verifier/staged writes, external network, and a stripped-environment detached
  Node escape, with no residual process in that probe.
- The current test-gate code now pins the dependency-closure `esbuild` binary,
  exports `ESBUILD_BINARY_PATH`, and requests a Vitest threads pool. Its actual
  end-to-end green result still needs confirmation.
- Counted Chrome now uses a deny-default Seatbelt profile, a Chrome-selected CDP
  port, exact app/source loopback allowlisting, local-source read-only access,
  active forbidden-loopback/non-loopback/file probes, and request auditing.
- Official Chrome identity code now requires the canonical executable, Google
  bundle identifier `com.google.Chrome`, Team ID `EQHXZ8M8AV`, a deep designated
  requirement check, and stable pre/post identity including CDHash. The actual
  Chrome smoke still needs confirmation.
- The range host uses a high-entropy capability path plus loopback Origin/Host
  validation.

## Blocker status (2026-09-02)

All six blockers below are implemented in the working tree and covered by
tests or a recorded local run. Items marked *scratch run* were executed from a
clean single-commit snapshot of this tree in a temporary directory (the same
technique `trustedToolFixture` uses); they are tooling validation, not counted
evidence, and their outputs were not retained.

| # | Blocker | Status |
| --- | --- | --- |
| 1 | Judge checkout binding | Done. `judgeToolCommit` + `judgeVersion = spec013-phase9-v1` are signed by the judge, required by the gate, workflow, Phase 10 binding, freeze semantics, and freeze schema; the Phase 10 binding requires `judgeToolCommit === verifierToolCommit`. Tests reject a dirty judge checkout, a mismatched pin, a forged version, and a receipt from another commit. |
| 2 | Vite auto-discovery | Done. `envDir: false` and inline inert PostCSS in all three reviewed configs; `import.meta.dirname` (runner loader has no `__dirname`); adversarial test proves `.env*`, `postcss.config.*`, and `babel.config.*` cannot influence or execute. Found and fixed a further surface: the runner loader boots an internal Vite environment at `process.cwd()` and eagerly loads `postcss.config.*` from there, so the reviewed driver now runs Vite from the fresh build home with the stage as positional root (`phase10ReviewedViteBuildInvocationV1`). |
| 3 | Strict reviewed Vitest gate | Done. Negative gate passes inside `npm run test:phase10-evidence` (sandboxed, EPERM-only probes, zero residual processes). *Scratch runs*: regression gate passed under Seatbelt with 1,007 tests after excluding the WebGPU tests that can only be skipped there; harness gate passed under Seatbelt (git shim allowances, nested residual audit, documented nested-gate skip). |
| 4 | Real counted Chrome boundary | Done. `node --test scripts/phase10-counted-browser-boundary.node.mjs` passes on this Mac with canonical Chrome after two fixes: Seatbelt accepts only `localhost:<port>` endpoints, and Chrome's nested helper sandbox cannot initialize inside the outer profile (GPU/network services crashed and Chrome aborted), so counted Chrome now runs with `--no-sandbox` exactly like the Phase 9 broker. |
| 5 | Runbook paths | Done. `PHASE9_ADAPTER_AMNESIA.md` uses per-dataset output roots, `$EVIDENCE/<dataset>.<runId>.boundary-case.json`, and the judge pin flags; `benchmarks/phase10/README.md` gate examples now match the reviewed gate CLIs. |
| 6 | Regression matrix | Done; see fresh results below. |

Additional defects found by two review passes over the dirty tree and fixed:

- `phase10-build-boundary.mjs` staged under `/tmp`, which `realpath`s to
  `/private/tmp`, so the driver's canonical-path check failed on every run.
- Boundary probes in the test gate and build driver counted any exception or a
  timeout as a denial; they now require Seatbelt `EPERM`, and the home probe
  lists the home directory instead of a file that may not exist.
- Coordinator external-egress probes passed on an offline host and treated an
  HTTP error status as a denial; they now need an unsandboxed reachability
  control and no `-f`.
- `phase10-baseline-gate.mjs` trusted the freeze's self-hash for the
  regression/negative/harness gates; it now requires and re-verifies the three
  reports.
- `phase10-record-preflight-mode.mjs` wrote `noAgent: true` unconditionally;
  the capture API now exposes `agentActivity` (no WebMCP model context, session
  never engaged), the benchmark records it per run, and the recorder enforces
  it.
- Judge/gate/stage/attest CLIs accepted unknown or value-less flags and
  duplicate options; they are now allow-listed and strict.
- Harness Seatbelt profile could not run Apple's `/usr/bin/git` shim
  (developer-directory links, license plist, xcrun cache in the Darwin temp
  dir); the reviewed Vitest config now excludes the WebGPU tests; test snapshot
  copies keep `node_modules/.bin` symlinks verbatim.
- `/bin/ps` is set-user-ID and cannot be executed from any sandboxed process,
  so the negative gate nested inside the harness gate could not run its
  environment-token residual scan. A gate that is itself contained now audits
  its detached process group instead, only for the reviewed test profile and
  only after that run's probe proved detached re-execution is denied; the mode
  is recorded as `execution.residualAudit` (`ps-environment-scan` outside a
  containment, `process-group-nested` inside one) and the gate schemas require
  it.
- macOS also refuses to apply a second deny-default Seatbelt profile from an
  already sandboxed process (`sandbox_apply: Operation not permitted`), so the
  evidence-harness gate cannot execute the nested negative-gate test. That one
  test skips with an exact reason when the process is contained; the harness
  gate accepts exactly that skip and records `nestedNegativeGateSkipped`. The
  negative gate is always run as its own outer gate and is required by the
  freeze independently.
- Freeze schema `schemaHashes.minItems` raised to the real count; workflow
  destroy step now uses `set -euo pipefail`; `prepare-preflight` validates the
  source case against its schema.

### Residual findings not fixed (follow-ups)

- `scripts/phase10-reviewed-test.sb` lets candidate Vitest code connect to any
  loopback port, not only the ports it binds; a concurrently running
  unauthenticated local service would be reachable. Run the reviewed gates on a
  host with no other loopback listeners, or pin Vitest ports and allow only
  those.
- `scripts/phase9-counted-author-build.sb` grants the candidate author build
  read-write access to its detached `node_modules` copy while only seven
  packages are re-hashed afterwards.
- The coordinator copies `~/.codex/auth.json` into a temporary controller home
  under `/private/tmp`; a hard kill before cleanup leaves that copy behind.
- Controller children keep `sysctl-read`/`process-info*`; the broker and the
  counted browser both run Chromium with `--no-sandbox` under Seatbelt, which
  should be recorded in the policy descriptor.
- The counted-author verifier pins exact Node/Chrome/Codex versions by string;
  any auto-update makes existing protected artifacts unverifiable until the
  pins are reviewed again.
- Failure messages from the test gate can include absolute run-root paths
  (operator terminal only). `phase10-ledger.mjs` appends without a lock.
- Fixed after PR A (PR B prep): benchmark artifacts now redact every
  range-host capability (`/access/<hex>/` raw or percent-encoded) to
  `{capability}` and are written mode `0600`; `phase10-baseline-gate.mjs`
  requires `--ledger` and a matching `baseline-frozen` entry.
- Still open from the late review addendum: the CDP benchmark's
  `ambient-file-read-denied` probe passes when no attach was attempted, and
  value-less flags in `phase10-source-case-manifest.mjs` become the string
  `"true"`.

## Required next work

These were the merge blockers, in priority order. They are retained for
context; each is closed as described in [Blocker status](#blocker-status-2026-09-02).

### 1. Bind the Phase 9 judge checkout into every signed result

`PHASE9_AMNESIA_JUDGE_TOOL_COMMIT` selects the workflow checkout, but the signed
receipt/gate/Phase 10 binding still does not carry and verify that exact commit.
`phase9-oracle-judge.mjs` also accepts an arbitrary `--judge-version`; the gate
does not require the reviewed version.

Implement and test this end to end:

- Add signed `judgeToolCommit` equal to the actual clean judge checkout HEAD.
- Require exact `judgeVersion = spec013-phase9-v1`.
- Propagate both fields through receipt generation, trusted report, aggregate
  gate, schemas/fixtures, workflow invocation, staged artifacts, and Phase 10
  verification.
- In Phase 10, require `judgeToolCommit` to equal the verifier trust manifest's
  `verifierToolCommit`.
- Independently reject a dirty judge checkout, a mismatched workflow pin, a
  forged version, and a receipt made by another commit.

Useful search:

```bash
rg -n "PHASE9_AMNESIA_JUDGE_TOOL_COMMIT|judgeToolCommit|judgeVersion" \
  .github benchmarks scripts docs
```

At this snapshot there is no `judgeToolCommit` occurrence in the relevant
implementation.

### 2. Disable candidate-controlled Vite config auto-discovery

The reviewed `vite.config.ts` still lacks both controls below:

- `envDir: false`, to stop candidate `.env*` auto-loading.
- An explicit inert PostCSS configuration such as
  `css: { postcss: { plugins: [] } }`, to stop automatic discovery/execution of
  candidate `postcss.config.*`.

Add exact-byte-reviewed settings and adversarial tests proving tracked `.env`,
PostCSS config, and any other relevant build-tool auto-discovered executable
configuration cannot affect or execute during the reviewed build. Audit Vite's
remaining automatic config/plugin discovery surfaces rather than assuming these
two are exhaustive.

### 3. Re-establish the strict reviewed Vitest gate

The last observed real run before the most recent pinning edits failed with
`spawn EPERM` while `phase10NegativeGate.test.ts` caused esbuild startup. The
new esbuild path/thread-pool changes have not been recorded as green.

Run the real gate through the Phase 10 evidence tests. Confirm all reviewed test
files execute inside the intended sandbox, the negative test is not special-
cased away, escape probes remain denied, and no subprocess remains afterward.
Do not weaken Seatbelt with broad process execution to make Vitest pass.

### 4. Confirm the real counted Chrome boundary

Run `scripts/phase10-counted-browser-boundary.node.mjs` on this Mac using the
canonical installed Chrome. Confirm the source/app allowlist succeeds while
forbidden loopback, live non-loopback egress, and ambient file access fail; the
request audit is exact; the official signature identity is stable pre/post; and
Chrome leaves no residual processes. Add/fix fixtures if schema fields changed.

### 5. Make the Phase 9 runbook examples match coordinator outputs

The runbook now correctly says capture config, dataset, output, and evidence
roots are pairwise disjoint. Its examples still use static names such as
`waymo.boundary-case.json`, while the coordinator describes run-scoped output
such as `${dataset}.${runId}.boundary-case.json`. Make the commands unambiguous
and use actual per-run, per-dataset paths throughout assembly and staging.

### 6. Restore and review the complete regression matrix

After the focused blockers pass, run every validation below against the final
dirty tree, inspect failures rather than papering over them, review the entire
diff, and only then create a clean commit.

## Validation commands

Start with read-only state and integrity checks:

```bash
git status --short
git diff --check
git diff --stat
git diff -- . ':!package-lock.json'
git ls-files --others --exclude-standard
```

Focused security/evidence tests:

```bash
npm run test:adapter-amnesia
npm run test:phase10-evidence
node --test scripts/phase10-counted-browser-boundary.node.mjs
npm run test:oracle-receipts
```

Full project validation:

```bash
npm test
npm run build
npm run build:amnesia-author
npm run lint
```

Syntax-check all script modules, including untracked ones:

```bash
find scripts -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
```

Also rerun `git diff --check` after generated/formatting changes. Lint historically
had 57 pre-existing warnings and zero errors; compare against that baseline and
investigate any new warning.

## Fresh validation results (2026-09-02)

All of the following were run against the final dirty tree on this Mac
(Node v25.4.0, Chrome 152.0.7977.66 canonical, `/usr/bin/sandbox-exec`):

| Check | Result |
| --- | --- |
| `npm test` | 76 files, 1,010 tests passed |
| `npm run build` | passed |
| `npm run build:amnesia-author` | passed |
| `npm run lint` | 0 errors, 57 warnings (unchanged baseline) |
| `npm run test:adapter-amnesia` | 14/14 passed |
| `npm run test:phase10-evidence` | 16/16 passed (includes the sandboxed negative gate and the adversarial Vite test) |
| `npm run test:oracle-receipts` | 7/7 passed |
| `node --test scripts/phase10-counted-browser-boundary.node.mjs` | 1/1 passed with real Chrome, no residual processes |
| `find scripts -name '*.mjs' | xargs node --check` | all pass |
| `git diff --check` | passed |
| Scratch: `phase10-build-boundary.mjs` from a clean snapshot | passed in 15 s (production 25 files, author 4 files) |
| Scratch: `phase10-regression-gate.mjs` from a clean snapshot | passed under Seatbelt, 1,007 tests |
| Scratch: `phase10-harness-gate.mjs` from a clean snapshot | passed under Seatbelt: 16 harness tests, 15 passed + the one documented nested-gate skip, `residualAudit: ps-environment-scan` |

`npm run test:phase10-evidence` was rerun after the last fixture change and
passed again (16/16).

## Dirty-tree map

Major modified clusters:

- `.github/workflows/phase9-adapter-amnesia.yml`
- `benchmarks/oracle/` requirements/runbook and new schemas
- `benchmarks/phase10/` requirements, conformance fixtures, README, and schemas
- Specs 006, 013, and 014
- Phase 6, Phase 9, and Phase 10 evidence/judge/gate/host scripts
- `src/App.tsx`, `src/stores/useSceneStore.ts`, store tests, and
  `src/vite-env.d.ts`
- `vite.config.ts` and `package.json`

Important untracked implementation that must not be lost:

- `benchmarks/oracle/schemas/`
- `scripts/amnesia-boundary.node.mjs`
- `scripts/lib/phase9-counted-author-boundary.mjs`
- `scripts/phase9-counted-author-*` coordinator, broker, profiles, probe, tests,
  and reviewed Vite config
- `scripts/lib/phase10-build-policy.mjs`
- `scripts/lib/phase10-counted-browser-boundary.mjs`
- `scripts/lib/phase10-process-containment.mjs`
- `scripts/lib/phase10-test-gate.mjs`
- `scripts/phase10-counted-browser-*`
- `scripts/phase10-create-verifier-trust-manifest.mjs`
- `scripts/phase10-reviewed-*` build/test/harness drivers, profiles, and config

All previous helper agents stopped on usage-limit errors. Their filesystem edits
remain in this shared checkout, but there is no live helper task whose completion
should be awaited.

## Finishing PR A

1. ~~Close all six blockers above without running real counted dataset evidence.~~ Done.
2. ~~Run the complete validation matrix and record exact fresh results.~~ Done.
3. Two read-only review passes covered the dirty tree for fail-open behavior,
   path leakage, secret leakage, schema/fixture drift, and CLI/runbook parity;
   their findings are fixed or listed under residual findings. A human review
   of the whole diff is still expected before commit.
4. Commit the reviewed trust/tooling changes as one coherent PR A head and push.
5. Rewrite PR #34's title/body so it claims only PR A implementation and fresh
   test results. Keep it Draft until a final review says otherwise.
6. Merge PR A only after normal review/approval.

Do not include P7 freeze artifacts or claim a frozen baseline in PR A.

### PR A title and body

Title: `feat: harden Spec 014 P7 evidence boundaries`

Body outline (claim only what is listed in
[Fresh validation results](#fresh-validation-results-2026-09-02)):

- Phase 9 judge checkout binding (`judgeToolCommit`, exact
  `judgeVersion`), required end to end through gate, workflow, Phase 10
  binding, freeze semantics, and schema; judge commit must equal the verifier
  trust-manifest commit.
- Reviewed Vite configs with `envDir: false`, inert inline PostCSS, and
  `import.meta.dirname`; reviewed driver runs Vite from the build home with the
  stage as positional root; adversarial test for env/PostCSS/Babel and the cwd
  discovery surface.
- Reviewed test gate: EPERM-only probes, harness profile can run the Apple git
  shim, WebGPU tests excluded from the sandboxed suite, verbatim symlinks in
  snapshot copies.
- Counted Chrome: `localhost:<port>` Seatbelt endpoints and `--no-sandbox`
  under the outer deny-default profile.
- Build boundary `/tmp` canonicalization; baseline gate re-verifies the three
  test-gate reports; `noAgent` backed by page-level `agentActivity` evidence;
  coordinator egress probes with a reachability control; strict CLI parsers;
  runbook and README parity.
- Explicitly not included: any P7 evidence or baseline freeze; held-out bytes
  unopened.

## PR B run log

- 2026-09-02: PR A (#34) and the PR B preparation fix (#35) merged; main is
  `c1302038df0f740e149cc1b605ceba4356e663bc`. The reviewed verifier checkout
  (`PHASE10_TOOL`) and the trust manifest are pinned to that commit; its
  manifest hash is
  `sha256:42c2d82bdd2b7bad9a86ce142280e5838d7c07e665d5041319eed98c263a36df`.
  `PHASE9_AMNESIA_JUDGE_TOOL_COMMIT` must be pinned to the same commit.
- 2026-09-02: the first Waymo `run-case` failed at the coordinator's isolated
  `npm ci` (npm rejects `/dev/null` as both user and global config); fixed and
  merged as #37. The verifier and trust manifest stay pinned to `c130203`; the
  coordinator runs from the candidate checkout, which now includes the fix.
- 2026-09-02: the second Waymo `run-case` failed at the build boundary probe
  because the external egress target `93.184.216.34` no longer answers HTTP;
  the reachability control failed closed as designed. Fixed and merged as #38
  (probe `1.1.1.1` / `1.0.0.1`).
- 2026-09-02: the third Waymo `run-case` reached the isolated Codex author,
  which aborted because the controller profile denied the `/etc` symlink that
  Codex probes at startup; fixed and merged as #39 together with an explicit
  `web_search="disabled"` for the author.
- 2026-09-02: the fourth Waymo `run-case` completed its Codex session but the
  author stopped with `authoring-observability-gap` because every broker
  `/call` timed out: the bridge's invoke button sits in a 1px hidden host and
  Playwright's pointer click never reached it. Fixed and merged as #40
  (`dispatchEvent('click')`).
- 2026-09-02, candidate `c20c3d6`: the counted Waymo author session finally
  ran end to end (20 inspects, 4 contract reads, 5 transactional revisions).
  The fifth revision passed structural validation, then the headless Chrome
  renderer crashed (`Target crashed`) during graph preview sampling; the page
  never recovered and the author correctly stopped with
  `authoring-observability-gap` without exporting. **Root cause (confirmed
  outside Seatbelt with the reconstructed recipe):** the author's `lidar`
  `parquet.columns` source declares both `range_image_return1` and
  `range_image_return2` `number-list` columns (165 MB parquet); with both
  declared the preview exhausts renderer memory even when the converter uses
  one return, while either column alone previews in about 10 to 13 s. The
  declared `maxInputBytes` / `maxOutputBytes` limits did not fail closed
  before the crash, and a crashed page ends the counted session. This is a
  runtime/resource gap in the shipped authoring path, not a tooling defect:
  the reader/preview must enforce a byte budget per sampled frame (or reject
  the column set with a `RESOURCE_LIMIT` diagnostic) before materializing wide
  list columns. Reconstructed recipe and transcript:
  `~/Workspace/egolens-p7/debug-evidence/` (local, protected). Fixed and
  merged as #41: wide Parquet columns are read one at a time, a metadata
  estimate enforces a 2 GiB per-read decode ceiling before any page is read,
  and list validation no longer copies. The crashing recipe now previews.
- 2026-09-02: #36 merged the run log into main, so this branch is re-created
  from main with this commit as the PR B candidate; #42 (sparse-output
  observability, serialized broker calls), #43 (broker invoke closure), and
  #44 (controller transcript bound) are merged. Verifier and judge pin move to
  the current main head for every counted run because the reviewed author
  source list includes the changed runtime files.
- 2026-09-02 (later): #43 broker invoke closure, #44 controller transcript
  bound (64 MiB), #45 protected-local retention of the author transcript and
  broker audit (`evidence/<dataset>.<runToken>.author-transcript.txt`), and
  #46 capability-addressable human-review controls are merged. The counted
  Waymo author reached an engine-valid recipe with all ten capabilities
  validated on five frames (sparse segmentation frames 29 and 79 found via
  `OUTPUT_ABSENT_ON_SAMPLED_FRAMES`) before #46; the full apply → review →
  finalize → export path is verified through the real broker adapter.
  **Blocked:** the operator's Codex usage limit is exhausted
  (`You've hit your usage limit … try again at Sep 6th, 2026 7:39 PM`), so no
  counted author session can run until then or until credits are added.
  Resume with `~/Workspace/egolens-p7/repin-and-run-waymo.sh` (re-pins the
  verifier/judge to main, creates a fresh candidate commit, starts Waymo),
  then nuScenes and Argoverse 2 with the same candidate commit.
- 2026-09-02 (while blocked): the Phase 9-independent P7 prerequisites are
  done. Protected source-case manifests and catalogs for `waymo`
  (`waymo-open-dataset-v2.0.1`, 13 files), `nuscenes` (`nuscenes-v1.0-mini`,
  32,042 files), and `argoverse2` (`argoverse2-sensor-v2.0`, 3,039 files) were
  generated with role `D`, order `0`, `complete-official-subtree`, and every
  capability from `preflight-requirements.json`, bound to verifier `6e6d520`
  (trust manifest `sha256:aba1c081…290e0fe`). Public summaries contain no
  absolute paths. They live outside the repo under the local P7 work root
  (`protected/<dataset>/`, `public/<dataset>/`) and must be regenerated
  (delete first; creation is exclusive) if the verifier is re-pinned.
- 2026-09-02, candidate `4b98462`: the Waymo counted run passed end to end
  after #47 (`phase9-waymo-edfef07cb97a3e26`, recipe
  `sha256:7f2adfc2…0dc279`). The nuScenes counted run then stopped with
  `authoring-observability-gap`: every path-joined output (pointClouds,
  radarPointClouds, cameraImages, boxes2d, lidarSegmentation) was disabled as
  `OPTIONAL_OUTPUT_UNBOUND` while the token-joined outputs validated. **Root
  cause:** the isolated author workspace keyed its inventory by raw
  `webkitRelativePath` (`nuscenes/samples/...`) while the ordinary viewer's
  `scanSelectedFiles` drops the selected wrapper folder (`samples/...`), so
  `sample_data.filename` never matched a source path inside the author build,
  and the blind-authored recipes (including the passed Waymo recipe, which used
  `waymo/<component>/*.parquet` globs) would not bind at capture time in the
  viewer either. Fixed by sharing one canonical relative-key rule
  (`selectedFileKeys.ts`, reviewed author source) between both inputs. All
  three counted runs must be redone from a candidate that includes the fix.
- 2026-09-02, candidate `b746795` (includes #48): Waymo passed again with
  root-relative source globs (`phase9-waymo-00a31d8cd0ac9417`). The nuScenes
  author then stopped after two rejected revisions: both omitted the `poses`
  input of the relational `geometry.normalize_boxes3d` node, which the public
  contract permitted (`annotations`/`instances`/`categories` variant) but the
  implementation rejects at sample time with the bare hint
  `GRAPH_RELATIONAL_BOX_POSE_INVALID`; the author then read "transactional
  revisions" as requiring a retained candidate and gave up instead of
  resubmitting. Fixed by requiring `poses` in that contract variant (compile-time
  `OPERATOR_INPUTS_INVALID`), a descriptive sample-stage message, and an explicit
  prompt rule that a rejected revision retains no candidate and the complete
  corrected recipe must be resubmitted.
- 2026-09-02, candidate `5aaa1cd` (includes #49): Waymo passed
  (`phase9-waymo-33f451d8da4f211c`). The nuScenes author validated 9 of 10
  capabilities and stopped on `lidarSegmentation`: the public
  `labels.attach_by_point_index` contract offered only a pose-less two-input
  form (which for per-file labels can never bind, having no index) and a
  five-input form that forces panoptic inputs; the author's indexed attempt
  used the lidarseg `token` instead of `sample_data_token` and a taxonomy id
  that no `scene.taxonomies` entry declares, and every mismatch surfaced only
  as `OPTIONAL_OUTPUT_UNBOUND`. Fixed by adding the
  `pointClouds`/`labels`/`labelIndex` contract variant, failing the sample
  with `GRAPH_LABEL_INDEX_UNMATCHED` (naming both keys) when selected label
  files reach no bound point-cloud record, and a compile-time
  `TAXONOMY_UNDECLARED` diagnostic for operator taxonomy references.
- 2026-09-02, candidate `7f08fb0` (includes #50): Waymo passed
  (`phase9-waymo-268d0e208f6ae508`) and the nuScenes author completed the
  whole public flow for the first time (10/10 capabilities, 8 accepted
  reviews, finalize, one export), but the coordinator rejected the export:
  the author never declared `provenance`, the session defaulted the finalized
  artifact to `author: "imported"`, and the coordinator requires `"codex"`.
  Neither the prompt nor the public apply path had asked for it. Fixed by
  rejecting any revision without `provenance.author` at apply time
  (`PROVENANCE_AUTHOR_REQUIRED`) and stating the requirement in the author
  prompt.
- 2026-09-02, candidate `83f5168` (includes #51): all three counted author
  runs passed (`phase9-waymo-8de0a6d57aee1df7`,
  `phase9-nuscenes-5ea9121510a26be8`, `phase9-argoverse2-1ab5fbff77743018`);
  the nuScenes and Argoverse 2 authors completed the full public flow on the
  first attempt after #48–#51. `assemble-report` then rejected the three
  cases because it required every case's protected evidence root to be
  disjoint from the others', while the runbook prescribes one owner-only
  `$EVIDENCE` for the PR. Fixed in the verifier only (the shared evidence root
  is coordinator-owned; case-private mounts must still stay outside it and
  each other); the candidate and its counted artifacts are unchanged.
- 2026-09-02, candidate `19c27e8` (includes #52): the verifier's
  `verifyPolicyDescriptor` binds every boundary-case artifact to the exact
  trusted tool manifest (Seatbelt profiles, coordinator scripts and library,
  reviewed author sources) of the verifier checkout, so #52 forced all three
  counted runs to be redone. The Waymo author then stopped after three
  rejected revisions: it bound `outputs` to `<pipeline>.<node>.<output>`
  (`pc.convert.pointClouds`), which the compiler accepted and the graph kernel
  rejected at sample time with the bare `GRAPH_REFERENCE_UNRESOLVED`. Fixed by
  a compile-time `OUTPUT_BINDING_INVALID` diagnostic (outputs bind exactly
  `<pipelineId>.result`) and an unresolved-reference message that names the
  missing key, the available keys, and the reference grammar.
- 2026-09-02, candidate `c6fe467` (includes #53): all three counted runs
  passed (`phase9-waymo-ff36a54aa97e7ffe`, `phase9-nuscenes-0647a1da90ec3c0e`,
  `phase9-argoverse2-3af3d0adb5bd6097`), the boundary report assembled, and
  the build boundary reproduced. Capturing the recipes then needed two
  corrections outside the repo: the Phase 9 capture must open a served source
  (`?dataset=<id>&data=<loopback origin>&scene=<oracle scene>`; the
  `--local-source` path is the Phase 10 counted-preflight mode and demands a
  `--preflight-recipe`), and the Waymo capture rejected the authored recipe
  because its `scene.formatId` was `waymo-modular-parquet` while the capture
  installs recipes only against the active source case (`waymo`). Nothing had
  told the author that; fixed by stating it in the prompt and failing the
  coordinator's post-export check with the exact reason. All three counted
  runs are redone because the coordinator is part of the trusted tool manifest.
- 2026-09-02, candidate `fa1fa62` (includes #54): Waymo
  (`phase9-waymo-a1a43d6279d8678a`, `scene.formatId` now `waymo`) and nuScenes
  (`phase9-nuscenes-463a001688c1c649`) passed; the Argoverse 2 author stopped
  after 24 rejected revisions because the public `table-schema` inspection
  refused `.feather` files (`CAPABILITY_GAP`), so it could not learn the
  calibration and annotation column names and fell back to guessing the
  camera binding form. Earlier AV2 authors had succeeded only from prior
  knowledge of the AV2 schema. Fixed by decoding the leading Arrow IPC schema
  message from a bounded prefix (record batches are never read) and exposing
  column names, logical types, and nullability through the same inspect mode.
- 2026-09-02, candidate `ad8608d` (includes #55): all three counted runs
  passed (`phase9-waymo-27945bca87271ff7`, `phase9-nuscenes-b8502585447184e6`,
  `phase9-argoverse2-ac967e88534c5e68`), the report assembled, the build
  boundary reproduced, and the Waymo recipe was captured from a loopback-served
  source. Comparing that capture with the hidden oracle showed the real gap:
  every blind recipe collapses sensors (Waymo 1 lidar + 1 camera instead of
  5 + 5; nuScenes 1 radar + 1 camera instead of 5 + 6; AV2 1 camera instead of
  7), so capabilities validate and human review accepts while the exact
  structural/numeric parity judge can never pass. **Decision (owner):** the
  "public tools only" purity claim is not required; efficient human + Codex
  collaboration is the goal. PR B is on hold. Product loop first: the author
  workspace now asks the human to confirm the sensor layout (counts per
  modality, defaults inferred from the folder), the session publishes it in
  the public contract and rejects revisions that declare a different count
  (`SENSOR_CONFIGURATION_UNMET`), and the review panel shows declared sensors
  per modality against the confirmed layout. Feedback to the author flows
  through the Codex chat, not a new review channel. Remaining for PR B: carry
  the same layout in `phase9-requirements.json`, relax the judge on
  presentation-only fields, rerun.
- PR B's candidate commit is this branch's head at the time each counted run
  starts; the workflow uses the PR head SHA as `EXPECTED_CANDIDATE_COMMIT`, so
  Phase 9 judging must complete before any evidence commit is pushed here.

## Creating PR B after PR A merges

1. Fetch the latest `origin/main` and create a clean PR B candidate checkout
   from the merged PR A result.
2. Create a second clean, disjoint verifier checkout pinned to the exact merged
   PR A commit. Install/review its dependencies once and verify its complete
   closure.
3. Use `scripts/phase10-create-verifier-trust-manifest.mjs` to create an
   owner-approved manifest outside both repositories in an owner-only path.
   Set and independently verify both
   `PHASE10_VERIFIER_TRUST_MANIFEST` and
   `PHASE10_EXPECTED_VERIFIER_TRUST_MANIFEST_HASH`. Pin
   `PHASE9_AMNESIA_JUDGE_TOOL_COMMIT` to that same merged commit: the Phase 10
   binding rejects Phase 9 receipts whose signed `judgeToolCommit` differs from
   the verifier trust-manifest commit.
4. From the clean exact PR B candidate commit, run the real counted Phase 9
   author cases for Waymo, nuScenes, and AV2 using the three disjoint external
   source roots. Run the protected judges and receipt gate.
5. Run the P7 local/remote/portable-share matrix, immutable Phase 6 comparison,
   negative/regression/harness gates, lifecycle/performance checks, and baseline
   freeze. Bind every artifact to that exact clean candidate and verifier.
6. Publish only permitted public-safe commitments/receipts, update PR B with
   exact observed results, review, and merge.

Only after PR B's P7 freeze is merged may a new task reserve and open held-out
source bytes for the remaining Spec 014 generalization ladder.

- 2026-09-02T07:55Z: counted run restarted from main df92b72.
- 2026-09-02T08:18Z: counted run restarted from main 6e6d520.
