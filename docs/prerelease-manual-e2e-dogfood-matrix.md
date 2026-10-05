# Prerelease manual E2E dogfooding matrix

Status: prepared, not executed. All scenarios below initially have status **NOT RUN**.

Prepared on 2026-10-03 for the Threadnote 5.1 prerelease track. Source review includes the CLI and MCP catalogs,
context workflows, graph readiness/checkpoint contracts, security guidance, and release requirements. At preparation,
`origin/main` is `41670137` (including the local-attestation policy change and local citation-observation fix).
Pending fixes and features must be verified in the frozen candidate, not assumed present from another development
installation. This document does not certify a candidate, run an experiment, or authorize publication.

## 1. Scope and authority

Exercise the **globally installed** product through real CLI processes, actual registered MCP transports in coding-agent
clients, and the browser-based Manager. All surfaces must resolve to the same frozen candidate in each environment.
Checkout source, a local `dist` binary, a per-test alternate executable, direct TypeScript calls, mocked handlers,
green unit tests, or tool transport success alone do not qualify as manual E2E passes.

This document owns scenarios, synthetic fixture oracles, platform coverage, and pass invariants. The project
[release-signoff skill](../.cursor/skills/release-signoff/SKILL.md) owns worker setup, low-cost delegation, scheduling,
runtime coordination, evidence collection, and the signoff file. Do not copy worker instructions into this matrix.

This matrix complements [release requirements](./releasing.md), [context workflows](./context-workflows.md),
[graph readiness](./code-graph-readiness.md), [checkpoints](./code-graph-checkpoints.md), and
[security](./security.md). Those contracts remain authoritative at the frozen candidate. Manual testing does not
replace CI, signed/immutable publication, hosted scale evidence, or the existing Stage 3 gate.

Local three-run heavy-tail performance attestation is optional, not a beta or stable publication prerequisite.
Do not add it back indirectly through this checklist. Functional failure investigation still matters; missing optional
performance evidence is not a failure, and failed evidence must never be reported as a performance pass.

### Priorities and execution passes

| Tag | Meaning                                                                | When to run                                                                                                                                   |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | Fast feedback: critical journey, safety boundary, or recent regression | First on the primary desktop; repeat critical platform-sensitive cases on macOS, Linux, and Windows before beta                               |
| P1  | Complete functional/regression coverage                                | All applicable cases before stable; before beta, include changed surfaces and their dependencies, and record explicitly any deferred coverage |
| C   | Conditional integration/capability                                     | Required when included in the candidate's supported or advertised surface; otherwise record a reasoned N/A                                    |
| O   | Optional research/performance observation                              | Only when useful; never an implicit publication dependency                                                                                    |

An absent advertised feature is FAIL, not N/A. A missing environment or permission is BLOCKED, not N/A.
An expected safe refusal passes only if the refusal and its non-mutation invariant were both observed.

## 2. Platforms and safety boundaries

### Platform lanes

| Lane               | Required coverage                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64        | Full primary desktop journey; signatures/notarization for released archives; real agent MCP and Manager; POSIX Stage 3 runner |
| macOS x64          | Archive/install/doctor/real embedding smoke; upgrade/repair and representative memory, graph, MCP, Manager checks             |
| Linux x64 glibc    | Full headless CLI/MCP journey; Manager in a browser; permissions, offline behavior and process cleanup                        |
| Linux arm64 glibc  | Archive/install/doctor/real embedding smoke; representative memory, graph, MCP and recovery checks                            |
| Windows x64        | Full PowerShell/native-client journey; archive/installer warnings, paths, rename/delete locks, recovery, Manager              |
| Windows arm64      | Archive/install/doctor/real embedding smoke; representative memory, graph, MCP and process checks                             |
| Linux musl targets | Compile-only under the current release matrix; do not invent a published musl archive or claim install coverage               |

Record native execution versus emulation. Full primary lanes do not prove untested architecture parity.
Publication-dependent checks (`REL-02`, released signature/notarization portions of `INS-03`, and published-link
portions of `REL-03`) belong to the postpublication phase. Before publication they remain NOT RUN, explicitly scheduled
for that phase, not PASS or N/A. An exact-candidate development install qualifies for prerelease functional testing,
not released-archive certification. Appropriate build gates remain required before publication.

### Safety rules

1. Use synthetic repositories and a disposable OS account or VM for installer, updater, host-configuration, migration,
   uninstall, and destructive tests. Use separate homes for independent users and upgrade/downgrade receivers.
2. `THREADNOTE_HOME` / `--home` isolate **data**, not the standalone installation or coding-agent settings.
   A temporary home alone does not make `install`, `repair`, `setup`, `update`, or `uninstall` harmless to the real user.
   Isolate and record installation/launcher/config locations too. Do not repurpose `HOME` or `CODEX_HOME`.
3. Ordinary fixture reads and writes use a task-specific data home and explicit absolute `callerCwd` for MCP.
   Confirm the MCP server actually inherited the test home; the client's own working directory is not sufficient.
   Data-home isolation does not permit substituting a different binary for the global candidate.
4. Never change the global runtime without resolving its active owner and receiving an explicit release.
   Freeze the next candidate only after ownership coordination; do not overwrite a claimant mid-smoke.
5. Disable automatic updates through supported policy in the disposable environment while measuring a fixed
   candidate. Keep telemetry disabled by default; test consent only against a controlled test endpoint.
6. Fault injection must target disposable resources. Use a bounded test quota or controlled capacity fixture, not
   filling the developer's disk. Use the existing Stage 3 harness for production writer-lock/crash choreography.
   Kill only the supervised process whose executable, role, and fixture ownership were verified.
7. Sharing, pushing, OAuth, downloads, cloud access, and issue submission need the appropriate explicit test authority.
   Use a local fixture remote where supported, or an approved disposable private remote—not the production team share.
8. Never use real secrets, customer data, raw production logs, or production databases. Keep synthetic canaries
   clearly labeled. Screenshots must omit Manager bearer tokens, credentials, user paths, and unrelated content.

Use supported `--help` at the candidate for mutation flags. A preview is required only where the product provides
one; do not invent `--dry-run` for every command. Inspect and approve exact destructive targets before applying.
Record the client deadline and supported server read budget before fault tests, leaving the documented cleanup margin.
A deadline expiry is not a successful analysis or recovery. Evaluate deferred/unavailable states only against rows
that expect them; observe eventual convergence within the existing harness bound, without tight polling.

## 3. Fixtures and independent oracles

Create these once using an editor or a reviewed fixture harness. Record file hashes, commits, expected relationships,
and memory identities before testing; do not derive the expected answer from Threadnote's response.

