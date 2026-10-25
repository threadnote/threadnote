import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, PlatformError, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {CurrentNativeOperationLimit, readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {decodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';
import {decodeWorkflowJournalStorageImage} from '../../src/workflow_memory/journal_storage.js';
import {decodeBoundedWorkflowJson} from '../../src/workflow_memory/journal_codec.js';
import {nativeCloseoutFixture} from './native-closeout-fixture.js';
import {provideNative} from './native-automation-fixture.js';

type Fixture = ReturnType<typeof nativeCloseoutFixture> extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object response.');
  return value as Record<string, unknown>;
};
const stringField = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`Expected string field ${key}.`);
  return field;
};
const validationShape = (value: unknown) => {
  const result = object(value);
  return {
    phases: result.phases as readonly {id: string; acceptanceCriteria: readonly string[]}[],
    scenarios: result.scenarios as readonly {id: string}[],
    decisions: result.decisions as readonly {id: string; selected: string}[],
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
    phaseEvidence: input.phases.map(phase => ({
      id: phase.id,
      acceptance: phase.acceptanceCriteria.map(criterion => ({criterion, evidence: 'Observed ' + criterion})),
    })),
    scenarios: input.scenarios.map(scenario => ({
      id: scenario.id,
      evidence: 'Observed complete scenario ' + scenario.id,
    })),
    ...(input.scenarios.length > 0 ? {behaviorVerification: 'Verified each approved behavior scenario.'} : {}),
    decisions: input.decisions.map(item => ({
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
    const journal = decodeWorkflowJournalStorageImage(JSON.parse(logical)) as {
      operations: Record<
        string,
        {artifact: {canonicalUri: string; revision: string}; relations: readonly {uri: string}[]}
      >;
    };
    const operation = Object.values(journal.operations).find(
      item => item.artifact.canonicalUri === uri && (revision === undefined || item.artifact.revision === revision),
    );
    if (!operation) throw new Error('Expected a verified operation for the readback artifact.');
    return operation.relations.map(relation => relation.uri);
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
    return JSON.parse(yield* f.fs.readFileString(file)) as {
      archives: Record<string, {uri: string; memoryId: string; revision: string}>;
      outputs: Record<string, {uri: string; memoryId: string; revision: string}>;
      status: string;
    };
  });
describe('native closeout lifecycle', () => {
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
    }).pipe(TestClock.withLive, provideNative),
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
        expect(Object.keys(image.archives)).toHaveLength(loaded.owned.length);
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
          revision: (finished.closeout as Record<string, unknown>).revision,
          archived: loaded.owned.length,
        });
        expect(yield* f.fs.readFileString(receiptFile)).toBe(bytes);
      }).pipe(TestClock.withLive, provideNative),
  );

  effectIt.effect('completes a spec-backed desktop closeout with independent verified behavior readback', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(true);
      const loaded = yield* f.load();
      expect(loaded.spec?.kind).toBe('spec');
      const {validation} = yield* prepare(f);
      expect(validationShape(validation).scenarios.map(item => item.id)).toEqual(['read']);
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
    }).pipe(TestClock.withLive, provideNative),
  );

  effectIt.effect('rejects missing acceptance and changed source without retiring any owned draft', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const loaded = yield* f.load();
      const validation = yield* f.closeout('validation-input');
      const proposal = proposalFor(validation);
      const missing = {
        ...proposal,
        phaseEvidence: proposal.phaseEvidence.map(phase => ({...phase, acceptance: []})),
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
    }).pipe(TestClock.withLive, provideNative),
  );

  effectIt.effect('preserves every remaining draft when an owned artifact is edited after admission', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const loaded = yield* f.load();
      const {proposal} = yield* prepare(f);
      const selected = loaded.owned.find(item => item.role === 'authoring-child');
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
      expect(Object.keys(image.archives)).toHaveLength(0);
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
    }).pipe(TestClock.withLive, provideNative),
  );

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
      expect(Object.keys(complete.archives)).toHaveLength(loaded.owned.length);
      for (const item of loaded.owned) {
        const archive = complete.archives[item.uri];
        expect(archive).toBeDefined();
        const observed = yield* readArtifact(f, archive.uri, item.runId);
        expect(observed).toMatchObject({uri: archive.uri, state: 'archived', memoryId: item.memoryId});
      }
    }).pipe(TestClock.withLive, provideNative),
  );

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
      expect(Object.keys(complete.archives)).toHaveLength(loaded.owned.length);
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
    }).pipe(TestClock.withLive, provideNative),
  );

  effectIt.effect('recovers a committed final behavior write whose response is lost before receipt save', () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(true);
      const loaded = yield* f.load();
      expect(loaded.spec?.kind).toBe('spec');
      yield* prepare(f);

      let lost = false;
      let observedReceiptRename = 0;
      let observedRename = 0;
      let closeoutSuffixRename = false;
      let closeoutBasenameMatches = false;
      let finalWriteVerified = false;
      let behaviorRevisionChanged = false;
      let observedOperationSuffixes = '';
      const receiptFile = f.statePath(f.controllerRunId) + '.closeout.json';
      const filesystem = f.fs;
      const interceptedFilesystem = {
        ...filesystem,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            observedRename++;
            closeoutSuffixRename ||= to.endsWith('.closeout.json');
            closeoutBasenameMatches ||= to.endsWith(`${f.controllerRunId}.json.closeout.json`);
            if (to.endsWith(`${f.controllerRunId}.json.closeout.json`) && !lost) {
              observedReceiptRename++;
              const decodeReceipt = (bytes: Uint8Array) =>
                Effect.promise(async () => {
                  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
                  return JSON.parse(
                    text.includes('threadnote-native-closeout-state-gzip-v1')
                      ? await decodeBoundedWorkflowJson(text, 'threadnote-native-closeout-state-gzip-v1')
                      : text,
                  ) as {
                    outputs?: {behavior?: {revision?: string}};
                  };
                });
              const previous = yield* decodeReceipt(yield* filesystem.readFile(receiptFile));
              const proposed = yield* decodeReceipt(yield* filesystem.readFile(from));
              const workflow = yield* readNativeWorkflowState(f.config, f.controllerRunId);
              finalWriteVerified =
                workflow?.state.operations.some(
                  operation =>
                    operation.intent.operationId.endsWith('-behavior-final') && operation.status === 'verified',
                ) ?? false;
              observedOperationSuffixes =
                workflow?.state.operations
                  .map(
                    operation => `${operation.intent.operationId.split('-').slice(-2).join('-')}:${operation.status}`,
                  )
                  .join(',') ?? '';
              behaviorRevisionChanged = Boolean(
                proposed.outputs?.behavior?.revision &&
                proposed.outputs.behavior.revision !== previous.outputs?.behavior?.revision,
              );
              if (
                finalWriteVerified &&
                proposed.outputs?.behavior?.revision &&
                proposed.outputs.behavior.revision !== previous.outputs?.behavior?.revision
              ) {
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
          `Receipt fault not reached: renames=${observedRename}, matched=${observedReceiptRename}, suffix=${closeoutSuffixRename}, basename=${closeoutBasenameMatches}, verified=${finalWriteVerified}, behaviorChanged=${behaviorRevisionChanged}, operations=${observedOperationSuffixes}.`,
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
      expect(Object.keys(complete.archives)).toHaveLength(loaded.owned.length);
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
    }).pipe(TestClock.withLive, provideNative),
  );

  for (const profile of ['codex-cloud-personal', 'cursor-cloud-personal'] as const)
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
        expect(Object.keys(image.archives)).toHaveLength(0);
        expect((yield* readArtifact(f, f.unrelated.uri, 'plan-run')).state).toBe('active');
      }).pipe(TestClock.withLive, provideNative),
    );
});
