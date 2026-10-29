import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  String as EffectString,
  Option as EffectOption,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  PlatformError,
  Result,
} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {isJsonObject} from '@threadnote/platform/json';
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
import {decodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';
import {decodeWorkflowJournalStorageImage} from '../../src/workflow_memory/journal_storage.js';
import {decodeBoundedWorkflowJson} from '../../src/workflow_memory/journal_codec.js';
import {nativeCloseoutFixture} from './native-closeout-fixture.js';
import {runCloseout} from './native-closeout-diagnostics.js';
import * as EffectRecord from 'effect/Record';
import * as Effect2 from 'effect';

type Fixture = ReturnType<typeof nativeCloseoutFixture> extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

const object = (value: unknown): Record<string, unknown> => {
  if (!isJsonObject(value)) throw new Error('Expected an object response.');
  return value;
};
const objectArray = (value: unknown): Record<string, unknown>[] => {
  if (!EffectArray.isArray(value)) throw new Error('Expected an object array.');
  return EffectArray.map(value, object);
};
const stringArray = (value: unknown): string[] => {
  if (!EffectArray.isArray(value)) throw new Error('Expected a string array.');
  return EffectArray.map(value, item => {
    if (typeof item !== 'string') throw new Error('Expected a string.');
    return item;
  });
};
const artifactReferences = (value: unknown) =>
  EffectRecord.map(object(value), reference => ({
    memoryId: stringField(object(reference), 'memoryId'),
    revision: stringField(object(reference), 'revision'),
    uri: stringField(object(reference), 'uri'),
  }));
const stringField = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`Expected string field ${key}.`);
  return field;
};
const validationShape = (value: unknown) => {
  const result = object(value);
  return {
    phases: EffectArray.map(objectArray(result.phases), phase => ({
      id: stringField(phase, 'id'),
      acceptanceCriteria: stringArray(phase.acceptanceCriteria),
    })),
    scenarios: EffectArray.map(objectArray(result.scenarios), scenario => ({id: stringField(scenario, 'id')})),
    decisions: EffectArray.map(objectArray(result.decisions), decision => ({
      id: stringField(decision, 'id'),
      selected: stringField(decision, 'selected'),
    })),
  };
};
const proposalFor = (value: unknown, includeCodeRefs = true) => {
  const input = validationShape(value);
  return {
    architecture: {
      summary: 'The implemented reader returns the complete saved result.',
      components: ['Reader', 'Store'],
      contracts: ['Preserve complete results.'],
      diagram: 'flowchart TD\n Reader --> Store',
      invariants: ['The reader returns every saved field.'],
      unknowns: ['The fixture does not measure production-scale load.'],
      deviations: [],
      codeRefs: includeCodeRefs ? ['source.ts'] : [],
    },
    architectureVerification: 'Inspected the committed source and exercised the complete read behavior.',
    combinedChecks: [
      {command: 'private combined fixture check', result: 'passed' as const, evidence: 'All fixture checks passed.'},
    ],
    phaseEvidence: EffectArray.map(input.phases, phase => ({
      id: phase.id,
      acceptance: EffectArray.map(phase.acceptanceCriteria, criterion => ({
        criterion,
        evidence: 'Observed ' + criterion,
      })),
    })),
    scenarios: EffectArray.map(input.scenarios, scenario => ({
      id: scenario.id,
      evidence: 'Observed complete scenario ' + scenario.id,
    })),
    ...(input.scenarios.length > 0 ? {behaviorVerification: 'Verified each approved behavior scenario.'} : {}),
    decisions: EffectArray.map(input.decisions, item => ({
      id: item.id,
      implemented: item.selected,
      rationale: 'Applied the approved choice and preserved its complete rationale: ' + item.id,
    })),
  };
};
const commandResult = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);
const assertOwnedState = (
  f: Fixture,
  items: readonly {runId: string; uri: string; revision: string}[],
  state: 'active' | 'archived',
) =>
  Effect.gen(function* () {
    for (const item of items) {
      const result = object(yield* f.call({...f.base('read', item.runId), uri: item.uri}));
      const artifact = object(result.artifact);
      expect(artifact.state).toBe(state);
      expect(artifact.uri).toBe(item.uri);
    }
  });
const readArtifact = (f: Fixture, uri: string, runId = f.controllerRunId) =>
  Effect.gen(function* () {
    const response = object(yield* f.call({...f.base('read', runId), uri}));
    return object(response.artifact);
  });