| Fixture                     | Contents and purpose                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1: pricing repository      | Clean Git repository with credential-free synthetic remote identity. `src/calculate.ts` imports `lineSubtotal` from `src/line.ts`; `src/order.ts` calls exported `calculateTotal`. A focused test independently establishes the calculation. Include a disconnected symbol, README, ignored/generated directories, and spaces/Unicode in a path. |
| F2: client repository       | Separate Git repository depending on F1's package by a declared manifest/import. Include a documented public API relationship and a similar local symbol name to expose cross-repository ambiguity.                                                                                                                                              |
| F3: linked worktrees/scopes | Three linked F1 worktrees, a nested configured project, a sibling scope, and a nested independent Git repository. Use distinguishable committed and uncommitted symbol changes.                                                                                                                                                                  |
| F4: memory corpus           | At least three relevant active decisions/handoffs, unrelated/projectless distractors, archived/superseded records, a legacy uncited record, typed relations, and conflicting records requiring a human decision. Each has a synthetic fact with a known oracle.                                                                                  |
| F4a: resume selector trap   | Task-aligned old handoff without actionable current citations plus a fresh actionable handoff citing a different known symbol. Record which source should win after validation. Never assume creation order or lexical similarity establishes authority.                                                                                         |
| F4b: ranking collisions     | Shared tokens but different projects/entities; exact identifier versus merely similar text; useful multi-memory answer. Test relevant recall and exclusion, not a hardcoded confidence score.                                                                                                                                                    |
| F5: boundary content        | Long UTF-8 memory with section boundaries, Unicode at byte-page boundaries, markdown, synthetic HTML/script text, malicious instruction text, and clearly fake sensitive-pattern canaries. No real secret.                                                                                                                                       |
| F6: disposable Git team     | Two isolated personal homes, one writable fixture team and one read-only team, divergent edits, unrelated staged Git changes, and a local/offline failure mode.                                                                                                                                                                                  |
| F7: procedures/guidance     | A benign procedure whose reviewed verification only writes a sentinel inside its fixture; compatible/incompatible manifests, changed artifact and receipt, duplicate version conflict; pre-existing host guidance with an unmanaged paragraph.                                                                                                   |
| F8: upgrade/repair          | Snapshot of a test 5.0.7 home and an older supported schema fixture; canonical hashes/counts, model/index state, hook/MCP configs and unmanaged files. Never use a real user's home as the baseline.                                                                                                                                             |
| F9: optional integrations   | Disposable Obsidian vault, local consent sink, optional PostgreSQL/composer fixture and catalog-supported cloud profile, only when those capabilities are in scope.                                                                                                                                                                              |

F10, when shared graphs are in scope: isolate publisher/coordinator/CAS, reader and contributor homes; prepare
digest-pinned profiles, a tampered signed artifact, and distinct graph/registry authorization audiences. Use an approved
test issuer/registry where required. Never enroll the production organization.

For every read-only or rejected action, compare the relevant canonical files, Git HEAD/index/worktree, and configuration
before/after. Account separately for allowed derived caches or operational diagnostics. Do not mistake “no canonical
mutation” for “no disk activity anywhere.” For explicitly read-only maintenance contracts, check their stronger stated
write/network boundary too.

## 4. First run: one real end-to-end journey

Run this before the broad matrix. It exercises memory and graph together, not merely tool availability.

| ID     | Tier | Action                                               | Pass invariant / evidence                                                                                                                                                                  |
| ------ | ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E2E-01 | P0   | Complete the following seven-step A→fresh-B journey. | Actual memory/graph reuse, independent phase tests, current CLI/MCP/Manager agreement, reviewed mutation boundaries and clean closeout. Record A/B identities and B's fresh-session proof. |

1. Verify the exact frozen global candidate in the isolated lane. Record provenance and run strict doctor.
2. Preview/apply `threadnote setup <surface>` for F1; restart/reconnect that real agent client.
3. Give agent A a normal multi-step change request in F1 without manually pasting the answer. Observe its actual
   Context Brief, graph query, source verification, implementation, and independent fixture test.
4. Have A store a concise private handoff with current code refs. Preview a durable Knowledge Delta; approve an
   appropriate decision and reject another synthetic proposal. Confirm neither was applied before approval.
5. End A's native context. Start a genuinely fresh agent B on the same project, not a fork retaining A's transcript.
   Ask B to continue the next phase. It must retrieve/read the relevant memory, follow its cited graph/source anchors,
   and pass the independent test without receiving an external pasted handoff.
6. Open Manager: find the same records, preview their bodies/citations, inspect graph and linked memories, and verify
   current/freshness states agree with CLI/MCP. Change one cited fixture source and repeat the relevant reads.
7. Close B with a private handoff. Inspect feedback/value evidence, process cleanup, and canonical-state preservation.

This is a functional reuse test, not a token-savings experiment. Record provider usage and elapsed time if available,
but do not infer savings or a completion-cost claim from one session or a failed attempt.

## 5. Installation, payloads, updates, and lifecycle

CLI actions here require the disposable installation/account boundary above.

| ID     | Tier | Action                                                                                                                                                       | Pass invariant / evidence                                                                                                                                                              |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INS-01 | P0   | Fresh install/activate on an empty lane; inspect launcher resolution, `--version`, `doctor --strict`, `models list`, `models runtime`, `index status`.       | Exact expected candidate/payload, one intended launcher, healthy core model/storage. Record executable hash and structured check outcomes.                                             |
| INS-02 | P0   | Perform a real embedding and semantic recall of an F4 fact; compare lexical/exact lookup as a separate probe.                                                | Bundled native inference actually runs; no implicit runtime compilation/download. A status line alone is not proof.                                                                    |
| INS-03 | P0   | Verify each enabled archive's checksum; on macOS verify signature and released notarization; on Windows inspect unsigned metadata/warning.                   | Correct target and trust policy; valid archive activates, corrupted or mutable delivery does not. Retain verification receipts, not credentials.                                       |
| INS-04 | P1   | Repeat installation/repair on unchanged state; retain a user-created neighboring file and pre-existing host config.                                          | Managed state converges; canonical memories and unmanaged content survive; no duplicate launchers/config entries.                                                                      |
| INS-05 | P0   | Upgrade F8 from 5.0.7 to the frozen 5.1 candidate; reopen actual clients and Manager.                                                                        | Memories, stable IDs, citations/relations, project definitions and consent preserved; supported migrations explicit; old incompatible derived state rebuilt or truthfully unavailable. |
| INS-06 | P1   | Interrupt download/activation in a disposable lane; retry. Test a damaged model asset and language-pack manifest.                                            | Incomplete payload never becomes active; actionable failure; reviewed repair restores the exact candidate without canonical loss.                                                      |
| INS-07 | P0   | Inspect `update --status`, `update --check --json`, `update --beta --check --json`, and stable selection. Test policy persistence using the supported flags. | Stable/beta selection is honest and explicit; no update during a check; fixed-candidate verification cannot silently drift. Use a controlled source for channel fault tests.           |
| INS-08 | P1   | Simulate offline/rate-limited release API and invalid/custom API responses; test custom source without opt-in.                                               | Bounded, actionable outcome; no unverified replacement or unsolicited custom-source trust. Existing runtime/data remain usable.                                                        |
| INS-09 | P1   | In the disposable lane inspect `start`, `stop`, `processes --json`, normal/core-only/deep repair variants.                                                   | No invented daemon requirement; process roles truthful; preview flags respected; repair scope excludes unintended host files.                                                          |
| INS-10 | P1   | Attempt supported downgrade on a cloned migrated home; preview and execute uninstall only in the disposable account.                                         | Safe downgrade or explicit compatibility refusal; no forced schema destruction. Uninstall scope matches its actual retention policy and preserves unrelated files.                     |

