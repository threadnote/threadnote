import {Effect, Array as EffectArray, String as EffectString} from 'effect';

import {it as effectIt} from '@effect/vitest';

import {describe, expect} from 'vitest';

import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';

import * as Effect2 from 'effect';
import {completeLocalPhase, fixture, object, reviewed, run} from './native-cycle-lifecycle-fixture.js';

describe('native cycle lifecycle', () => {
  effectIt.effect('carries unresolved findings across an actual material authoring restart', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      const finding = {
        id: 'F001',
        file: 'source.ts',
        line: 1,
        body: 'Existing important defect.',
        trigger: 'Use the affected flow.',
        impact: 'Invalid source is accepted.',
        evidence: 'The defect remains in the unchanged source.',
        severity: 'important',
        category: 'correctness',
        confidence: 99,
        state: 'new',
      };
      yield* f.mutate('validate-review', {
        snapshotId: f.snapshot.snapshotId,
        attemptId: 'prior-blocker',
        report: {...f.report, findings: [finding]},
      });
      const plan = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase =>
          phase.id === 'one' ? {...phase, outcome: 'Amended approved phase outcome.'} : phase,
        ),
      });
      yield* f.mutate('reconcile', {plan, reason: 'Actual approved phase outcome changed.'});
      yield* f.mutate('resume-phase', {
        phaseId: 'one',
        reason: 'Review the amended contract; original blocker still exists.',
      });
      const restarted = object(
        object(
          (yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'restart', previous: f.snapshot.snapshotId}))
            .snapshot,
        ).snapshot,
      );
      expect(restarted.supersedes).toBe(f.snapshot.snapshotId);
      expect(restarted.previous).toBeUndefined();
      const report = {
        ...f.report,
        snapshotId: restarted.snapshotId,
        phaseHash: restarted.phaseHash,
        snapshotTree: restarted.tree,
        mode: 'full',
      };
      expect(
        yield* f.mutate('validate-review', {snapshotId: restarted.snapshotId, attemptId: 'missing-ledger', report}),
      ).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
      yield* f.mutate('validate-review', {
        snapshotId: restarted.snapshotId,
        attemptId: 'retained-ledger',
        report: {...report, findings: [{...finding, state: 'carried'}]},
      });
      const runtime = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
      expect(runtime.reviews).toHaveLength(2);
      expect(runtime.reviews.at(-1)?.report.findings[0]).toMatchObject({id: 'F001', state: 'carried'});
      expect(
        yield* f.mutate('ready', {phaseId: 'one', snapshotId: restarted.snapshotId}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'review-blocked'}});
    }).pipe(run),
  );

  effectIt.effect(
    'recovers an amended phase from its last accepted ledger while retaining an unreviewed snapshot',
    () =>
      Effect.gen(function* () {
        const f = yield* reviewed();
        const finding = {
          id: 'amendment-blocker',
          file: 'source.ts',
          line: 1,
          body: 'The accepted review still has an important defect.',
          trigger: 'Use the fixture source.',
          impact: 'The incomplete behavior remains reachable.',
          evidence: 'The fixture has not repaired the accepted finding.',
          severity: 'important',
          category: 'correctness',
          confidence: 99,
          state: 'new',
        };
        yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'amendment-first',
          report: {...f.report, findings: [finding]},
        });
        const ledger = object(
          object(
            (yield* f.mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'accepted-ledger',
              previous: f.snapshot.snapshotId,
            })).snapshot,
          ).snapshot,
        );
        yield* f.mutate('validate-review', {
          snapshotId: ledger.snapshotId,
          attemptId: 'amendment-ledger',
          report: {
            ...f.report,
            snapshotId: ledger.snapshotId,
            snapshotTree: ledger.tree,
            mode: 'incremental',
            findings: [{...finding, state: 'carried'}],
          },
        });
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "unreviewed";\n');
        const unreviewed = object(
          object(
            (yield* f.mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'unreviewed-before-amendment',
              previous: ledger.snapshotId,
            })).snapshot,
          ).snapshot,
        );
        expect(
          yield* f
            .mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'same-contract-skip',
              previous: ledger.snapshotId,
              reason: 'An explanation cannot waive the same-contract review.',
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'review-history'}});
        const before = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        const plan = yield* f.revise({
          phases: EffectArray.map(f.document.phases, phase =>
            phase.id === 'one'
              ? {...phase, outcome: 'The approved material amendment requires a full current review.'}
              : phase,
          ),
        });
        const oldReport = {
          ...f.report,
          snapshotId: unreviewed.snapshotId,
          snapshotTree: unreviewed.tree,
          mode: 'incremental',
          findings: [{...finding, state: 'carried'}],
        };
        expect(
          yield* f
            .mutate('validate-review', {
              snapshotId: unreviewed.snapshotId,
              attemptId: 'historical-must-not-be-admitted',
              report: oldReport,
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'plan-drift'}});
        yield* f.mutate('reconcile', {plan, reason: 'Approved material amendment after the external source review.'});
        yield* f.mutate('resume-phase', {
          phaseId: 'one',
          reason: 'Capture current amended work without inventing old review evidence.',
        });
        expect(
          yield* f
            .mutate('validate-review', {
              snapshotId: unreviewed.snapshotId,
              attemptId: 'historical-still-stale',
              report: oldReport,
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'review-stale'}});
        expect(
          yield* f
            .mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'still-needs-report',
              previous: unreviewed.snapshotId,
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'review-pending'}});
        const untouched = yield* f.fs.readFileString(f.statePath());
        for (const fields of [
          {previous: f.snapshot.snapshotId, reason: 'Do not skip the later accepted ledger.'},
          {previous: ledger.snapshotId},
          {previous: ledger.snapshotId, reason: '  '},
          {previous: 'missing-predecessor', reason: 'A missing predecessor is not accepted evidence.'},
        ]) {
          expect(
            yield* f
              .mutate('snapshot', {
                phaseId: 'one',
                snapshotId: 'invalid-amendment-recovery',
                ...fields,
              })
              .pipe(Effect.result),
          ).toMatchObject({failure: {code: 'review-history'}});
          expect(yield* f.fs.readFileString(f.statePath())).toBe(untouched);
        }
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "current amended";\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Current amended source']);
        const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        const recovery = {
          phaseId: 'one',
          snapshotId: 'current-full-recovery',
          previous: ledger.snapshotId,
          reason: 'Supersede only unreviewed snapshots invalidated by the approved material amendment.',
        };
        expect(yield* f.mutate('snapshot', recovery).pipe(Effect.result)).toMatchObject({
          failure: {code: 'head-drift'},
        });
        const current = object(
          object((yield* f.mutate('snapshot', {...recovery, acceptedHead: head})).snapshot).snapshot,
        );
        expect(current).toMatchObject({supersedes: ledger.snapshotId, head, baseTree: ledger.baseTree});
        expect(current.previous).toBeUndefined();
        const after = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        expect(after.baselines).toEqual(before.baselines);
        expect(after.snapshots.slice(0, before.snapshots.length)).toEqual(before.snapshots);
        expect(after.reviews).toEqual(before.reviews);
        expect(after.attempts).toEqual(before.attempts);
        expect(EffectArray.some(after.reviews, item => item.snapshotId === unreviewed.snapshotId)).toBe(false);
        const report = {
          ...f.report,
          snapshotId: current.snapshotId,
          phaseHash: current.phaseHash,
          snapshotTree: current.tree,
          mode: 'full',
        };
        expect(
          yield* f.mutate('validate-review', {
            snapshotId: current.snapshotId,
            attemptId: 'recovery-missing-blocker',
            report,
          }),
        ).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
        expect(
          yield* f.mutate('validate-review', {
            snapshotId: current.snapshotId,
            attemptId: 'recovery-missing-simplicity',
            report: {
              ...report,
              selected: ['correctness'],
              lanes: [{name: 'correctness', status: 'complete'}],
              findings: [{...finding, state: 'carried'}],
            },
          }),
        ).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
        const carried = {
          snapshotId: current.snapshotId,
          attemptId: 'recovery-full-report',
          report: {...report, findings: [{...finding, state: 'carried'}]},
        };
        expect(yield* f.mutate('validate-review', carried).pipe(Effect.result)).toMatchObject({
          failure: {code: 'review-failed'},
        });
        expect(
          yield* f.mutate('validate-review', {
            ...carried,
            userAuthority:
              'The private fixture authorizes this corrected full report after two retained invalid attempts.',
          }),
        ).toMatchObject({status: 'ok'});
        expect(
          yield* f.mutate('ready', {phaseId: 'one', snapshotId: current.snapshotId}).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'review-blocked'}});
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "later drift";\n');
        expect(
          yield* f.mutate('ready', {phaseId: 'one', snapshotId: current.snapshotId}).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'source-drift'}});
      }).pipe(run),
  );

  effectIt.effect('does not bypass an unreviewed snapshot when the accepted ledger matches the current contract', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      yield* f.mutate('validate-review', {
        snapshotId: f.snapshot.snapshotId,
        attemptId: 'original-contract',
        report: f.report,
      });
      const amended = yield* f.revise({
        phases: EffectArray.map(f.document.phases, phase =>
          phase.id === 'one' ? {...phase, outcome: 'Temporary approved material amendment.'} : phase,
        ),
      });
      yield* f.mutate('reconcile', {plan: amended, reason: 'Inspect the temporary approved contract.'});
      yield* f.mutate('resume-phase', {phaseId: 'one', reason: 'Capture the temporary contract.'});
      yield* f.mutate('snapshot', {
        phaseId: 'one',
        snapshotId: 'unreviewed-temporary-contract',
        previous: f.snapshot.snapshotId,
      });
      const root = object(object(amended.source).root);
      const saved = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'save',
            document: f.document,
            ready: true,
            uri: root.uri,
            expectedRevision: root.revision,
          }),
        ).authoring,
      );
      const restored = object(
        object(
          yield* f.call({
            ...f.base('authoring'),
            command: 'export-dev-cycle',
            uri: object(saved.root).uri,
            delivery: 'pr',
            bindings: {
              one: {branch: 'feature/one', baseBranch: 'main'},
              two: {branch: 'feature/two', baseBranch: 'feature/one'},
            },
          }),
        ).authoring,
      );
      yield* f.mutate('reconcile', {
        plan: restored,
        reason: 'Restore the original material contract through a newly saved root.',
      });
      yield* f.mutate('resume-phase', {
        phaseId: 'one',
        reason: 'The restored contract still requires its latest snapshot review.',
      });
      const before = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* f
          .mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'invalid-same-ledger-contract',
            previous: f.snapshot.snapshotId,
            reason: 'Material differences in an intervening snapshot are insufficient.',
          })
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'review-history'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  for (const field of ['outcome', 'contracts', 'verification'] as const) {
    effectIt.effect(`invalidates a changed authoring ${field} and descendants while retaining unrelated proof`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(['independent', 'one', 'two'], 'local');
        yield* completeLocalPhase(f, 'independent');
        yield* f.git(['checkout', '-b', 'feature/one']);
        yield* f.mutate('begin-phase', {phaseId: 'one'});
        yield* completeLocalPhase(f, 'one');
        const before = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        const phases = EffectArray.map(f.document.phases, phase =>
          phase.id !== 'one'
            ? phase
            : field === 'verification'
              ? {
                  ...phase,
                  acceptance: EffectArray.map(phase.acceptance, item => ({
                    ...item,
                    verification: 'New approved observable verification.',
                  })),
                }
              : field === 'contracts'
                ? {...phase, contracts: ['New approved external contract.']}
                : {...phase, outcome: 'New approved outcome.'},
        );
        const plan = yield* f.revise({phases});
        const result = yield* f.mutate('reconcile', {plan, reason: 'Actual saved ready phase definition changed.'});
        expect(result.affected).toEqual(['one', 'two']);
        const after = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        expect(after.state.phases.independent).toEqual(before.state.phases.independent);
        expect(after.state.phases.one?.status).toBe('stale');
        expect(after.state.phases.one?.history?.at(-1)?.validation).toEqual(before.state.phases.one?.validation);
        expect(after.state.phases.two?.status).toBe('stale');
        expect(after.state.phases.one?.phaseHash).not.toBe(before.state.phases.one?.phaseHash);
      }).pipe(run),
    );
  }

  effectIt.effect('follows the review-attempt continuation when replay exceeds the response budget', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      const report = {
        ...f.report,
        findings: Array.from({length: 20}, (_, index) => ({
          id: 'minor-' + index,
          file: 'source.ts',
          line: 1,
          body: Effect2.pipe('Detailed finding. ', EffectString.repeat(30)),
          trigger: 'Use the private flow.',
          impact: 'A minor usability gap.',
          evidence: 'Exact current source.',
          severity: 'minor',
          category: 'quality',
          confidence: 90,
          state: 'new',
        })),
      };
      const fields = {snapshotId: f.snapshot.snapshotId, attemptId: 'large-attempt', report, maxBytes: 8192};
      yield* f.mutate('validate-review', fields);
      const replay = yield* f.mutate('validate-review', fields);
      expect(replay).toMatchObject({
        available: false,
        continuation: {detailKind: 'attempt', attemptId: 'large-attempt'},
      });
      const continuation = object(replay.continuation);
      let content = '';
      let offsetBytes = 0;
      let sourceDigest: unknown;
      while (true) {
        const result = yield* f.call({
          ...f.base('cycle'),
          ...continuation,
          maxBytes: 8192,
          offsetBytes,
          ...(sourceDigest ? {sourceDigest} : {}),
        });
        const page = object(object(result).page);
        if (typeof page.text !== 'string') throw new Error('Expected a UTF-8 text page.');
        content += page.text;
        sourceDigest = page.sourceDigest;
        if (page.nextOffsetBytes === null) break;
        if (typeof page.nextOffsetBytes !== 'number') throw new Error('Expected the next offset to be numeric.');
        offsetBytes = page.nextOffsetBytes;
      }
      expect(JSON.parse(content)).toEqual(report);
      const invalidFields = {...fields, attemptId: 'large-invalid-attempt', report: {...report, lanes: []}};
      expect(yield* f.mutate('validate-review', invalidFields)).toMatchObject({
        status: 'error',
        code: 'invalid-cycle-review',
      });
      expect(yield* f.mutate('validate-review', invalidFields)).toMatchObject({
        available: false,
        status: 'error',
        code: 'invalid-cycle-review',
        continuation: {detailKind: 'attempt', attemptId: 'large-invalid-attempt'},
      });
    }).pipe(run),
  );

  effectIt.effect(
    'blocks advancement on a changed ready root and retains both plan provenances after explicit reconciliation',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const root = object(object(f.exported.source).root);
        const changed = {...f.document, objective: 'Revised approved delivery objective.'};
        const saved = object(
          object(
            yield* f.call({
              ...f.base('authoring'),
              command: 'save',
              document: changed,
              ready: true,
              uri: root.uri,
              expectedRevision: root.revision,
            }),
          ).authoring,
        );
        const before = yield* f.fs.readFileString(f.statePath());
        expect(yield* f.call({...f.base('cycle'), command: 'next'}).pipe(Effect.result)).toMatchObject({
          failure: {code: 'plan-drift'},
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        const plan = object(
          object(
            yield* f.call({
              ...f.base('authoring'),
              command: 'export-dev-cycle',
              uri: object(saved.root).uri,
              delivery: 'pr',
              bindings: {
                one: {branch: 'feature/one', baseBranch: 'main'},
                two: {branch: 'feature/two', baseBranch: 'feature/one'},
              },
            }),
          ).authoring,
        );
        yield* f.mutate('reconcile', {plan, reason: 'Actual saved ready root changed the material objective.'});
        const resumed = yield* f.mutate('resume-phase', {
          phaseId: 'one',
          reason: 'Start a fresh source review for the changed objective.',
        });
        expect(resumed.next).toEqual({action: 'implement', phaseId: 'one'});
        const runtime = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        expect(runtime.plans).toHaveLength(2);
        expect(runtime.plans[0]?.source.root.revision).toBe(root.revision);
        expect(runtime.plans[1]?.source.root.revision).toBe(object(saved.root).revision);
      }).pipe(run),
  );

  effectIt.effect('keeps a continuous review budget and persists explicit expansions without resetting history', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let previous: string | undefined;
      for (let iteration = 1; iteration <= 6; iteration++) {
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const fixture = ${iteration};\n`);
        const id = 'review-' + iteration;
        const captured = yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: id, ...(previous ? {previous} : {})});
        const snapshot = object(object(captured.snapshot).snapshot);
        const fields = {
          snapshotId: id,
          attemptId: id,
          report: {
            snapshotId: id,
            phaseHash: snapshot.phaseHash,
            snapshotTree: snapshot.tree,
            status: 'complete',
            mode: previous ? 'incremental' : 'full',
            selected: ['correctness', 'simplicity'],
            lanes: [
              {name: 'correctness', status: 'complete'},
              {name: 'simplicity', status: 'complete'},
            ],
            findings: [],
          },
        };
        if (iteration === 6) {
          const before = yield* f.fs.readFileString(f.statePath());
          expect(yield* f.mutate('validate-review', fields).pipe(Effect.result)).toMatchObject({
            failure: {code: 'review-budget'},
          });
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          expect(yield* f.mutate('extend-reviews', {phaseId: 'one', reviewLimit: 6}).pipe(Effect.result)).toMatchObject(
            {failure: {code: 'invalid-request'}},
          );
          yield* f.mutate('extend-reviews', {
            phaseId: 'one',
            reviewLimit: 6,
            userAuthority: 'Human authorized six reviews for this private fixture.',
          });
        }
        yield* f.mutate('validate-review', fields);
        previous = id;
      }
      const runtime = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
      expect(runtime.reviews).toHaveLength(6);
      expect(runtime.reviewExpansions).toEqual([
        {phaseId: 'one', from: 5, to: 6, authority: 'Human authorized six reviews for this private fixture.'},
      ]);
      expect(() => decodeNativeCycleRuntime({...runtime, reviewLimits: {one: 99}})).toThrow();
    }).pipe(run),
  );
});