const relationTargets = (f: Fixture, uri: string, revision?: string) =>
  Effect.gen(function* () {
    const controller = yield* readNativeWorkflowState(f.config, f.controllerRunId);
    if (!controller) throw new Error('Expected controller run.');
    const bytes = yield* f.fs.readFileString(f.journalPath(controller.state.bindingId));
    const logical = yield* Effect.promise(() => decodeWorkflowJournal(bytes));
    const journal = object(decodeWorkflowJournalStorageImage(JSON.parse(logical)));
    const operations = EffectArray.map(EffectRecord.values(object(journal.operations)), object);
    const operation = EffectOption.getOrUndefined(
      EffectArray.findFirst(operations, item => {
        const artifact = object(item.artifact);
        return artifact.canonicalUri === uri && (revision === undefined || artifact.revision === revision);
      }),
    );
    if (!operation) throw new Error('Expected a verified operation for the readback artifact.');
    return EffectArray.map(objectArray(operation.relations), relation => stringField(relation, 'uri'));
  });
const prepare = (f: Fixture) =>
  Effect.gen(function* () {
    const schema = object(yield* f.closeout('schema'));
    expect(schema.status).toBe('ok');
    expect(schema.schema).toBeDefined();
    const validation = yield* f.closeout('validation-input');
    const proposal = proposalFor(validation);
    const result = yield* f.closeout('prepare', {proposal});
    return {proposal, result, validation};
  });
const journalImage = (f: Fixture) =>
  Effect.gen(function* () {
    const state = yield* readNativeWorkflowState(f.config, f.controllerRunId);
    if (!state) throw new Error('Expected controller run.');
    const file = f.statePath(f.controllerRunId) + '.closeout.json';
    const image = object(JSON.parse(yield* f.fs.readFileString(file)));
    return {
      archives: artifactReferences(image.archives),
      outputs: artifactReferences(image.outputs),
      status: stringField(image, 'status'),
    };
  });