## 6. Setup, activation, host adapters, and hooks

| ID     | Tier | Action                                                                                                                                                         | Pass invariant / evidence                                                                                                                                                                 |
| ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SET-01 | P0   | Run `agents list`, then `setup <surface>` preview and `setup <surface> --apply` on F1; restart the real client.                                                | Catalog-declared support matches behavior; preview does not mutate; apply yields a usable graph-backed verification brief and real MCP tools.                                             |
| SET-02 | P1   | Reapply unchanged setup; interrupt an incomplete setup and resume it.                                                                                          | Receipt-backed completed operations do not duplicate; incomplete work resumes; no false success when graph/adapter/doctor is incomplete.                                                  |
| SET-03 | P0   | Inspect seeded instructions, selected skills and MCP descriptions; give a second prompt in an unchanged active native session, then a genuinely fresh session. | Current guidance allows context reuse in-session and appropriate fresh-session retrieval. Record host-injected duplication separately from Threadnote-induced repeated reads.             |
| SET-04 | P1   | Setup a second catalog-managed surface against the same approved F4 knowledge.                                                                                 | Same canonical records, correct client-specific configuration, no duplicate canonical context copy; actual second-client retrieval proof, not a fabricated receipt.                       |
| SET-05 | P1   | Preview/apply setup undo after editing one managed output and one pre-existing file.                                                                           | Only unchanged receipt-owned artifacts removed; user modifications preserved or explicit conflict; interrupted undo resumes safely.                                                       |
| SET-06 | P1   | Test one unsupported/catalog-only surface, malformed host JSON, custom instructions and unrelated MCP servers.                                                 | Truthful manual/unsupported guidance; no forced adapter or clobbered user configuration; recovery action explains the exact obstacle.                                                     |
| SET-07 | P0   | Trigger supported session-start, resume and pre-compaction hooks in the real host; reconnect its MCP after restart.                                            | Valid bounded output, useful handoff/context, no stdout protocol contamination or duplicate stores; unsupported hooks remain explicit.                                                    |
| SET-08 | P1   | Use `activate start/continue/status/undo` with F7's reviewed request; change request bytes between approval and continuation.                                  | Stops at exact review boundaries; stale approval refused; setup/second-surface proof is real; undo receipt-owned, no automatic sharing/provider calls.                                    |
| SET-09 | P1   | Start a narrowly scoped background agent with sufficient task context; inspect its first retrieval and closeout.                                               | Only task-relevant routing/skills; bounded context; no mandatory reread of every Threadnote skill/brief for an already supplied exact task. Separate product guidance from host behavior. |

## 7. Canonical memory, URIs, and recall

Use real CLI and registered MCP, with Manager parity for preview/detail reads.

| ID     | Tier | Action                                                                                                                                        | Pass invariant / evidence                                                                                                                                               |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEM-01 | P0   | `remember_context` an F4 handoff and durable decision; `list_context`/CLI `list`; `read_context`/CLI `read`.                                  | Exact synthetic body, kind/project/status, stable identity and private default; record returned canonical URI.                                                          |
| MEM-02 | P0   | Replace one URI with changed text and explicit refs/relations; read by canonical URI and stable identity. Retry the intended in-place update. | Same intended record, no timestamp duplicate or self-supersedes edge; cleared/replaced citations and relations are disclosed, not silently assumed preserved.           |
| MEM-03 | P0   | Copy a compact URI from recall/brief into `read_context`; compare full URI and stable-ID reads.                                               | Same selected record/content; compaction does not alter user/team/scope authority. No requirement to reconstruct a prefix manually.                                     |
| MEM-04 | P0   | Probe malformed, escaped, traversal, wrong-user, missing and directory URIs, and symlink escapes in F5.                                       | Safe scoped refusal; no outside read/write or leaked unrelated body; intended valid URIs still work.                                                                    |
| MEM-05 | P1   | Read F5 whole, outline, section and bounded byte pages; reuse `sourceHash`, then mutate the source before the next page.                      | UTF-8 boundaries and sections correct; budget/page metadata honest; source drift refused rather than mixing revisions.                                                  |
| MEM-06 | P1   | Archive/supersede a fixture record, recall normally and with archived inclusion, then preview forget of one exact disposable subtree.         | Lifecycle eligibility honored; deletion preview lists the actual scope; applying only the approved fixture removes no neighboring records.                              |
| MEM-07 | P1   | Export/import a synthetic pack into another home; include a malformed/traversal/tampered pack.                                                | Valid identity/content round trip; invalid pack safely refused; canonical and derived consistency checked after import.                                                 |
| MEM-08 | P1   | Run applicable memory/lifecycle/project-name migration previews and apply on F8; repeat.                                                      | Stable IDs/provenance and user edits preserved; no duplicate migration or orphaned canonical record. Unsupported baseline explicitly refused.                           |
| REC-01 | P0   | Recall F4/F4b via exact identifier, paraphrase and a multi-premise task; read returned pointers.                                              | Useful relevant evidence available; exact entities not conflated; irrelevant history does not crowd out required facts. Inspect actual bodies before judging relevance. |
| REC-02 | P0   | Recall with explicit project plus projectless guidance; compare an unrelated project, a workset and deliberate global recall.                 | Eligibility and scope match the request; no accidental cross-project answer or private/shared authority escalation.                                                     |
| REC-03 | P1   | Recall by `memoryRefs` and typed relation filters; include cycles, absent targets and an ambiguous stable selector.                           | Bounded verified one-hop navigation; no accidental recursive expansion or invented targets; ambiguity/missing evidence explicit.                                        |
| REC-04 | P0   | Issue an unrelated/no-match query at several supported result limits and relevance floors.                                                    | Empty/short result is honest; no filler to consume the cap or suggestion that an unread pointer is evidence.                                                            |
| REC-05 | P0   | Store, replace, archive and forget fixture records from CLI/MCP; repeat recall in the other surface.                                          | Canonical changes become visible through supported index convergence; removed/stale facts do not remain authoritative indefinitely.                                     |
| REC-06 | P1   | Remove/corrupt only a cloned disposable derived recall index; inspect `index verify`, preview applicable purge, rebuild and retry.            | Canonical memories survive; semantic/lexical capability states truthful; derived generation activates atomically; repaired results recover.                             |
| REC-07 | P1   | Use the recalled F4 fact in a real task, then submit `recall_feedback`; also mark a deliberately wrong match.                                 | Feedback bound to the actual query/record/action; value report reflects meaningful usage without treating mere display as success.                                      |

