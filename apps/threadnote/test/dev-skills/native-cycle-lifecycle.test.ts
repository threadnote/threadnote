import {Effect, Array as EffectArray, String as EffectString} from 'effect';

import {it as effectIt} from '@effect/vitest';

import {describe, expect} from 'vitest';

import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';

import {sha256HexSync} from '@threadnote/platform/sha256';

import * as Effect2 from 'effect';
import {fixture, object, reviewed, run} from './native-cycle-lifecycle-fixture.js';

describe('native cycle lifecycle', () => {
  effectIt.effect('preserves immutable legacy evidence and readiness while refusing current self-review', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      const legacy = {
        ...f.report,
        selected: ['orchestrator'],
        lanes: [{name: 'orchestrator', status: 'complete'}],
      };
      const bytes = JSON.stringify(legacy);
      const runtime = JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle;
      const stored = {...runtime, reviews: [{snapshotId: f.snapshot.snapshotId, report: legacy}]};
      expect(decodeNativeCycleRuntime(stored).reviews[0].report).toEqual(legacy);
      expect(JSON.stringify(legacy)).toBe(bytes);
      expect(() =>
        decodeNativeCycleRuntime({
          ...stored,
          reviews: [{snapshotId: f.snapshot.snapshotId, report: {...legacy, lanes: []}}],
        }),
      ).toThrow();
      expect(
        yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'legacy-current-rejected',
          report: legacy,
        }),
      ).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
      expect(
        yield* f.mutate('ready', {phaseId: 'one', snapshotId: f.snapshot.snapshotId}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'review-pending'}});
      yield* f.mutate('validate-review', {
        snapshotId: f.snapshot.snapshotId,
        attemptId: 'independent-current-review',
        report: f.report,
      });
      yield* f.mutate('ready', {
        phaseId: 'one',
        snapshotId: f.snapshot.snapshotId,
        validation: {
          snapshotTree: f.snapshot.tree,
          reviewTree: f.snapshot.tree,
          status: 'passed',
          productState: 'working',
          checks: [{command: 'private flow', result: 'passed', evidence: 'Real source fixture.'}],
          acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private source readback.'}],
        },
      });
      const envelope = JSON.parse(yield* f.fs.readFileString(f.statePath()));
      const accepted = decodeNativeCycleRuntime(envelope.cycle);
      const legacyReady = {
        ...accepted,
        reviews: [{snapshotId: f.snapshot.snapshotId, report: legacy}],
        attempts: EffectArray.map(accepted.attempts, attempt =>
          attempt.status === 'accepted' ? {...attempt, report: bytes, digest: sha256HexSync(bytes)} : attempt,
        ),
      };
      expect(decodeNativeCycleRuntime(JSON.parse(JSON.stringify(legacyReady)))).toEqual(legacyReady);
      expect(legacyReady.state.phases.one.status).toBe('validated');
      expect(legacyReady.state).toEqual(accepted.state);
      yield* f.fs.writeFileString(f.statePath(), JSON.stringify({...envelope, cycle: legacyReady}));
      const unchanged = yield* f.fs.readFileString(f.statePath());
      yield* f.inspect();
      expect(
        yield* f.mutate('ready', {phaseId: 'one', snapshotId: f.snapshot.snapshotId}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-cycle-review'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(unchanged);
    }).pipe(run),
  );

  effectIt.effect('keeps stable-base incremental patch detail limited to the new source delta', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      yield* f.mutate('validate-review', {
        snapshotId: f.snapshot.snapshotId,
        attemptId: 'initial-review',
        report: f.report,
      });
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "phase two";\n');
      yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'incremental-patch', previous: f.snapshot.snapshotId});
      const detail = object(
        yield* f.call({
          ...f.base('cycle'),
          command: 'detail',
          snapshotId: 'incremental-patch',
          detailKind: 'patch',
          maxBytes: 8192,
        }),
      );
      expect(object(detail.page).text).toContain('-export const fixture = "phase one";');
      expect(object(detail.page).text).toContain('+export const fixture = "phase two";');
      expect(object(detail.page).text).not.toContain('Declared-base scope delta');
    }).pipe(run),
  );

  effectIt.effect('checks declared-base deletions even when they cancel out of the original baseline diff', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.git(['checkout', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const upstream = true;\n');
      yield* f.git(['add', 'upstream.ts']);
      yield* f.git(['commit', '-m', 'Upstream addition']);
      yield* f.git(['checkout', 'feature/one']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "owned";\n');
      // A disjoint base advance does not force an unrelated rebase.
      const first = object(
        object((yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'before-upstream-merge'})).snapshot).snapshot,
      );
      expect(first.files).toEqual(['source.ts']);
      yield* f.mutate('validate-review', {
        snapshotId: first.snapshotId,
        attemptId: 'before-upstream-review',
        report: {
          snapshotId: first.snapshotId,
          phaseHash: first.phaseHash,
          snapshotTree: first.tree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Owned phase source']);
      yield* f.git(['merge', '--no-edit', 'main']);
      yield* f.fs.remove(f.path.join(f.repo, 'upstream.ts'));
      const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const before = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* f
          .mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'canceled-unowned',
            previous: first.snapshotId,
            acceptedHead: head,
            reason: 'Actual upstream merge followed by unowned deletion.',
          })
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'phase-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('retains exact shared upstream entries when the declared base advances disjointly', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.git(['checkout', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const upstream = true;\n');
      yield* f.git(['add', 'upstream.ts']);
      yield* f.git(['commit', '-m', 'Shared upstream']);
      const common = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      yield* f.git(['checkout', 'feature/one']);
      yield* f.git(['merge', '--no-edit', 'main']);
      yield* f.git(['checkout', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'later.ts'), 'export const later = true;\n');
      yield* f.git(['add', 'later.ts']);
      yield* f.git(['commit', '-m', 'Disjoint later upstream']);
      const declared = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      yield* f.git(['checkout', 'feature/one']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "owned";\n');
      const result = object(
        (yield* f.mutate('snapshot', {
          phaseId: 'one',
          snapshotId: 'disjoint-upstream',
          acceptedHead: common,
          reason: 'Actual shared upstream; later base changes are disjoint.',
        })).snapshot,
      );
      expect(result.incoming).toMatchObject([{path: 'upstream.ts', source: 'upstream', commit: common}]);
      expect(object(result.snapshot).declaredBaseHead).toBe(declared);
      expect(object(result.snapshot).scopeFiles).toEqual(['source.ts']);
      expect(object(result.snapshot).files).toEqual(['source.ts', 'upstream.ts']);
    }).pipe(run),
  );

  effectIt.effect(
    'includes the declared-base patch when an owned upstream change cancels from the fixed baseline',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'));
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const upstreamContract = true;\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Upstream owned-path change']);
        yield* f.git(['checkout', 'feature/one']);
        yield* f.git(['merge', '--no-edit', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), original);
        const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
        const captured = object(
          object(
            (yield* f.mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'owned-cancellation',
              acceptedHead: head,
              reason: 'Actual merged upstream followed by an owned source edit.',
            })).snapshot,
          ).snapshot,
        );
        expect(captured.files).toEqual(['source.ts']);
        expect(captured.scopeFiles).toEqual(['source.ts']);
        expect(captured.baseTree).toBe(captured.tree);
        const patch = object(
          yield* f.call({
            ...f.base('cycle'),
            command: 'detail',
            snapshotId: captured.snapshotId,
            detailKind: 'patch',
            maxBytes: 8192,
          }),
        );
        expect(object(patch.page).text).toContain('Declared-base scope delta');
        expect(object(patch.page).text).toContain('-export const upstreamContract = true;');
      }).pipe(run),
  );

  effectIt.effect('retains exact pre-existing unowned staging as separate source evidence', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one', 'two'], 'pr', true);
      const indexPath = f.path.join(f.repo, '.git', 'index');
      const index = yield* f.fs.readFile(indexPath);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "owned";\n');
      const captured = object(
        (yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'preserved-user-work'})).snapshot,
      );
      expect(captured.incoming).toMatchObject([{path: 'user-note.txt', source: 'preserved', mode: '100644'}]);
      expect(yield* f.fs.readFile(indexPath)).toEqual(index);
      const snapshot = object(captured.snapshot);
      yield* f.mutate('validate-review', {
        snapshotId: snapshot.snapshotId,
        attemptId: 'preserved-review',
        report: {
          snapshotId: snapshot.snapshotId,
          phaseHash: snapshot.phaseHash,
          snapshotTree: snapshot.tree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      expect(
        yield* f
          .mutate('ready', {
            phaseId: 'one',
            snapshotId: snapshot.snapshotId,
            validation: {
              snapshotTree: snapshot.tree,
              reviewTree: snapshot.tree,
              status: 'passed',
              productState: 'working',
              checks: [{command: 'private flow', result: 'passed', evidence: 'Exact fixture.'}],
              acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Owned source works.'}],
            },
          })
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'preserved-work-publication'}});
      yield* f.fs.remove(f.path.join(f.repo, 'user-note.txt'));
      expect(
        yield* f
          .mutate('snapshot', {phaseId: 'one', snapshotId: 'removed-user-work', previous: snapshot.snapshotId})
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'phase-scope'}});
      expect(yield* f.fs.readFile(indexPath)).toEqual(index);
    }).pipe(run),
  );

  effectIt.effect('keeps baseline pins distinct from every valid snapshot identifier', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "changed";\n');
      const result = yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'baseline-one'});
      const snapshot = object(object(result.snapshot).snapshot);
      const runtime = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
      expect(runtime.baselines.one?.pinnedRef).toContain('/baseline/');
      expect(snapshot.pinnedRef).toContain('/snapshot/');
      expect(snapshot.pinnedRef).not.toBe(runtime.baselines.one?.pinnedRef);
    }).pipe(run),
  );

  effectIt.effect('pins the original baseline before implementation and rejects committed unowned source', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const initial = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle).baselines
        .one;
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "committed";\n');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'config.ts'), 'export const unauthorized = true;\n');
      yield* f.git(['add', 'source.ts', 'config.ts']);
      yield* f.git(['commit', '-m', 'Before first review']);
      const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const before = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* f
          .mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'committed',
            acceptedHead: head,
            reason: 'Actual pre-review commit.',
          })
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'phase-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      yield* f.git(['rm', 'config.ts']);
      yield* f.git(['commit', '-m', 'Remove unowned source']);
      const ownedHead = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const captured = object(
        object(
          (yield* f.mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'owned',
            acceptedHead: ownedHead,
            reason: 'Owned committed source only.',
          })).snapshot,
        ).snapshot,
      );
      expect(captured.baseTree).toBe(initial?.tree);
      expect(captured.files).toEqual(['source.ts']);
      expect(captured.tree).not.toBe(captured.baseTree);
      expect(
        yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'changed-base', base: 'HEAD'}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'review-history'}});
    }).pipe(run),
  );

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
        phases: f.document.phases.map(phase =>
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
          phases: f.document.phases.map(phase =>
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
        const head = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
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
        expect(after.reviews.some(item => item.snapshotId === unreviewed.snapshotId)).toBe(false);
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
              selected: ['orchestrator'],
              lanes: [{name: 'orchestrator', status: 'complete'}],
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
        phases: f.document.phases.map(phase =>
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
        const phases = f.document.phases.map(phase =>
          phase.id !== 'one'
            ? phase
            : field === 'verification'
              ? {
                  ...phase,
                  acceptance: phase.acceptance.map(item => ({
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
          body: 'Detailed finding. '.repeat(30),
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
        offsetBytes = page.nextOffsetBytes as number;
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
            selected: ['orchestrator'],
            lanes: [{name: 'orchestrator', status: 'complete'}],
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

  effectIt.effect('verifies ready graph, actual anchors, ownership and packet budgets before routine dispatch', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const graph = object(object(yield* f.call(f.base('graph-ready'))).graph);
      const captured = yield* captureNativeCycleSource(f.repo, 'HEAD');
      const options = {
        capacity: {
          model: 'advertised-cheap-model',
          effort: 'low',
          selection: 'least-sufficient',
          risk: 'settled',
          reason: 'Bounded established implementation with verified anchors.',
          catalogEvidence: 'Test host advertises low effort.',
        },
        graphProof: {...graph, tree: captured.tree},
        anchors: [
          {
            path: 'source.ts',
            sha256: sha256HexSync(yield* f.fs.readFile(f.path.join(f.repo, 'source.ts'))),
            pattern: 'fixture',
          },
        ],
        ownership: ['source.ts'],
        checks: ['private check'],
        detailRefs: ['native-plan:one'],
      };
      const packet = yield* f.call({...f.base('cycle'), command: 'packet', phaseId: 'one', packet: options});
      expect(packet).toMatchObject({available: true, capacity: {effort: 'low'}, acceptanceCriteria: ['one works']});
      expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThan(12_288);
      const tiny = yield* f.call({
        ...f.base('cycle'),
        command: 'packet',
        phaseId: 'one',
        packet: {...options, budgetBytes: 1024},
      });
      expect(tiny).toMatchObject({available: false, reason: 'packet-budget-exceeded', detailRefs: ['native-plan:one']});
      const wrong = yield* f
        .call({
          ...f.base('cycle'),
          command: 'packet',
          phaseId: 'one',
          packet: {...options, anchors: [{...options.anchors[0], pattern: 'absent literal'}]},
        })
        .pipe(Effect.result);
      expect(wrong).toMatchObject({failure: {code: 'anchor-drift'}});
      const scope = yield* f
        .call({...f.base('cycle'), command: 'packet', phaseId: 'one', packet: {...options, ownership: ['outside.ts']}})
        .pipe(Effect.result);
      expect(scope).toMatchObject({failure: {code: 'phase-scope'}});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const changed = true;\n');
      const query = yield* CodeGraphQueryService;
      const indexer = yield* CodeGraphIndexer;
      let graphObservations = 0;
      let graphPreparations = 0;
      const drift = yield* f.call({...f.base('cycle'), command: 'packet', phaseId: 'one', packet: options}).pipe(
        Effect.provideService(CodeGraphQueryService, {
          ...query,
          status: (...args) =>
            Effect.suspend(() => {
              graphObservations++;
              return query.status(...args);
            }),
        }),
        Effect.provideService(CodeGraphIndexer, {
          ...indexer,
          index: (...args) =>
            Effect.suspend(() => {
              graphPreparations++;
              return indexer.index(...args);
            }),
        }),
        Effect.result,
      );
      expect(drift).toMatchObject({failure: {code: 'source-drift'}});
      expect(graphObservations).toBe(0);
      expect(graphPreparations).toBe(0);
    }).pipe(run),
  );

  effectIt.effect(
    'admits exact read-only upstream blobs while preserving the original review baseline and rejecting unowned edits',
    () =>
      Effect.gen(function* () {
        const f = yield* reviewed();
        yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'before-incoming',
          report: f.report,
        });
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Phase source']);
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const upstream = true;\n');
        yield* f.git(['add', 'upstream.ts']);
        yield* f.git(['commit', '-m', 'Independent upstream']);
        const upstream = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
        yield* f.git(['checkout', 'feature/one']);
        yield* f.git(['merge', '--no-edit', 'main']);
        const acceptedHead = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
        const result = yield* f.mutate('snapshot', {
          phaseId: 'one',
          snapshotId: 'after-incoming',
          previous: f.snapshot.snapshotId,
          acceptedHead,
          reason: 'Actual normal upstream merge; retain fixed baseline and exact upstream content.',
        });
        const entry = object(result.snapshot);
        const snapshot = object(entry.snapshot);
        expect(snapshot.baseTree).toBe(f.snapshot.baseTree);
        expect(entry.incoming).toEqual([
          {
            path: 'upstream.ts',
            mode: '100644',
            source: 'upstream',
            tree: (yield* f.git(['rev-parse', upstream + '^{tree}'])).stdout.trim(),
            blob: (yield* f.git(['rev-parse', upstream + ':upstream.ts'])).stdout.trim(),
            commit: upstream,
          },
        ]);
        yield* f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'incoming-review',
          report: {...f.report, snapshotId: snapshot.snapshotId, snapshotTree: snapshot.tree, mode: 'incremental'},
        });
        // Git index modes are portable even when the host filesystem has no executable bit.
        yield* f.git(['config', 'core.filemode', 'false']);
        yield* f.git(['update-index', '--chmod=+x', 'upstream.ts']);
        yield* f.git(['commit', '-m', 'Unowned mode edit']);
        const modeHead = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
        expect(
          yield* f
            .mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'unowned-mode',
              previous: snapshot.snapshotId,
              acceptedHead: modeHead,
              reason: 'Actual unowned mode change.',
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'phase-scope'}});
        yield* f.git(['update-index', '--chmod=-x', 'upstream.ts']);
        yield* f.git(['commit', '-m', 'Restore upstream mode']);
        const restoredHead = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
        yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const tampered = true;\n');
        expect(
          yield* f
            .mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'unowned-edit',
              previous: snapshot.snapshotId,
              acceptedHead: restoredHead,
              reason: 'Actual unowned bytes changed.',
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'phase-scope'}});
      }).pipe(run),
  );

  effectIt.effect('delivers one phase and immediately permits the next with an open draft PR and pending CI', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      yield* f.mutate('validate-review', {snapshotId: f.snapshot.snapshotId, attemptId: 'review-1', report: f.report});
      const ready = yield* f.mutate('ready', {
        phaseId: 'one',
        snapshotId: f.snapshot.snapshotId,
        validation: {
          snapshotTree: f.snapshot.tree,
          reviewTree: f.snapshot.tree,
          status: 'passed',
          productState: 'working',
          checks: [{command: 'private flow', result: 'passed', evidence: 'Real source fixture.'}],
          acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private source readback.'}],
        },
      });
      expect(ready.next).toEqual({action: 'deliver', phaseId: 'one'});
      expect(
        yield* f.mutate('snapshot', {phaseId: 'two', snapshotId: 'two-too-early'}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'delivery-pending'}});
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Phase one']);
      const head = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
      const delivered = yield* f.mutate('record-delivery', {
        phaseId: 'one',
        publication: {exemption: 'maintenance', reason: 'Private test, no feature publication.'},
        delivery: {
          phaseId: 'one',
          phaseHash: f.snapshot.phaseHash,
          delivery: 'pr',
          headSha: head,
          validatedTree: f.snapshot.tree,
          commitEvidence: 'Actual clean Git commit.',
          pr: {
            url: 'https://github.com/example/private-fixture/pull/1',
            headSha: head,
            branch: 'feature/one',
            baseBranch: 'main',
            state: 'open',
          },
          watch: {
            prUrl: 'https://github.com/example/private-fixture/pull/1',
            headSha: head,
            state: 'active',
            stateDir: f.path.join(f.root, 'watch'),
            consumerKind: 'orchestrator',
            consumerId: 'test',
            evidence: 'Private owned consumer fixture; no external poller.',
          },
        },
      });
      expect(delivered.next).toEqual({action: 'implement', phaseId: 'two'});
      expect((yield* f.inspect()).next).toEqual({action: 'implement', phaseId: 'two'});
      const before = yield* f.fs.readFileString(f.statePath());
      expect(yield* f.mutate('init', {plan: {schemaVersion: 1, phases: []}}).pipe(Effect.result)).toMatchObject({
        failure: {code: 'invalid-cycle'},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      const invalidated = yield* f.mutate('invalidate', {phaseId: 'one', reason: 'Actual current-head CI failure.'});
      expect(invalidated.next).toMatchObject({action: 'blocked', phaseId: 'one'});
      const state = JSON.parse(yield* f.fs.readFileString(f.statePath()));
      const runtime = decodeNativeCycleRuntime(state.cycle);
      expect(runtime.state.phases.one?.delivery).toBeUndefined();
      expect(runtime.state.phases.one?.history?.[0]?.delivery?.headSha).toBe(head);
      expect(runtime.state.phases.two?.status).toBe('stale');
    }).pipe(run),
  );

  effectIt.effect(
    'preserves malformed review evidence, rejects stale source and stale CAS, and recovers failed receipt writes',
    () =>
      Effect.gen(function* () {
        const f = yield* reviewed();
        const stale = yield* f.inspect();
        const invalid = yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'malformed-1',
          report: {...f.report, lanes: []},
        });
        expect(invalid).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
        const afterInvalid = yield* f.fs.readFileString(f.statePath());
        expect(
          yield* f
            .call({
              ...f.base('cycle'),
              command: 'invalidate',
              phaseId: 'one',
              reason: 'stale caller',
              expectedRevision: stale.revision,
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'state-conflict'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterInvalid);
        const original = yield* FileSystem.FileSystem;
        const failRename = FileSystem.FileSystem.of({
          ...original,
          rename: (from, to) =>
            to.endsWith('native-run.json')
              ? Effect.fail(new Error('Synthetic state receipt interruption') as never)
              : original.rename(from, to),
        });
        const interrupted = yield* f
          .mutate('validate-review', {snapshotId: f.snapshot.snapshotId, attemptId: 'recovered-1', report: f.report})
          .pipe(Effect.provideService(FileSystem.FileSystem, failRename), Effect.result);
        expect(Result.isFailure(interrupted)).toBe(true);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterInvalid);
        yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'recovered-1',
          report: f.report,
        });
        const state = JSON.parse(yield* f.fs.readFileString(f.statePath()));
        expect(decodeNativeCycleRuntime(state.cycle).attempts.map(item => item.status)).toEqual([
          'invalid',
          'accepted',
        ]);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const changed = true;\n');
        expect(
          yield* f.call({...f.base('cycle'), command: 'check', snapshotId: f.snapshot.snapshotId}).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'source-drift'}});
      }).pipe(run),
  );
});
