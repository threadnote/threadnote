# Threadnote release signoff — <version> / <short-sha> / <phase>

Verdict: **NO-GO**
Run status: IN PROGRESS
Scope: <beta/stable; prerelease/postpublication; intended release coverage, not only available lanes>
Started / finished: <UTC timestamps>

## Candidate and run binding

| Field                                                                  | Evidence / value                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Exact source SHA / version / clean reviewed checkout                   | Not recorded                                                           |
| Distribution                                                           | Managed exact-HEAD development candidate or verified immutable release |
| Matrix revision / SHA-256                                              | Not recorded                                                           |
| Environment IDs; native/emulated OS/architecture/filesystem/shell      | Not recorded                                                           |
| Global launcher / real executable / SHA-256 per environment            | Private artifact locator; safe fingerprint in report                   |
| Payload, model, language-pack and runtime identities                   | Not recorded                                                           |
| MCP/Manager process binding; client versions/toolsets; reconnect proof | Not recorded                                                           |
| Global owner and takeover release, if needed                           | Not recorded                                                           |
| Pre/post-wave and per-case identity receipts                           | Not recorded                                                           |
| Approved integration/network authority                                 | Default no external writes                                             |
| Coordinator, workers/model, isolated domain IDs                        | Not recorded                                                           |

Raw absolute paths, account/client/browser profiles, home/install/launcher/manifest/fixture roots and ports belong
in the private execution ledger. Safe IDs here must map to that ledger; isolation cannot be assumed.

## Coverage and assignment

Expand matrix IDs into required platform/client/surface entries. List every ID, including deferred, conditional and
postpublication rows; use separate phase counts. Start each entry NOT RUN. Record explicit release-owner review for
any permitted scope deferral; unavailable required environments are BLOCKED, not N/A.

| Scenario    | Phase / lane / surface / repeat | Tier   | Owner / domain | Dependencies    | Outcome | Reason / evidence     |
| ----------- | ------------------------------- | ------ | -------------- | --------------- | ------- | --------------------- |
| <matrix ID> | <entry identity>                | <tier> | <owner>        | <prerequisites> | NOT RUN | No execution evidence |

Totals for declared phase/scope: <PASS> PASS / <FAIL> FAIL / <BLOCKED> BLOCKED / <NOT RUN> NOT RUN / <N/A> N/A.
Separately: <count> postpublication entries scheduled; <count> optional observations; <count> reviewed deferrals.

## Per-case evidence schema

Repeat this schema in each worker's private ledger; link bounded evidence from the coverage table.

```text
scenario / phase / lane / surface / repeat; owner / run ID / isolation domain:
candidate source SHA / global executable hash / payload and runtime / pre-post process identity:
fixture commits/hashes; intended dirty state; graph/home/team/client preconditions:
actual command or MCP tool + synthetic arguments; approved preview/apply distinction:
semantic observation; independent oracle/source/body verification; error and recovery:
canonical/config/Git before-after digests; expected versus unexpected mutation:
timestamps / wall time to useful result; UTF-8 bytes/product estimate; provider/cache usage or unavailable:
private relative evidence locator / digest; masked screenshot; exact CI/harness reference:
outcome PASS / FAIL / BLOCKED / NOT RUN / N/A and reason:
defect / retest candidate / owner / issue-PR reference:
```

## Authoritative gates

| Required gate / lane                | Exact candidate/artifact binding | Outcome | Evidence / blocker |
| ----------------------------------- | -------------------------------- | ------- | ------------------ |
| <from current release requirements> | Not verified                     | NOT RUN | Not recorded       |

Local optional heavy-tail attestation is not a gate. No copied green state from another candidate or skipped job.

## Defects and uncovered scope

| Row / candidate | Severity / expected vs actual  | Evidence / issue-PR | Fix owner / next retest | Release impact               |
| --------------- | ------------------------------ | ------------------- | ----------------------- | ---------------------------- |
| <if any>        | <bounded privacy-safe summary> | <locator>           | <next action>           | <blocks / reviewed deferral> |

## Postpublication verification

<Explicit NOT RUN schedule for publication-dependent checks, with owner and trigger; never mark them prepassed.>

## Cleanup and final decision

<Owned processes/resources stopped; safe retained evidence; restored frozen runtime identity; final surviving-lane checks.>

<Reasoned GO/NO-GO for named scope, exact remaining blockers, approved omissions, next actions. A smoke is not release-wide
signoff; GO does not authorize merge, tag or publication.>