## 8. Context Brief, memory/graph coherence, and response cost

| ID     | Tier | Action                                                                                                                   | Pass invariant / evidence                                                                                                                                                                                     |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BRF-01 | P0   | Call `context_brief` with task and absolute F1 `callerCwd`; verify current source and at least three useful F4 premises. | Brief is task-useful, multi-memory when needed, cited and bounded; one plausible memory alone cannot establish complete coverage.                                                                             |
| BRF-02 | P0   | Request `mode=resume` with F4a; compare selected handoff and returned graph/source anchors.                              | Graph evidence follows the handoff selected after freshness/citation validation, not an earlier lexical candidate. Reproduce the #727 selector-coherence case.                                                |
| BRF-03 | P0   | Repeat resume with explicit `codeRefs` pointing to another valid F1 anchor.                                              | Caller refs remain authoritative as specified; corrective handoff selection does not silently replace explicit caller scope.                                                                                  |
| BRF-04 | P0   | On F3 change a cited local source, refresh it, then request brief through CLI and MCP from root/nested cwd.              | Citation observation/freshness fences converge without redundant-observation autoheal failure; no stale-as-current source or wrong checkout. Reproduce the #729 regression.                                   |
| BRF-05 | P1   | Exercise `brief`, `locate`, `explain`, `trace`, `impact`, `resume`; compare compact and source detail.                   | Mode-specific evidence relevant; bounded source excerpts match the selected current source; gaps and unavailable evidence are not hidden.                                                                     |
| BRF-06 | P0   | Try cold graph, stale-ready graph and partial selected-project coverage without manually indexing during the brief call. | No surprise cold indexing from Context Brief; truthful ready/stale/partial/unavailable state and bounded actionable follow-up.                                                                                |
| BRF-07 | P0   | Request 800/1,250/1,500 supported brief caps; repeat a tiny task whose relevant answer is much shorter.                  | Projector's estimated-token cap respected including presentation; omitted sections semantic and recoverable; no budget-filling padding. Provider tokenizer counts recorded separately if measured.            |
| BRF-08 | P0   | Compare default agent and explicit dual for identical brief/recall/graph selectors, then read the same memories.         | Compact human-readable projection retains useful facts, freshness, gaps and next action; dual preserves canonical structured schema. No duplicated bodies or verbose JSON scaffold in the default agent view. |
| BRF-09 | P1   | Resume after compaction/new client using a current cited handoff, then an uncited/stale handoff.                         | Compact exact-current resume only when eligible; honest fallback otherwise; no pretending native context or citations survived.                                                                               |
| BRF-10 | P1   | Present two contradictory F4 decisions and a verified F7 procedure during a task.                                        | Conflict remains explicit; no automatic truth choice/apply; admitted procedure is compatible verified metadata, not auto-executed commands.                                                                   |

## 9. Local graph, analysis, and code-to-memory links

| ID     | Tier | Action                                                                                                                                          | Pass invariant / evidence                                                                                                                                       |
| ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GRF-01 | P0   | `graph inventory`, then index F1 and inspect status using the exact F1 cwd/project.                                                             | Scope/eligible languages/ignored files explained; one atomically published current snapshot bound to the right source.                                          |
| GRF-02 | P0   | MCP `inspect_code_graph(operation=query)` for `calculateTotal`; compare `graph query --query` and exact source.                                 | Known symbol/path/caller relationship returned; no unrelated same-named symbol substituted; nodes and freshness useful without envelope noise.                  |
| GRF-03 | P0   | Follow returned `cgs_` through node, neighbors (incoming/outgoing/both), and explain.                                                           | Stable handle round trip; direction/depth/limits honored; independently known imports/calls match source. Heuristics distinguished from resolved evidence.      |
| GRF-04 | P0   | Query path between F1 oracle endpoints; run impact for the changed function/base commit.                                                        | Correct current-source relation and reverse dependents; no fabricated path or stale authorization. Disconnected endpoints return honest no-path.                |
| GRF-05 | P1   | Rename/delete/add files, alter imports and working-tree contents, then commit/revert a fixture change.                                          | Incremental result reflects the actual final tree; removed symbols do not linger; dirty/clean identity accurate. Compare with a fresh full fixture rebuild.     |
| GRF-06 | P0   | Leave an untracked fixture source, make adjacent rapid writes and an atomic-save rename, then read via another MCP host.                        | Missed watch-event reconciliation converges to latest contents; no indefinitely old graph or repeated supersession storm. Cover the #725 regression.            |
| GRF-07 | P1   | Inspect parser coverage across supported language-pack representatives, syntax errors, generated files, ignored paths and unusually large text. | Supported coverage truthful; bounded parse failures/skips; unsupported language is not silently counted as complete parsed coverage.                            |
| GRF-08 | P0   | Store F4 decisions with current `codeRefs`; inspect their cited symbol and inverse code-to-memory associations.                                 | Forward citations and linked memories agree; active/scoped eligibility honored; relevant links retrievable, no unrelated or unread-body evidence implied.       |
| GRF-09 | P0   | Store a private active memory with deferred refs during refresh; finalize once current; try sharing while pending.                              | Private pending state disclosed, no shared backlink until current verification; finalization attaches exact current refs or safe actionable failure.            |
| ANA-01 | P0   | MCP `analyze_code_graph(operation=stats)` and CLI stats/analyze on F1.                                                                          | Real semantic analysis result, matching oracle counts/structure within documented coverage; transport success alone is insufficient.                            |
| ANA-02 | P1   | Exercise communities/community, groups, hubs, surprises, confidence and full; follow a returned community ID.                                   | Bounded compatible operations, meaningful selected-scope relationships; partial detail and heuristic confidence separated from freshness.                       |
| ANA-03 | P0   | Analyze stale-ready F1 under `current`, `ready`, and `allow-stale`; repeat `allow-stale` on a cold project.                                     | Current stays strict; explicit stale policies disclose snapshot; cold allow-stale starts no indexing and returns no-ready evidence. No sibling-scope borrowing. |
| ANA-04 | P1   | Export a small graph to JSON/GraphML/HTML/SVG and a report to new fixture paths; retry existing output paths.                                   | Correct bounded artifact, safe output ownership, no overwrite; memory/graph inputs unchanged; limits affect presentation, not admission.                        |

