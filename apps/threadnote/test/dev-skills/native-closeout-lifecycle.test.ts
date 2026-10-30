import {it as effectIt} from '@effect/vitest';

import {
  Deferred,
  Effect,
  Array as EffectArray,
  String as EffectString,
  Fiber,
  FileSystem,
  PlatformError,
  Result,
} from 'effect';

import {describe, expect, it} from 'vitest';

import fc from 'fast-check';

import {runCommandEffect} from '@threadnote/platform/command';

import {decodeNativeCyclePlan} from '@threadnote/workflow-automations/cycle';

import {
  CurrentNativeOperationLimit,
  readNativeWorkflowState,
  withNativeWorkflowLock,
  writeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';

import {readNativeCloseoutJournal} from '../../src/workflow_automation/closeout_store.js';

import {freshCloseoutChangedPathCoverage} from '../../src/workflow_automation/closeout.js';

import {decodeJournal} from '../../src/workflow_automation/closeout_request_schema.js';

import {
  CurrentNativeJobAutoLaunch,
  CurrentNativeJobBeforeDispatch,
  runNativeJobWorker,
} from '../../src/workflow_automation/native_jobs.js';

import {nativeCloseoutFixture} from './native-closeout-fixture.js';

import {runCloseout} from './native-closeout-diagnostics.js';

import {assertOwnedState, commandResult, object, proposalFor} from './native-closeout-lifecycle-fixture.js';

describe('native closeout lifecycle', () => {
  it('covers every changed path with fresh phases despite overlapping merged owners', () => {
    const phase = {
      id: 'merged',
      definitionHash: EffectString.repeat(64)('1'),
      title: 'Owner',
      dependsOn: [],
      allowedPaths: ['source.ts'],
      acceptanceCriteria: ['Source is reviewed.'],
      safeToMergeReason: 'Private fixture.',
      branch: 'fixture/reader',
      baseBranch: 'main',
      status: 'pending' as const,
      acceptanceRefs: [],
    };
    const phases = [phase, {...phase, id: 'repair'}, {...phase, id: 'other', allowedPaths: ['other.ts']}];
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('source.ts', 'other.ts', 'unowned.ts'), {minLength: 1, maxLength: 3}),
        fc.boolean(),
        fc.boolean(),
        (paths, repairFresh, otherFresh) => {
          const qualified = new Set([...(repairFresh ? ['repair'] : []), ...(otherFresh ? ['other'] : [])]);
          const coverage = freshCloseoutChangedPathCoverage(paths, phases, qualified);
          const complete = EffectArray.every(paths, path =>
            path === 'source.ts' ? repairFresh : path === 'other.ts' ? otherFresh : false,
          );
          expect(coverage !== undefined).toBe(complete);
          if (coverage) {
            expect(coverage).not.toContain('merged');
            expect(new Set(coverage)).toEqual(
              new Set(EffectArray.map(paths, path => (path === 'source.ts' ? 'repair' : 'other'))),
            );
          }
        },
      ),
      {numRuns: 64},
    );
  });

  effectIt.effect(
    'accepts a public repair phase covering changed source while preserving a merged owner',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false, 'desktop', 'controller', 'pr');
        const cycle = (command: string, fields: Record<string, unknown> = {}) =>
          f
            .call({...f.base('cycle', f.controllerRunId), command, ...fields})
            .pipe(Effect.map(value => object(object(value).cycle)));
        const mutateCycle = (command: string, fields: Record<string, unknown> = {}) =>
          Effect.gen(function* () {
            const inspected = object(yield* cycle('inspect'));
            return object(yield* cycle(command, {expectedRevision: inspected.revision, ...fields}));
          });
        yield* runCommandEffect('git', ['-C', f.repo, 'checkout', '-b', 'fixture/reader']);
        const original = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        if (!original?.state.cycle) throw new Error('Expected original published phase.');
        const owner = original.state.cycle.state.phases.one;
        if (!owner.head || !owner.tree) throw new Error('Expected initial source proof.');
        yield* mutateCycle('record-delivery', {
          phaseId: 'one',
          publication: {exemption: 'maintenance', reason: 'Private merged predecessor fixture.'},
          delivery: {
            phaseId: 'one',
            phaseHash: owner.phaseHash,
            delivery: 'pr',
            headSha: owner.head,
            validatedTree: owner.tree,
            commitEvidence: 'Private merged predecessor commit.',
            pr: {
              url: 'https://github.com/example/private-fixture/pull/1',
              headSha: owner.head,
              branch: 'fixture/reader',
              baseBranch: 'main',
              state: 'merged',
            },
          },
        });
        expect(
          (yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.cycle?.state.phases.one.status,
        ).toBe('merged');
        const proposal = proposalFor(yield* f.closeout('validation-input'));
        yield* f.closeout('prepare', {proposal});
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const result = {repaired: true};\n');
        yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
        yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', 'Repair merged source']);
        yield* f.call(f.base('graph-ready', 'plan-run'));
        const changedHead = EffectString.trim(
          (yield* runCommandEffect('git', ['-C', f.repo, 'rev-parse', 'HEAD'])).stdout,
        );
        const changedTree = EffectString.trim(
          (yield* runCommandEffect('git', ['-C', f.repo, 'rev-parse', 'HEAD^{tree}'])).stdout,
        );
        expect(object(yield* f.closeout('recover')).closeout).toMatchObject({state: 'superseded'});
        if (f.plan.kind !== 'plan') throw new Error('Expected original ready plan.');
        const originalPhase = f.plan.phases[0];
        const revised = {
          ...f.plan,
          phases: [
            originalPhase,
            {
              ...originalPhase,
              id: 'repair',
              title: 'Repair merged source',
              outcome: 'Return the repaired source result.',
              dependsOn: ['one'],
              acceptance: EffectArray.map(originalPhase.acceptance, item => ({...item, id: 'repair-' + item.id})),
            },
          ],
        };
        const oldRoot = original.state.cycle.state.plan.source.root;
        const savedPlan = object(
          object(
            yield* f.call({
              ...f.base('authoring', 'plan-run'),
              command: 'save',
              document: revised,
              ready: true,
              uri: oldRoot.uri,
              expectedRevision: oldRoot.revision,
            }),
          ).authoring,
        );
        const exported = decodeNativeCyclePlan(
          object(
            yield* f.call({
              ...f.base('authoring', 'plan-run'),
              command: 'export-dev-cycle',
              uri: object(savedPlan.root).uri,
              delivery: 'pr',
              bindings: {
                one: {branch: 'fixture/reader', baseBranch: 'main'},
                repair: {branch: 'fixture/reader', baseBranch: 'main'},
              },
            }),
          ).authoring,
        );
        const reconciled = yield* mutateCycle('reconcile', {
          plan: exported,
          reason: 'Approved repair phase covers source changed after the merged owner.',
        });
        expect(reconciled.affected).toContain('repair');
        expect(
          (yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.cycle?.state.phases.one.status,
        ).toBe('merged');
        yield* mutateCycle('resume-phase', {phaseId: 'repair', reason: 'Review repaired source.'});
        yield* mutateCycle('begin-phase', {phaseId: 'repair'});
        const captured = object(yield* mutateCycle('snapshot', {phaseId: 'repair', snapshotId: 'repair-review'}));
        const snapshot = object(object(captured.snapshot).snapshot);
        expect(snapshot).toMatchObject({head: changedHead, tree: changedTree});
        yield* mutateCycle('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'repair-accepted',
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
        const repairPhase = exported.phases[1];
        yield* mutateCycle('ready', {
          phaseId: 'repair',
          snapshotId: snapshot.snapshotId,
          validation: {
            snapshotTree: changedTree,
            reviewTree: changedTree,
            head: changedHead,
            status: 'passed',
            productState: 'working',
            checks: [{command: 'Private repair check', result: 'passed', evidence: 'Read repaired source.'}],
            acceptance: EffectArray.map(repairPhase.acceptanceCriteria, criterion => ({
              criterion,
              result: 'passed',
              evidence: 'Observed ' + criterion,
            })),
          },
        });
        yield* mutateCycle('record-delivery', {
          phaseId: 'repair',
          publication: {exemption: 'maintenance', reason: 'Private repaired source fixture.'},
          delivery: {
            phaseId: 'repair',
            phaseHash: snapshot.phaseHash,
            delivery: 'pr',
            headSha: changedHead,
            validatedTree: changedTree,
            commitEvidence: 'Private repair commit.',
            pr: {
              url: 'https://github.com/example/private-fixture/pull/2',
              headSha: changedHead,
              branch: 'fixture/reader',
              baseBranch: 'main',
              state: 'merged',
            },
          },
        });
        const current = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        expect(current?.state.cycle?.state.phases.one.status).toBe('merged');
        expect(current?.state.cycle?.state.phases.repair.status).toBe('merged');
        const repairedProposal = proposalFor(yield* f.closeout('validation-input'));
        const prepared = object(yield* f.closeout('prepare', {proposal: repairedProposal}));
        expect(prepared.closeout).toMatchObject({state: 'prepared', retainedAdmissions: 1});
        expect(object(yield* f.closeout('finish')).closeout).toMatchObject({state: 'complete'});
      }).pipe(runCloseout),
    {timeout: 120_000},
  );

  effectIt.effect(
    'blocks a paused old-source prepare before any journal or reservation effect',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false);
        const loaded = yield* f.load();
        const proposal = proposalFor(yield* f.closeout('validation-input'));
        const work = {...f.base('closeout', f.controllerRunId), command: 'prepare', proposal};
        const accepted = object(
          yield* f
            .call({...f.base('job', f.controllerRunId), command: 'submit', work})
            .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false)),
        );
        const before = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        if (!before?.state.cycle) throw new Error('Expected complete original cycle.');
        expect(before.state.closeoutSave).toBeUndefined();
        expect(yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal)).toBeUndefined();
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const paused = yield* runNativeJobWorker(f.config, f.controllerRunId, String(accepted.jobId), f.call).pipe(
          Effect.provideService(
            CurrentNativeJobBeforeDispatch,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
          ),
          Effect.forkChild({startImmediately: true}),
        );
        yield* Deferred.await(entered);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const result = {stale: true};\n');
        yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
        yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', 'Change source after prepare precheck']);
        yield* f.call(f.base('graph-ready', 'plan-run'));
        const changedHead = EffectString.trim(
          (yield* runCommandEffect('git', ['-C', f.repo, 'rev-parse', 'HEAD'])).stdout,
        );
        expect(object(object(yield* f.closeout('validation-input')).source).head).toBe(changedHead);
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.cycle).toEqual(before.state.cycle);
        yield* Deferred.succeed(released, undefined);
        const blocked = object(yield* Fiber.join(paused));
        expect(blocked.status).toBe('blocked-with-progress');
        expect(yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal)).toBeUndefined();
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave).toBeUndefined();
        yield* assertOwnedState(f, loaded.owned, 'active');
      }).pipe(runCloseout),
    {timeout: 120_000},
  );

  effectIt.effect(
    'fences a pristine stale admission, requires new acceptance, and retains both histories',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false, 'desktop', 'controller', 'pr');
        const loaded = yield* f.load();
        const proposal = proposalFor(yield* f.closeout('validation-input'));
        const prepareWork = {...f.base('closeout', f.controllerRunId), command: 'prepare', proposal};
        const submit = () =>
          f
            .call({...f.base('job', f.controllerRunId), command: 'submit', work: prepareWork})
            .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
        const oldJob = object(yield* submit());
        yield* f.closeout('prepare', {proposal});
        const finishWork = {...f.base('closeout', f.controllerRunId), command: 'finish'};
        const submitFinish = () =>
          f
            .call({...f.base('job', f.controllerRunId), command: 'submit', work: finishWork})
            .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
        const oldFinish = object(yield* submitFinish());
        expect(object(yield* submitFinish()).jobId).toBe(oldFinish.jobId);
        const dispatchEntered = yield* Deferred.make<void>();
        const dispatchReleased = yield* Deferred.make<void>();
        const pausedFinish = yield* runNativeJobWorker(
          f.config,
          f.controllerRunId,
          String(oldFinish.jobId),
          f.call,
        ).pipe(
          Effect.provideService(
            CurrentNativeJobBeforeDispatch,
            Deferred.succeed(dispatchEntered, undefined).pipe(Effect.andThen(Deferred.await(dispatchReleased))),
          ),
          Effect.forkChild({startImmediately: true}),
        );
        yield* Deferred.await(dispatchEntered);
        const old = yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal);
        const controller = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        if (!old || !controller?.state.closeoutSave || !controller.state.cycle)
          throw new Error('Expected prepared admission.');
        const reservation = controller.state.closeoutSave;
        yield* runCommandEffect('git', ['-C', f.repo, 'checkout', '-b', 'fixture/reader']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const result = {complete: true};\n');
        yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
        yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', 'Repair fixture source']);
        const newHead = EffectString.trim((yield* runCommandEffect('git', ['-C', f.repo, 'rev-parse', 'HEAD'])).stdout);
        const newTree = EffectString.trim(
          (yield* runCommandEffect('git', ['-C', f.repo, 'rev-parse', 'HEAD^{tree}'])).stdout,
        );
        yield* f.call(f.base('graph-ready', 'plan-run'));
        const inspected = object(yield* f.closeout('inspect'));
        expect(inspected.drift).toMatchObject({source: true, cycle: false});
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave).toEqual(reservation);
        const publicationFile = f.path.join(
          f.home,
          'workflow-memory',
          controller.state.bindingId + '.publication.json',
        );
        yield* f.fs.writeFileString(publicationFile, '{}');
        expect(Result.isFailure(yield* commandResult(f.closeout('recover')))).toBe(true);
        expect((yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal))?.revision).toBe(
          old.revision,
        );
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave).toEqual(reservation);
        yield* f.fs.remove(publicationFile);
        let interrupted = false;
        let fenced = false;
        const renamed: string[] = [];
        const controllerStateFile = yield* f.fs.realPath(f.statePath(f.controllerRunId));
        const closeoutFile = controllerStateFile + '.closeout.json';
        const intercepted = {
          ...f.fs,
          rename: (from: string, to: string) =>
            Effect.gen(function* () {
              if (renamed.length < 8) renamed.push(to);
              if (to === closeoutFile) fenced = true;
              if (to === controllerStateFile && fenced && !interrupted) {
                interrupted = true;
                return yield* PlatformError.systemError({
                  _tag: 'Unknown',
                  module: 'FileSystem',
                  method: 'rename',
                  pathOrDescriptor: to,
                  description: 'Synthetic interruption after the durable old-admission fence.',
                });
              }
              return yield* f.fs.rename(from, to);
            }),
        };
        const interruptedResult = yield* commandResult(
          f.closeout('recover').pipe(Effect.provideService(FileSystem.FileSystem, intercepted)),
        );
        if (!Result.isFailure(interruptedResult))
          throw new Error(
            `Expected recovery release interruption; expected state=${controllerStateFile}; expected closeout=${closeoutFile}; observed=${EffectArray.join(renamed, ',')}.`,
          );
        expect(interrupted).toBe(true);
        expect((yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal))?.state.status).toBe(
          'superseded',
        );
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave).toEqual(reservation);
        const recovered = object(yield* f.closeout('recover'));
        expect(recovered.closeout).toMatchObject({state: 'superseded', revision: expect.any(String)});
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave).toBeUndefined();
        const replay = object(yield* f.closeout('recover'));
        expect(replay.closeout).toEqual(recovered.closeout);
        expect(Result.isFailure(yield* commandResult(f.closeout('finish')))).toBe(true);
        const stale = yield* commandResult(f.closeout('prepare', {proposal}));
        expect(Result.isFailure(stale)).toBe(true);
        if (Result.isFailure(stale)) expect(object(stale.failure).code).toBe('closeout-acceptance-stale');
        const before = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        if (!before?.state.cycle) throw new Error('Expected controller cycle.');
        const cycle = (command: string, fields: Record<string, unknown> = {}) =>
          f
            .call({...f.base('cycle', f.controllerRunId), command, ...fields})
            .pipe(Effect.map(value => object(object(value).cycle)));
        const mutateCycle = (command: string, fields: Record<string, unknown> = {}) =>
          Effect.gen(function* () {
            const inspected = object(yield* cycle('inspect'));
            return object(yield* cycle(command, {expectedRevision: inspected.revision, ...fields}));
          });
        yield* mutateCycle('invalidate', {phaseId: 'one', reason: 'The source changed after closeout admission.'});
        yield* mutateCycle('resume-phase', {phaseId: 'one', reason: 'Review the repaired source.'});
        yield* mutateCycle('begin-phase', {phaseId: 'one'});
        const captured = object(yield* mutateCycle('snapshot', {phaseId: 'one', snapshotId: 'requalified-one'}));
        const snapshot = object(object(captured.snapshot).snapshot);
        expect(snapshot).toMatchObject({head: newHead, tree: newTree});
        yield* mutateCycle('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'accepted-requalification',
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
        yield* mutateCycle('ready', {
          phaseId: 'one',
          snapshotId: snapshot.snapshotId,
          validation: {
            snapshotTree: newTree,
            reviewTree: newTree,
            head: newHead,
            status: 'passed',
            productState: 'working',
            checks: [{command: 'Private fixture check', result: 'passed', evidence: 'Read repaired source.'}],
            acceptance: EffectArray.map(before.state.cycle.state.plan.phases[0].acceptanceCriteria, criterion => ({
              criterion,
              result: 'passed',
              evidence: 'Observed ' + criterion,
            })),
          },
        });
        yield* mutateCycle('record-delivery', {
          phaseId: 'one',
          publication: {exemption: 'maintenance', reason: 'Private merged receipt fixture.'},
          delivery: {
            phaseId: 'one',
            phaseHash: snapshot.phaseHash,
            delivery: 'pr',
            headSha: newHead,
            validatedTree: newTree,
            commitEvidence: 'Private merged fixture commit.',
            pr: {
              url: 'https://github.com/example/private-fixture/pull/2',
              headSha: newHead,
              branch: 'fixture/reader',
              baseBranch: 'main',
              state: 'merged',
            },
          },
        });
        const qualified = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        expect(qualified?.state.cycle?.state.phases.one.status).toBe('merged');
        let lostAdmission = false;
        let admissionWrites = 0;
        let observedAdmissionPath = '';
        const admissionFilesystem = {
          ...f.fs,
          rename: (from: string, to: string) =>
            Effect.gen(function* () {
              if (EffectString.endsWith('.closeout.json')(to)) observedAdmissionPath = to;
              if (to === closeoutFile && ++admissionWrites >= 2) {
                lostAdmission = true;
                return yield* PlatformError.systemError({
                  _tag: 'Unknown',
                  module: 'FileSystem',
                  method: 'rename',
                  pathOrDescriptor: to,
                  description: 'Synthetic interruption after the new exact reservation.',
                });
              }
              return yield* f.fs.rename(from, to);
            }),
        };
        expect(
          Result.isFailure(
            yield* commandResult(
              f.closeout('prepare', {proposal}).pipe(Effect.provideService(FileSystem.FileSystem, admissionFilesystem)),
            ),
          ),
          `Expected readmission interruption; expected closeout=${closeoutFile}; observed=${observedAdmissionPath}; matched writes=${admissionWrites}.`,
        ).toBe(true);
        expect(lostAdmission).toBe(true);
        expect((yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal))?.state.status).toBe(
          'admitting',
        );
        const stranded = (yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave;
        expect(stranded?.transactionId).not.toBe(old.state.transactionId);
        expect(
          Result.isFailure(
            yield* commandResult(
              f.closeout('prepare', {proposal}).pipe(Effect.provideService(FileSystem.FileSystem, admissionFilesystem)),
            ),
          ),
          `Expected readmission interruption; expected closeout=${closeoutFile}; observed=${observedAdmissionPath}; matched writes=${admissionWrites}.`,
        ).toBe(true);
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave).toEqual(stranded);
        const changedProposal = {
          ...proposal,
          architecture: {
            ...proposal.architecture,
            summary: proposal.architecture.summary + ' Recovery uses a distinct proposal.',
          },
        };
        const conflictingIntent = yield* commandResult(f.closeout('prepare', {proposal: changedProposal}));
        expect(Result.isFailure(conflictingIntent)).toBe(true);
        if (Result.isFailure(conflictingIntent))
          expect(object(conflictingIntent.failure).code).toBe('closeout-intent-conflict');
        const recoveredAdmission = object(yield* f.closeout('recover'));
        expect(recoveredAdmission.closeout).toMatchObject({state: 'superseded', retainedAdmissions: 1});
        const fencedAdmission = yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal);
        expect(fencedAdmission?.state.recovery?.reservation).toEqual(stranded);
        expect(fencedAdmission?.state.history?.[0].transactionId).toBe(old.state.transactionId);
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.closeoutSave).toBeUndefined();
        expect(fencedAdmission?.state.recovery?.carriedQualification).toMatchObject({
          source: {head: newHead, tree: newTree},
          acceptedAttemptIds: [],
          snapshotIds: [],
        });
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const result = {complete: false};\n');
        yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
        yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', 'Drift private source']);
        const staleSource = yield* commandResult(f.closeout('prepare', {proposal: changedProposal}));
        expect(Result.isFailure(staleSource)).toBe(true);
        if (Result.isFailure(staleSource)) expect(object(staleSource.failure).code).toBe('closeout-acceptance-stale');
        yield* runCommandEffect('git', ['-C', f.repo, 'reset', '--hard', newHead]);
        yield* mutateCycle('extend-reviews', {
          phaseId: 'one',
          reviewLimit: 6,
          userAuthority: 'Private fixture cycle drift.',
        });
        const staleCycle = yield* commandResult(f.closeout('prepare', {proposal: changedProposal}));
        expect(Result.isFailure(staleCycle)).toBe(true);
        if (Result.isFailure(staleCycle)) expect(object(staleCycle.failure).code).toBe('closeout-acceptance-stale');
        const drifted = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        if (!drifted || !qualified?.state.cycle) throw new Error('Expected drifted public cycle runtime.');
        yield* withNativeWorkflowLock(
          f.config,
          f.controllerRunId,
          false,
          writeNativeWorkflowState(f.config, {...drifted.state, cycle: qualified.state.cycle}, drifted.revision),
        );
        expect((yield* readNativeWorkflowState(f.config, f.controllerRunId))?.state.cycle).toEqual(
          qualified?.state.cycle,
        );
        const nextJob = object(yield* submit());
        expect(nextJob.jobId).not.toBe(oldJob.jobId);
        const staleJob = object(yield* runNativeJobWorker(f.config, f.controllerRunId, String(oldJob.jobId), f.call));
        expect(staleJob.status).toBe('blocked-with-progress');
        const admitted = object(yield* f.closeout('prepare', {proposal: changedProposal}));
        expect(admitted.closeout).toMatchObject({state: 'prepared', retainedAdmissions: 2});
        yield* Deferred.succeed(dispatchReleased, undefined);
        const racedFinish = object(yield* Fiber.join(pausedFinish));
        expect(racedFinish.status).toBe('blocked-with-progress');
        expect((yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal))?.state.status).toBe(
          'prepared',
        );
        const nextFinish = object(yield* submitFinish());
        expect(nextFinish.jobId).not.toBe(oldFinish.jobId);
        yield* f.call({...f.base('job', f.controllerRunId), command: 'cancel', jobId: oldFinish.jobId});
        yield* f
          .call({...f.base('job', f.controllerRunId), command: 'resume', jobId: oldFinish.jobId})
          .pipe(Effect.provideService(CurrentNativeJobAutoLaunch, false));
        const staleFinish = object(
          yield* runNativeJobWorker(f.config, f.controllerRunId, String(oldFinish.jobId), f.call),
        );
        expect(staleFinish.status).toBe('blocked-with-progress');
        const next = yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal);
        expect(next?.state.history?.[0].transactionId).toBe(old.state.transactionId);
        expect(next?.state.history?.[0].recovery.reservation).toEqual(reservation);
        expect(next?.state.history?.[1].transactionId).toBe(fencedAdmission?.state.transactionId);
        expect(next?.state.history?.[1].recovery.reservation).toEqual(stranded);
        expect(next?.state.transactionId).not.toBe(old.state.transactionId);
        const finished = object(yield* f.closeout('finish'));
        expect(finished.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
        const completed = yield* readNativeCloseoutJournal(f.config, f.controllerRunId, decodeJournal);
        expect(completed?.state.history?.[0].transactionId).toBe(old.state.transactionId);
        expect(completed?.state.status).toBe('complete');
      }).pipe(runCloseout),
    {timeout: process.platform === 'win32' ? 180_000 : 120_000},
  );

  effectIt.effect('rejects an entire closeout before writes when only one operation slot remains', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const loaded = yield* f.load();
      const state = yield* readNativeWorkflowState(f.config, f.controllerRunId);
      if (!state) throw new Error('Expected native controller.');
      const before = yield* f.fs.readFileString(f.statePath(f.controllerRunId));
      const proposal = proposalFor(yield* f.closeout('validation-input'));
      const result = yield* f
        .closeout('prepare', {proposal})
        .pipe(Effect.provideService(CurrentNativeOperationLimit, state.state.operations.length + 1), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* f.fs.readFileString(f.statePath(f.controllerRunId))).toBe(before);
      expect(yield* f.fs.exists(f.statePath(f.controllerRunId) + '.closeout.json')).toBe(false);
      yield* assertOwnedState(f, loaded.owned, 'active');
    }).pipe(runCloseout),
  );
});