// P0 Windows allowance for seven full native closeout fixtures beyond 30s; revisit with performance data.
const windowsCloseoutTimeout = process.platform === 'win32' ? {timeout: 120_000} : undefined;
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
            selected: ['orchestrator', 'simplicity'],
            lanes: [
              {name: 'orchestrator', status: 'complete'},
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
            selected: ['orchestrator', 'simplicity'],
            lanes: [
              {name: 'orchestrator', status: 'complete'},
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
  effectIt.effect(
    'completes desktop architecture-only closeout and preserves linked decisions and unrelated artifacts',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false);
        const loaded = yield* f.load();
        const controller = yield* readNativeWorkflowState(f.config, f.controllerRunId);
        if (!controller) throw new Error('Expected native controller.');
        const controllerJournal = f.journalPath(controller.state.bindingId);
        const beforeBytes = yield* f.fs.readFileString(controllerJournal);
        const beforeLogical = yield* Effect.promise(() => decodeWorkflowJournal(beforeBytes));
        const before = JSON.parse(beforeLogical);
        expect(before.journalStorage).not.toBe('threadnote-workflow-journal-shared-values-v1');
        const {proposal} = yield* prepare(f);
        const finished = object(yield* f.closeout('finish'));
        expect(finished.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
        expect(finished.closeout).toMatchObject({
          outputs: expect.arrayContaining([expect.objectContaining({key: 'architecture'})]),
        });
        const image = yield* journalImage(f);
        expect(image.status).toBe('complete');
        const storedJournal = yield* f.fs.readFileString(controllerJournal);
        const logicalJournal = yield* Effect.promise(() => decodeWorkflowJournal(storedJournal));
        expect(JSON.parse(logicalJournal).journalStorage).toBe('threadnote-workflow-journal-shared-values-v1');
        expect(EffectRecord.keys(image.archives)).toHaveLength(loaded.owned.length);
        for (const item of loaded.owned) {
          const archived = image.archives[item.uri];
          expect(archived).toBeDefined();
          const result = yield* readArtifact(f, archived.uri, item.runId);
          expect(result).toMatchObject({uri: archived.uri, state: 'archived', memoryId: item.memoryId});
        }
        const unrelated = yield* readArtifact(f, f.unrelated.uri, 'plan-run');
        expect(unrelated).toMatchObject({uri: f.unrelated.uri, state: 'active'});

        const architectureRef = image.outputs.architecture;
        const architecture = yield* readArtifact(f, architectureRef.uri);
        const decisionIndexRef = image.outputs['decisions-0'];
        expect(decisionIndexRef).toBeDefined();
        expect(architecture.body).toContain('[');
        expect(architecture.body).toContain(decisionIndexRef.uri);
        expect(yield* relationTargets(f, architectureRef.uri)).toContain(decisionIndexRef.uri);
        const decisionIndex = yield* readArtifact(f, decisionIndexRef.uri);
        const decisionUris = yield* relationTargets(f, decisionIndexRef.uri);
        expect(decisionUris).toHaveLength(f.plan.decisions.length);
        for (const uri of decisionUris) expect(decisionIndex.body).toContain(uri);
        for (let index = 0; index < f.plan.decisions.length; index++) {
          const decision = yield* readArtifact(f, decisionUris[index]);
          expect(decision.body).toContain(f.plan.decisions[index].rationale);
          expect(decision.body).toContain(f.plan.decisions[index].selected);
          expect(decision.body).toContain(f.plan.decisions[index].alternatives[0].design);
          expect(decision.body).toContain(proposal.decisions[index].implemented);
          expect(decision.body).toContain(proposal.decisions[index].rationale);
        }

        const receiptFile = f.statePath('controller') + '.closeout.json';
        const bytes = yield* f.fs.readFileString(receiptFile);
        const inspected = object(yield* f.closeout('inspect'));
        expect(inspected.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
        const replay = object(yield* f.closeout('finish'));
        expect(replay.closeout).toMatchObject({
          state: 'complete',
          revision: object(finished.closeout).revision,
          archived: loaded.owned.length,
        });
        expect(yield* f.fs.readFileString(receiptFile)).toBe(bytes);
      }).pipe(runCloseout),
    windowsCloseoutTimeout,
  );

  // prettier-ignore
  effectIt.effect('completes a spec-backed desktop closeout with independent verified behavior readback', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(true);
      const loaded = yield* f.load();
      expect(loaded.spec?.kind).toBe('spec');
      const {validation} = yield* prepare(f);
      expect(EffectArray.map(validationShape(validation).scenarios, item => item.id)).toEqual(['read']);
      const finished = object(yield* f.closeout('finish'));
      expect(finished.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
      const image = yield* journalImage(f);
      const behavior = image.outputs.behavior;
      expect(behavior).toBeDefined();
      const observed = yield* readArtifact(f, behavior.uri);
      expect(observed).toMatchObject({uri: behavior.uri, state: 'active', storageKind: 'durable'});
      expect(observed.body).toContain('Verified behavior');
      expect(yield* relationTargets(f, stringField(observed, 'uri'), stringField(observed, 'revision'))).toContain(
        image.outputs.architecture.uri,
      );
    }).pipe(runCloseout),
    windowsCloseoutTimeout ?? {timeout: 60_000},
  );

  // prettier-ignore
  effectIt.effect('rejects missing acceptance and changed source without retiring any owned draft', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const loaded = yield* f.load();
      const validation = yield* f.closeout('validation-input');
      const proposal = proposalFor(validation);
      const missing = {
        ...proposal,
        phaseEvidence: EffectArray.map(proposal.phaseEvidence, phase => ({...phase, acceptance: []})),
      };
      const rejected = yield* commandResult(f.closeout('prepare', {proposal: missing}));
      expect(Result.isFailure(rejected)).toBe(true);
      yield* assertOwnedState(f, loaded.owned, 'active');

      yield* f.closeout('prepare', {proposal});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const changedAfterVerification = true;\n');
      const finish = yield* commandResult(f.closeout('finish'));
      expect(Result.isFailure(finish)).toBe(true);
      yield* assertOwnedState(f, loaded.owned, 'active');
      expect((yield* readArtifact(f, f.unrelated.uri, 'plan-run')).state).toBe('active');
    }).pipe(runCloseout),
    windowsCloseoutTimeout,
  );

  // prettier-ignore
  effectIt.effect('preserves every remaining draft when an owned artifact is edited after admission', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const loaded = yield* f.load();
      const {proposal} = yield* prepare(f);
      const selected = EffectOption.getOrUndefined(EffectArray.findFirst(loaded.owned, item => item.role === 'authoring-child'));
      if (!selected) throw new Error('Expected an owned authoring child.');
      const before = yield* f.store.read(f.location, selected.uri);
      const fingerprint = yield* f.store.fingerprint(before);
      yield* f.store.write(f.location, selected.uri, before + '\nExternal edit after admission.\n', {
        mode: 'replace',
        expectedFingerprint: fingerprint,
      });
      const finish = yield* commandResult(f.closeout('finish'));
      expect(Result.isFailure(finish)).toBe(true);
      const image = yield* journalImage(f);
      expect(EffectRecord.keys(image.archives)).toHaveLength(0);
      for (const item of loaded.owned) {
        const observed = yield* commandResult(f.call({...f.base('read', item.runId), uri: item.uri}));
        if (!Result.isSuccess(observed)) throw new Error('Expected owned draft readback to remain available.');
        if (item.uri === selected.uri) {
          const success = object(observed.success);
          const artifact = object(success.artifact);
          expect(artifact.body).toContain('External edit after admission.');
          expect(artifact.revision).not.toBe(item.revision);
        }
      }
      expect(proposal.phaseEvidence).toHaveLength(1);
      expect((yield* readArtifact(f, f.unrelated.uri, 'plan-run')).state).toBe('active');
    }).pipe(runCloseout),
    windowsCloseoutTimeout,
  );

  // prettier-ignore
  effectIt.effect('recovers the original archive intent after its first response is lost', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const loaded = yield* f.load();
      yield* prepare(f);
      const target = loaded.owned[0];
      const store = f.store;
      let lost = false;
      const interruptedStore = {
        ...store,
        remove: (
          location: Parameters<typeof store.remove>[0],
          uri: string,
          options?: Parameters<typeof store.remove>[2],
        ) =>
          store.remove(location, uri, options).pipe(
            Effect.andThen(() => {
              if (!lost && uri === target.uri) {
                lost = true;
                return Effect.fail(
                  ResourceIoFailed.make({
                    uri,
                    operation: 'write',
                    message: 'Synthetic lost archive response after commit.',
                    cause: new Error('Synthetic lost archive response after commit.'),
                  }),
                );
              }
              return Effect.void;
            }),
          ),
      };
      const first = yield* commandResult(
        f.closeout('finish').pipe(Effect.provideService(ResourceStore, interruptedStore)),
      );
      expect(Result.isFailure(first)).toBe(true);
      expect(lost).toBe(true);
      const interruptedImage = yield* journalImage(f);
      expect(interruptedImage.status).toBe('archiving');

      const resumed = object(yield* f.closeout('finish'));
      expect(resumed.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
      const complete = yield* journalImage(f);
      expect(EffectRecord.keys(complete.archives)).toHaveLength(loaded.owned.length);
      for (const item of loaded.owned) {
        const archive = complete.archives[item.uri];
        expect(archive).toBeDefined();
        const observed = yield* readArtifact(f, archive.uri, item.runId);
        expect(observed).toMatchObject({uri: archive.uri, state: 'archived', memoryId: item.memoryId});
      }
    }).pipe(runCloseout),
    windowsCloseoutTimeout,
  );

  // prettier-ignore
  effectIt.effect('recovers spec-backed archive interruption when authoring and controller share one native run', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(true, 'desktop', 'plan-run');
      const loaded = yield* f.load();
      expect(loaded.spec?.kind).toBe('spec');
      const planState = yield* readNativeWorkflowState(f.config, 'plan-run');
      expect(planState).toBeDefined();
      expect(f.controllerRunId).toBe('plan-run');

      const {proposal} = yield* prepare(f);
      const target = loaded.owned[0];
      const store = f.store;
      let lost = false;
      const interruptedStore = {
        ...store,
        remove: (
          location: Parameters<typeof store.remove>[0],
          uri: string,
          options?: Parameters<typeof store.remove>[2],
        ) =>
          store.remove(location, uri, options).pipe(
            Effect.andThen(() => {
              if (!lost && uri === target.uri) {
                lost = true;
                return Effect.fail(
                  ResourceIoFailed.make({
                    uri,
                    operation: 'write',
                    message: 'Synthetic lost archive response after commit.',
                    cause: new Error('Synthetic lost archive response after commit.'),
                  }),
                );
              }
              return Effect.void;
            }),
          ),
      };
      const first = yield* commandResult(
        f.closeout('finish').pipe(Effect.provideService(ResourceStore, interruptedStore)),
      );
      expect(Result.isFailure(first)).toBe(true);
      expect(lost).toBe(true);
      const interruptedImage = yield* journalImage(f);
      expect(interruptedImage.status).toBe('archiving');

      const resumed = object(yield* f.closeout('finish'));
      expect(resumed.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
      const complete = yield* journalImage(f);
      expect(complete.status).toBe('complete');
      expect(EffectRecord.keys(complete.archives)).toHaveLength(loaded.owned.length);
      for (const item of loaded.owned) {
        const archive = complete.archives[item.uri];
        expect(archive).toBeDefined();
        const observed = yield* readArtifact(f, archive.uri, item.runId);
        expect(observed).toMatchObject({uri: archive.uri, state: 'archived', memoryId: item.memoryId});
      }

      const behavior = complete.outputs.behavior;
      expect(behavior).toBeDefined();
      const observedBehavior = yield* readArtifact(f, behavior.uri);
      expect(observedBehavior).toMatchObject({uri: behavior.uri, state: 'active', storageKind: 'durable'});
      expect(observedBehavior.body).toContain('Verified behavior');
      expect(yield* relationTargets(f, behavior.uri, stringField(observedBehavior, 'revision'))).toContain(
        complete.outputs.architecture.uri,
      );
      const receiptFile = f.statePath(f.controllerRunId) + '.closeout.json';
      const bytes = yield* f.fs.readFileString(receiptFile);
      const replay = object(yield* f.closeout('finish'));
      expect(replay.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
      expect(yield* f.fs.readFileString(receiptFile)).toBe(bytes);
      expect(proposal.phaseEvidence).toHaveLength(1);
    }).pipe(runCloseout),
    windowsCloseoutTimeout,
  );

  // prettier-ignore
  effectIt.effect('recovers a committed final behavior write whose response is lost before receipt save', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(true);
      const loaded = yield* f.load();
      expect(loaded.spec?.kind).toBe('spec');
      yield* prepare(f);

      let lost = false;
      let observedReceiptRename = 0;
      let observedRename = 0;
      let closeoutPathMatched = false;
      let observedReceiptPath = '';
      let finalWriteVerified = false;
      let behaviorRevisionChanged = false;
      let observedOperationSuffixes = '';
      const receiptFile = yield* f.fs.realPath(f.statePath(f.controllerRunId) + '.closeout.json');
      const filesystem = f.fs;
      const interceptedFilesystem = {
        ...filesystem,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            observedRename++;
            if (EffectString.endsWith('.closeout.json')(to)) observedReceiptPath = to;
            closeoutPathMatched ||= to === receiptFile;
            if (to === receiptFile && !lost) {
              observedReceiptRename++;
              const decodeReceipt = (bytes: Uint8Array) =>
                Effect.promise(async () => {
                  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
                  const value: unknown = JSON.parse(
                    Effect2.pipe(text, EffectString.includes('threadnote-native-closeout-state-gzip-v1'))
                      ? await decodeBoundedWorkflowJson(text, 'threadnote-native-closeout-state-gzip-v1')
                      : text,
                  );
                  return object(value);
                });
              const previous = yield* decodeReceipt(yield* filesystem.readFile(receiptFile));
              const proposed = yield* decodeReceipt(yield* filesystem.readFile(from));
              const workflow = yield* readNativeWorkflowState(f.config, f.controllerRunId);
              finalWriteVerified =
                 EffectOption.getOrUndefined(EffectOption.map(EffectOption.fromNullishOr(workflow?.state.operations), __effectArrayReceiver => EffectArray.some(__effectArrayReceiver, (__effectArrayValue) => !!((operation =>
                    Effect2.pipe(operation.intent.operationId, EffectString.endsWith('-behavior-final')) && operation.status === 'verified')(__effectArrayValue)))))  ?? false;
              observedOperationSuffixes =
                 EffectOption.getOrUndefined(EffectOption.map(EffectOption.fromNullishOr(EffectOption.getOrUndefined(EffectOption.map(EffectOption.fromNullishOr(workflow?.state.operations), __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, operation => `${EffectArray.join(Effect2.pipe(operation.intent.operationId, EffectString.split('-')).slice(-2), '-')}:${operation.status}`)))), __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ','))) ?? '';
              const proposedOutputs = proposed.outputs === undefined ? undefined : object(proposed.outputs);
              const previousOutputs = previous.outputs === undefined ? undefined : object(previous.outputs);
              const proposedBehavior = proposedOutputs?.behavior === undefined ? undefined : object(proposedOutputs.behavior);
              const previousBehavior = previousOutputs?.behavior === undefined ? undefined : object(previousOutputs.behavior);
              const changedBehaviorRevision =
                typeof proposedBehavior?.revision === 'string' && proposedBehavior.revision !== previousBehavior?.revision;
              behaviorRevisionChanged = changedBehaviorRevision;
              if (finalWriteVerified && changedBehaviorRevision) {
                lost = true;
                return yield* PlatformError.systemError({
                  _tag: 'Unknown',
                  module: 'FileSystem',
                  method: 'rename',
                  pathOrDescriptor: to,
                  description: 'Synthetic interrupted receipt commit after verified final behavior write.',
                });
              }
            }
            return yield* filesystem.rename(from, to);
          }),
      };
      const first = yield* commandResult(
        f.closeout('finish').pipe(Effect.provideService(FileSystem.FileSystem, interceptedFilesystem)),
      );
      if (!lost)
        throw new Error(
          `Receipt fault not reached: expected=${receiptFile}, observed=${observedReceiptPath}, renames=${observedRename}, matched=${observedReceiptRename}, path=${closeoutPathMatched}, verified=${finalWriteVerified}, behaviorChanged=${behaviorRevisionChanged}, operations=${observedOperationSuffixes}.`,
        );
      expect(Result.isFailure(first)).toBe(true);
      expect(lost).toBe(true);
      yield* assertOwnedState(f, loaded.owned, 'active');
      const interrupted = yield* journalImage(f);
      expect(interrupted.status).toBe('prepared');

      const retry = yield* commandResult(f.closeout('finish'));
      if (Result.isFailure(retry)) {
        const failure = object(retry.failure);
        throw new Error(`Same-intent retry failed with ${String(failure.code ?? failure._tag ?? 'unknown')}.`);
      }
      const resumed = object(retry.success);
      expect(resumed.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
      const complete = yield* journalImage(f);
      expect(EffectRecord.keys(complete.archives)).toHaveLength(loaded.owned.length);
      for (const item of loaded.owned) {
        const archive = complete.archives[item.uri];
        expect(archive).toBeDefined();
        expect(yield* readArtifact(f, archive.uri, item.runId)).toMatchObject({
          uri: archive.uri,
          state: 'archived',
          memoryId: item.memoryId,
        });
      }
      const behavior = complete.outputs.behavior;
      expect(behavior).toBeDefined();
      const observedBehavior = yield* readArtifact(f, behavior.uri);
      expect(observedBehavior).toMatchObject({uri: behavior.uri, state: 'active', storageKind: 'durable'});
      expect(observedBehavior.body).toContain('Verified behavior');
      expect(yield* relationTargets(f, behavior.uri, stringField(observedBehavior, 'revision'))).toContain(
        complete.outputs.architecture.uri,
      );
      const bytes = yield* f.fs.readFileString(receiptFile);
      const replay = object(yield* f.closeout('finish'));
      expect(replay.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
      expect(yield* f.fs.readFileString(receiptFile)).toBe(bytes);
    }).pipe(runCloseout),
    {timeout: 120_000},
  );

  for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const)
    // prettier-ignore
    effectIt.effect(`${profile} preserves drafts until native publication approval`, () =>
      Effect.gen(function* () {
        const f = yield* nativeCloseoutFixture(false, profile);
        const loaded = yield* f.load();
        const validation = yield* f.closeout('validation-input');
        const proposal = proposalFor(validation);
        yield* f.closeout('prepare', {proposal});
        const beforePreview = yield* f.fs.readFileString(f.statePath('plan-run'));
        const preview = object(yield* f.closeout('publication-preview'));
        expect(object(preview.publication).approvalDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(yield* f.fs.readFileString(f.statePath('plan-run'))).toBe(beforePreview);
        const pendingFinish = yield* commandResult(f.closeout('finish'));
        expect(Result.isFailure(pendingFinish)).toBe(true);
        yield* assertOwnedState(f, loaded.owned, 'active');
        const image = yield* journalImage(f);
        expect(EffectRecord.keys(image.archives)).toHaveLength(0);
        expect((yield* readArtifact(f, f.unrelated.uri, 'plan-run')).state).toBe('active');
      }).pipe(runCloseout),
      windowsCloseoutTimeout,
    );
});