## 10. Graph contention, continuity, maintenance, and checkpoint recovery

Use disposable fixtures or the production Stage 3 harness—not manual database locking against the user's graph.

| ID      | Tier | Action                                                                                                                                                    | Pass invariant / evidence                                                                                                                                                    |
| ------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIFE-01 | P0   | With F3 and two real MCP hosts, hold the fixture writer using the Stage 3 choreography; request stale query/node/neighbors/explain.                       | Useful compatible stale discovery remains bounded with active/queued/deferred metadata; no requirement to wait for current publication.                                      |
| LIFE-02 | P0   | During the same contention request path, impact and default-current analysis; request explicit stale analysis separately.                                 | Strict operations never pass as current on stale evidence; unavailable/deferred is bounded; lease contention never authorizes an unleased analysis read.                     |
| LIFE-03 | P0   | Drive F3 through f1 → f2 → f3 while a build is active; observe from both hosts and linked worktrees.                                                      | One active/latest demand discipline; opaque continuity correlation consistent; latest source eventually publishes; no wrong-worktree data or burst amplification.            |
| LIFE-04 | P0   | Kill the supervised MCP claimant/graph child at the existing Stage 3 ownership boundaries; recover through the survivor.                                  | Crash recovery reconciles demand/publication, releases or truthfully expires ownership, and converges; cleanup verified, not inferred from a timeout.                        |
| LIFE-05 | P1   | Cancel a graph/analysis request and disconnect a client during refresh; inspect processes and retry after advertised guidance.                            | Bounded request/cleanup, no stdout corruption, leaked workers/leases or tight-poll advice; remaining consumers keep functioning.                                             |
| LIFE-06 | P1   | Trigger fixture quota/read-only-directory/temporary-capacity pressure and restore it; inspect graph status/diagnostics.                                   | Typed physical-shortage versus retryable contention; no host-disk fill, infinite automatic retries, corrupt ready activation or stale-as-current claim.                      |
| LIFE-07 | P1   | Preview scoped graph repair/purge; run selected fixture maintenance/compact/removal while another view is active.                                         | Exact view/database scope and owner fences honored; canonical source/memory untouched; unrelated live view preserved; honest deferred ownership.                             |
| CKP-01  | P1   | Export clean full F1 checkpoint twice to new paths; inspect/verify with independently recorded digest; import into another exact clean F1 receiver twice. | Deterministic bytes/digest where contract promises; logical snapshot reused; exact identity/ABI/file-tree checks; no duplicate publication or canonical memory migration.    |
| CKP-02  | P0   | Try corrupt/truncated/digest-mismatched/symlink input, missing local source commit, wrong repository and scoped-project export.                           | Safe refusal before reachable publication; no lazy source fetch or repository-code execution; no broader-scope substitution.                                                 |
| CKP-03  | P1   | Import into dirty, descendant and divergent receivers; interrupt one import.                                                                              | Receiver-state semantics match checkpoint contract; divergent verified snapshot inactive; interrupted staging unreachable; derived fields reviewed as potentially sensitive. |

Retain a passing exact-candidate Stage 3 artifact separately. These manual observations do not substitute for it.
Do not assert portable bit-for-bit executable reproducibility from a checkpoint round trip or a single machine build.

## 11. Projects, scopes, and multi-repository worksets

| ID     | Tier | Action                                                                                                                                                                           | Pass invariant / evidence                                                                                                                                   |
| ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WRK-01 | P0   | Create/show/list/update a named F1 project using `project ...`; compare Manager. Preview deletion by omitting required confirmation before deleting only the fixture definition. | Canonical definition and revision agree; no implicit source deletion or indexing from definition-only actions; confirmation required.                       |
| WRK-02 | P0   | Compare root + explicit project with nested cwd + inferred project in F3; include the nested independent repository.                                                             | Equivalent intended scope resolves identically; independent/sibling scope never silently substituted; ambiguous selection actionable.                       |
| WRK-03 | P1   | Configure a dependency-scoped project; query a known excluded file, then explicitly change the definition/scope.                                                                 | Outside/partial project coverage truthful; no implicit repository-wide expansion; newly selected scope changes only after an explicit supported action.     |
| WRK-04 | P0   | Create/show/update F1+F2 workset without prepare, then `workset prepare` and `workset status`.                                                                                   | Definition-only operations do not build; explicit preparation publishes repository-qualified evidence with honest member readiness.                         |
| WRK-05 | P0   | Workset graph query/topology, recall, brief; follow returned `cgr_` node handles and cross-repository relationships.                                                             | Qualified identities survive traversal; local `cgs_` and workset `cgr_` are not interchanged; evidence bound to each member. No unqualified name collision. |
| WRK-06 | P1   | Make one member unavailable/stale; query prepared evidence with limits and continuation cursor; rename/delete the fixture workset.                                               | Partial/timed-out/unavailable states explicit; cursor replay bound to the same catalog/selector; no hidden cold indexing or deleted-definition mutation.    |

## 12. Manager UI and browser end-to-end behavior

Use `threadnote manage` in the disposable account. Cover a desktop Chromium browser and a second browser where available;
include narrow viewport, keyboard-only interaction and 200% zoom. Capture synthetic UI only.

