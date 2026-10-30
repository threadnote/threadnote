import {it as effectIt} from '@effect/vitest';

import {Effect, Array as EffectArray, Option as EffectOption, Result} from 'effect';

import {describe, expect} from 'vitest';

import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';

import {decodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';

import {nativeCloseoutFixture} from './native-closeout-fixture.js';

import {runCloseout} from './native-closeout-diagnostics.js';

import * as EffectRecord from 'effect/Record';

import {
  assertOwnedState,
  commandResult,
  journalImage,
  object,
  prepare,
  proposalFor,
  readArtifact,
  relationTargets,
  stringField,
  validationShape,
  windowsCloseoutTimeout,
} from './native-closeout-lifecycle-fixture.js';

describe('native closeout lifecycle', () => {
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
});
