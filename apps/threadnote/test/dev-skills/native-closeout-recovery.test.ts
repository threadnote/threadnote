import {it as effectIt} from '@effect/vitest';

import {
  Effect,
  Array as EffectArray,
  Option as EffectOption,
  String as EffectString,
  FileSystem,
  PlatformError,
  Result,
} from 'effect';

import {describe, expect} from 'vitest';

import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';

import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';

import {decodeBoundedWorkflowJson} from '../../src/workflow_memory/journal_codec.js';

import {nativeCloseoutFixture} from './native-closeout-fixture.js';

import {runCloseout} from './native-closeout-diagnostics.js';

import * as EffectRecord from 'effect/Record';

import * as Effect2 from 'effect';
import {
  assertOwnedState,
  commandResult,
  journalImage,
  object,
  prepare,
  readArtifact,
  relationTargets,
  stringField,
  windowsCloseoutTimeout,
} from './native-closeout-lifecycle-fixture.js';

describe('native closeout lifecycle', () => {
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
});