| ID    | Tier | Action                                                                                                                                                             | Pass invariant / evidence                                                                                                                                             |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-01 | P0   | Open Manager from the installed candidate; load empty and populated homes, refresh and reconnect.                                                                  | Correct candidate/data home; loopback server/token protection; no blank screen, persistent loading loop or misleading connected state.                                |
| UI-02 | P0   | Browse/search/filter F4; open memory/context preview, citation and full detail; follow compact/stable links.                                                       | Body, lifecycle, project, citations/relations agree with CLI/MCP; no truncation presented as full evidence or unnecessary opaque JSON.                                |
| UI-03 | P0   | Inspect F1 graph, query a symbol, follow relationships and linked memories; switch project/workset and return.                                                     | Selection and scope stay coherent; graph/readiness/link counts meaningful; no old selection's graph rendered as new current evidence.                                 |
| UI-04 | P0   | Edit a cited F1 source while viewing preview; refresh during indexing, then inspect after convergence.                                                             | Freshness/pending/changed state updates truthfully; no false green citation or stale preview pinned indefinitely.                                                     |
| UI-05 | P1   | Use project/workset forms and supported graph-removal controls; introduce a competing definition change from CLI.                                                  | Validation/confirmation and optimistic revision conflict visible; recoverable UI, no unintended scope deletion; stale-action conflict such as HTTP 409 not swallowed. |
| UI-06 | P0   | Review F4 conflict/candidates and perform approved edits/reject/defer where those controls are shipped.                                                            | Approval boundary respected; no hidden auto-apply/share; repeated submission or stale revision cannot approve different content.                                      |
| UI-07 | P1   | Inspect processes, value evidence and operational health; disconnect/restart the managed server.                                                                   | Actual roles/freshness represented, understandable disconnected/retry state; no speculative status derived solely from cached cards.                                  |
| UI-08 | P1   | Navigate by keyboard, zoom, resize; inspect modals, scroll, empty/error messages, small badges, pluralization and long Unicode paths.                              | No clipped actionable controls, trapped focus, horizontal overflow or unreadable badge wrapping; accessible labels and focus return.                                  |
| UI-09 | P0   | Render F5 HTML/script/instruction canaries; attempt unauthenticated/cross-origin mutation against the fixture server.                                              | Content inert and untrusted; protected mutations rejected; no bearer leakage in public evidence or accidental external execution.                                     |
| UI-10 | C    | If the new Context Health/decision-resolution surface is in the candidate, open its actionable/unknown/empty states, supporting evidence and maintenance controls. | Useful decision memories, honest deferred/unknown coverage, concise non-wrapping badges; reviewed resolutions only. Pending branch availability is not a pass.        |

## 13. Knowledge Delta, guidance, health, and value evidence

Maintenance MCP tools require the `full` toolset; their absence in `core` is not a defect.

| ID     | Tier | Action                                                                                                                                           | Pass invariant / evidence                                                                                                                                        |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REV-01 | P0   | `review_session_context` a genuine F1 result with task/outcome/project/source identity and the five Knowledge Delta fields.                      | Readable decisions+rationale, constraints, verification, invalidations and unresolved risks; private proposals only; evidence attributable to the real session.  |
| REV-02 | P0   | Inspect closeout preview; approve one candidate with an edit, defer one and reject one using `apply_memory_candidates`/supported closeout apply. | Only expressly approved exact content becomes durable; defer/reject unapplied; no automatic team publication or procedure execution.                             |
| REV-03 | P0   | Change candidate/source preconditions after preview and attempt the old approval; retry an already applied exact action.                         | Stale/conflicting approval refused; intended reviewed retry behavior preserves stable identity and does not create spurious duplicates.                          |
| GUD-01 | P1   | Preview/apply guidance import; select approved F4 durable memories for guidance projection; inspect status from both host surfaces.              | Import creates review candidates, not approval; one provenance-backed managed block; deterministic shared target, unmanaged paragraph preserved.                 |
| GUD-02 | P1   | Edit source memory and managed/unmanaged target text; preview projection/remove, including conflict path.                                        | Current/missing/modified/stale/unavailable states correct; forced conflict resolution cannot overwrite unmanaged text; health/check expose drift.                |
| HLT-01 | P0   | `context health --project <fixture> --json` and full MCP `context_health` with expiry, changed/missing citations and relation targets.           | Bounded deterministic findings; severity/confidence/repairability distinct; unknown coverage not called clean; canonical state unchanged.                        |
| HLT-02 | P1   | Intersect kind/topic/category selectors and follow `nextCursor`; mutate a selected source and reuse the cursor.                                  | Narrowing never widens scope; page continuation has no missing/duplicate findings; invalid/stale cursor refused; scoped view cannot mark global health resolved. |
| HLT-03 | P0   | Preview a personal repair; apply one explicitly approved exact selector/proposal/revision; change one precondition and retry old approval.       | Safe exact mutation with recovery/idempotence; stale apply refused; shared/ambiguous records not silently rewritten.                                             |
| HLT-04 | P1   | Present contradictory F4 decisions without direction, then review an exact stale/current direction and re-preview.                               | No automatic truth judgment from left/right order; approval bound to both records/evidence; superseded history preserved, not erased.                            |
| HLT-05 | P1   | Use full MCP metadata preview/apply for one F4 validity/review field; compare omitted/unchanged/cleared values and stale revision.               | Exact bounded metadata-only change after approval; body/identity/unrelated fields preserved; invalid dates/lifecycle state refused.                              |
| HLT-06 | P1   | Run local health schedule/aggregate with writable and read-only F6 teams, offline and partial semantic coverage.                                 | Read-only contract and exact selector scope preserved; no automatic fetch/push/repair; unknown/deferred outcome honest; no unwanted scheduled external mutation. |
| CHK-01 | P0   | `context check --project <fixture>` on clean, dirty and changed cited source; inspect JSON and SARIF against an explicit fixture base.           | Current claims require source/read fences; dirty or missing evidence unknown/failed as appropriate; findings privacy-safe and source-verifiable.                 |
| VAL-01 | P1   | Inspect `value report` after real brief/reuse/feedback/health actions; preview export/retention/delete and apply only in the fixture.            | Local attributable observations, no fabricated savings; read-only preview honored; explicit export/deletion scope and disabled telemetry respected.              |

## 14. Git team sharing and portable artifacts

Use F6 only. Never publish handoffs/preferences, or copy this local execution worksheet into the default team share.

| ID     | Tier | Action                                                                                                                                                | Pass invariant / evidence                                                                                                                              |
| ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SHR-01 | P0   | Configure the disposable writable team; inspect status/list and sync; approve then publish one reviewed durable F4 record. Read from isolated user B. | Shared data is actually retrievable by B; private source preserved until success; expected scrub/commit/push boundaries; no automatic unrelated share. |
| SHR-02 | P0   | Attempt publish of a handoff, preference, pending citation, incompatible record and synthetic sensitive-pattern content.                              | Forbidden lifecycle/citation/secret/local-path cases fail safely; no push or partial canonical loss; do not assume arbitrary secrets can be detected.  |
| SHR-03 | P1   | Create divergent A/B edits; inspect conflict and resolve an explicitly reviewed side/merge. Change shared HEAD between preview and apply.             | Conflict retained with safe backup; no blind overwrite/force-sync; Git/content preconditions respected.                                                |
| SHR-04 | P0   | Configure read-only team and try publish, local-take conflict, artifact write and reviewed repair.                                                    | Reads/status/supported sync usable; disallowed writes rejected before mutation. Do not mark an authorization refusal as network failure.               |
| SHR-05 | P1   | Preview/apply unpublish, rename and remove of only the disposable team; exercise local-preservation/keep-files policy.                                | Exact namespace/retention semantics disclosed; no unrelated personal loss; resumed operation distinguished from fresh destination.                     |
| SHR-06 | P1   | Add unrelated staged/untracked Git files to the fixture team; publish a reviewed artifact/bundle/proposal. Test read-only/offline remote.             | Only intended paths committed; unrelated index/worktree preserved; failure leaves personal source and review state recoverable.                        |
| SHR-07 | P1   | `share_propose`/provider-neutral Git proposal export/materialization from an approved Knowledge Delta.                                                | Preview read-only, exact selected/reviewed content, no implicit publication/provider dependence; unsafe path/body or stale preconditions refused.      |

## 15. Verified procedures

| ID     | Tier | Action                                                                                                                     | Pass invariant / evidence                                                                                                                   |
| ------ | ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| PRC-01 | P0   | Preview F7 procedure verification, including `--apply --dry-run`; then explicitly approve verification in the fixture.     | Preview executes nothing; only reviewed sentinel command runs on explicit apply/artifact; receipt binds exact manifest/artifact.            |
| PRC-02 | P1   | Inspect status for compatible/current, modified, unverified, incompatible and explicitly supplied newer manifest.          | Correct status; no download/auto-update/auto-execution or invented compatibility.                                                           |
| PRC-03 | P1   | Preview then explicitly approve full MCP/CLI publication into F6; test changed receipt/artifact and same-version conflict. | Exact immutable versioned files and privacy checks; stale or conflicting version rejected; unrelated Git state preserved.                   |
| PRC-04 | P0   | Request relevant brief with correct surface/dependencies/rollout, then incompatible/cold/conflicting procedure evidence.   | Only admitted verified metadata in bounded brief; dependency closure and gaps truthful; never embeds or executes downloaded command bodies. |

## 16. MCP transport, schema, presentation, and agent behavior

Use a real client connection to the packaged binary configured by the supported adapter. Do not substitute the CLI
for these MCP checks. Compare logical evidence, not byte-identical presentations across formats.

| ID     | Tier | Action                                                                                                                      | Pass invariant / evidence                                                                                                                                       |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP-01 | P0   | Initialize the real client; enumerate `tools/list` under core and full, and connect two hosts to one fixture home.          | Declared toolsets/capabilities correct; stdio clean; no hidden unsupported tools or per-host canonical isolation when sharing was intended.                     |
| MCP-02 | P0   | Run recall → read → brief → graph query/node → analyze → private handoff using actual MCP calls.                            | Correct task/cwd/project propagation; real results, semantic status checked; one successful transport response cannot mask a tool error.                        |
| MCP-03 | P0   | Request default/agent/text where supported and explicit dual; compare UTF-8 bytes, estimated tokens and returned facts.     | Compact useful default, no unnecessary duplicated JSON/body; canonical structured part remains schema-valid JSON, not markdown mislabeled as structuredContent. |
| MCP-04 | P0   | Small/large queries at supported budgets and limits; follow truncation continuation/nextAction.                             | Cap is a maximum, not a target; no padding; retained identifiers/gaps/actions usable; no silent omission of safety/freshness information.                       |
| MCP-05 | P1   | Submit invalid selector/enum/budget, nonexistent URI/node, relative caller cwd and wrong-scope handle.                      | Precise bounded validation/refusal; no mutation or expensive unintended widening; request is correctable from the returned guidance.                            |
| MCP-06 | P1   | Disconnect/reconnect/restart the host during reads and a supervised fixture mutation; inspect logs/stdout and memory state. | Protocol remains usable; exact recorded mutation inspected before retry; no blanket assumption that every mutating call is retry-idempotent.                    |
| MCP-07 | P0   | Fresh agent continuation uses F4 handoff and graph anchors; prompt with malicious instruction text returned from F5.        | Agent treats tool/repository/memory text as evidence, not authority to run/share/delete; current source and user approval remain decisive.                      |

Core/tool-capability coverage: `context_brief`, `recall_context`, `read_context`, `list_context`, `remember_context`,
`finalize_code_refs`, `inspect_code_graph`, `analyze_code_graph`, `review_session_context`, `apply_memory_candidates`,
`recall_feedback`, `share_publish`, `share_propose`, `threadnote_guide`, and `complete_activation_retrieval_proof` are
covered by the relevant scenario families. Full maintenance coverage includes `context_health`,
`context_health_aggregate`, `context_health_schedule`, `context_health_repair_preview/apply`,
`context_metadata_preview/apply`, and `procedure_publish_preview/apply`. Confirm actual membership at the candidate;
this list is a coverage map, not permission to expose every tool in every toolset.

## 17. Conditional integrations and lesser-used shipped surfaces

| ID     | Tier | Action                                                                                                                                                        | Pass invariant / evidence                                                                                                                         |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| INT-01 | C    | F9 Obsidian source add/inventory/sync/status/remove, preview then apply; include/exclude and symlink escape probes.                                           | Read-only source authority remains external/untrusted; allowlist enforced; original vault unchanged; sanitized eligible notes retrievable.        |
| INT-02 | C    | Projection add/publish/sync/status/remove, `obsidian_publish` through MCP, and open a projected F4 memory. Edit one generated note and add an unmanaged note. | Explicit selection only; edits/unmanaged notes preserved by default; drift visible; no unrelated corpus dump or path escape.                      |
| INT-03 | C    | Scan disposable Inbox preview/apply; enable/disable `image-projection` and read a synthetic memory containing a permitted image.                              | Inbox creates review candidates, not durable truth; image policy honored, safe path/type/size behavior; no arbitrary external fetching.           |
| INT-04 | C    | Verify supported Cursor cloud/local/personal profile bootstrap/config/verify and its restricted MCP catalog in a disposable environment.                      | Only declared capabilities and intended authority available; no extra credential inheritance, graph leakage or forged activation/identity proof.  |
| INT-05 | C    | Run composer against approved disposable Git/PostgreSQL/OAuth fixtures; test authorized, expired, wrong-team and missing credentials.                         | Tenant/access boundaries and supported local issuer respected; no implicit push or production access; safe failure, no credentials in evidence.   |
| INT-06 | C    | Exercise optional `local-ai` install/enable/status/model/start/stop/disable/uninstall and explicit additional `models` selection.                             | Honest consent/download policy and capability state; core embedding remains healthy; no hidden model download or loss of canonical memory.        |
| INT-07 | C    | Inspect `jev status` and applicable enrich-memories preview/apply on copied synthetic records.                                                                | Capability/fallback truthful; only approved scope changes; derived enrichment does not silently redefine reviewed engineering claims.             |
| INT-08 | P1   | `threadnote_guide` on missing setup/recovery and actual activation retrieval proof.                                                                           | Bounded actionable guidance, exact surface support, no auto-mutation; retrieval proof bound to a real observed brief/client, not claimed success. |

### Conditional shared-graph enrollment and authorization

| ID     | Tier | Action                                                                                                                                                                            | Pass invariant / evidence                                                                                                                                                                            |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INT-09 | C    | F10 `graph share init/status/join/leave`, including explicit read-only enrollment; index a receiver at a compatible source commit, then revoke consent.                           | Digest-pinned profile and exact repository authority; imported base verified before use; no implicit contribution or continued sharing after leave. Wrong identity/tampered artifact safely refused. |
| INT-10 | C    | F10 `graph publisher bootstrap/serve/status`; advance synthetic HEAD, interrupt publication and retry; test profile promotion only against the approved disposable registry.      | Signed candidate/frontier and confirmed versus pending registry state truthful; monotone compatible generations; no partial/tampered artifact activation or uncontrolled external push.              |
| INT-11 | C    | F10 `graph contribute status/set` through off/passive/idle/dedicated; inspect `graph worker` under the candidate's declared behavior.                                             | Consent honored; actual capabilities reported, including idle/dedicated passive delivery when applicable; no automatic source-code execution or overstated distributed-worker capability.            |
| INT-12 | C    | F10 `graph auth` and `graph auth registry` configure/login/logout with a test issuer; expired/wrong-audience/wrong-org probes; macOS Keychain and safe unsupported-platform path. | Graph control and read-only registry authority remain separate; tokens protected/rotated/removed as supported; no credential fallback across audiences, stdout leakage or implicit OS support claim. |

### Optional response-cost observation

| ID      | Tier | Action                                                                                                                                                           | Pass invariant / evidence                                                                                                                                                                                                             |
| ------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COST-01 | O    | Capture real MCP tool-catalog startup, selected skill reads, brief/recall/read/graph payload bytes, and first versus continued-session usage on synthetic tasks. | Attribute schema, presentation, actual useful evidence, cached/uncached provider usage and elapsed time separately. Record unavailable counters as unavailable; no token-savings claim from estimated bytes, failure or a single run. |

## 18. Privacy, diagnostics, and release delivery

| ID      | Tier | Action                                                                                                                                                             | Pass invariant / evidence                                                                                                                                                                                    |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SAFE-01 | P0   | Confirm telemetry off; inspect consent preview, explicit enable/disable with controlled sink; repeat with `DO_NOT_TRACK=1` and `THREADNOTE_TELEMETRY=0`.           | No export before consent or under kill switch; emitted spans contain only allowed operational fields, no task/source/body/URI/path/exception/credential content.                                             |
| SAFE-02 | P1   | Upgrade cloned old telemetry consent; exercise noninteractive/automatic update and an explicit consent preview.                                                    | Expanded data contract never approved by generic `--yes`; effective state and required consent action honest.                                                                                                |
| SAFE-03 | P0   | Inspect synthetic operational logs, `processes --json`, `doctor --dry-run` and `report-issue` preview.                                                             | Useful bounded typed diagnostics; no raw private content/secrets/public paths; no issue created by preview. Preview can legitimately omit sensitive detail.                                                  |
| SAFE-04 | P1   | Change report title/body/selected diagnostics after preview and try its old approval digest in a controlled submission fixture.                                    | Stale approval rejected; actual public issue submission only with separately explicit human authorization. No real GitHub test issue by default.                                                             |
| SAFE-05 | P0   | Insert synthetic malicious instructions/sensitive canaries into memory, source signatures and procedure metadata; read/recall/export/share through relevant cases. | Untrusted instructions inert; known share/privacy blockers enforced. Graph/checkpoint derived names/docs may carry source-embedded secrets: destination review required, not a claim of universal scrubbing. |
| SAFE-06 | P1   | Denied filesystem permissions, escaped/symlink targets and missing configuration in a disposable lane; inspect recovery copy.                                      | No broad delete/chmod, silent authority widening or secret/native-error leak; legitimate operations still recover after the exact fixture cause is resolved.                                                 |
| REL-01  | P0   | Inspect candidate CI, platform, Stage 3 and hosted scale references against source/executable identity.                                                            | Every applicable required artifact passed with correct provenance; no old-candidate relabeling, skipped-job-as-pass or local optional benchmark dependency.                                                  |
| REL-02  | P0   | After publication inspect immutable prerelease, exact tag/source, all six archives/checksums and installer/update selection.                                       | Correct beta marker/version, complete trustworthy payload; install real released binary in a clean lane. Prepublication source smokes cannot stand in for this row.                                          |
| REL-03  | P1   | Check published website release navigation/install links and prepared-note visibility without editing article content.                                             | Stable notes/article not exposed as released before actual stable publication; prerelease handling and links follow website contract; article PR remains untouched.                                          |
| REL-04  | P0   | Finish all owned clients/processes; inspect fixture cleanup and final doctor/recall/brief from a surviving clean lane.                                             | No orphaned graph/model workers, ownership leaks or unintended config/data loss; retained evidence private and sufficient to reproduce unresolved defects.                                                   |

## 19. Evidence and pass criteria

The skill's signoff template defines the candidate worksheet and per-scenario ledger. Outcomes are PASS / FAIL /
BLOCKED / NOT RUN / justified N/A. A shell exit zero, planning review, or attractive screenshot is insufficient.

Rules:

- PASS means the stated invariant was independently observed. A partial, unknown, stale or expected-refusal state
  passes only in a row that specifically expects and verifies it.
- All applicable P0 cases must pass for the intended beta lane coverage. P1/conditional omissions require explicit
  release-owner review, with the exact untested scope stated; no “complete E2E” claim from partial execution.
- Before stable, complete all applicable functional scenarios across the declared coverage lanes, alongside the
  authoritative release gates. Conditional absent non-advertised capabilities may be N/A with justification.
- Any data loss, secret exposure, wrong-scope/current evidence, unapproved canonical mutation/execution/sharing,
  integrity failure, unrecoverable hang or marketed-feature regression blocks the affected release claim.
- Candidate/runtime drift or an unverified MCP/Manager process invalidates its dependent results. A graph snapshot's
  source commit is not proof of the executable's build commit.
- A functional smoke cannot substantiate a p95/p99, portable performance, token-savings or article claim. Keep
  optional observations separate from the final experiment and governed benchmark evidence.
- After a fix, freeze a new reviewed candidate and rerun the reproducer, affected families and critical journey.
  Evidence from an older SHA remains historical, not relabeled. Keep current passing evidence and unresolved defect
  proof; do not accumulate redundant pilot bundles.

## 20. Preparation verification and next action

Preparation checked command families/toolset capabilities and the cited workflow/security/readiness contracts. The
matrix includes the latest known 5.1 regression scenarios and deliberately does not certify pending branches.
No manual E2E scenario, provider session, installer, global takeover, sharing action, fault injection or release
publication was executed while writing this document.

Next: use `release-signoff` on the reviewed post-fix candidate. Its report records actual execution; this preparation
document stays a reusable specification rather than a worker setup guide or completed signoff.
