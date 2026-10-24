import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CurrentWorkflowReadCache,
  immutableWorkflowImage,
  withWorkflowReadCache,
} from '../../src/workflow_memory/read_cache.js';
import {inspectWorkflowJournal} from '../../src/workflow_memory/journal.js';
import {
  readNativeWorkflowState,
  withNativeWorkflowLock,
  writeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

describe('native authoring request cache', () => {
  effectIt.effect('reuses only exact native and journal bytes within one request scope', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const journalFile = f.journalPath(initialized.bindingId);
      const nativeFile = f.statePath();
      const system = yield* SystemInfo;
      const fixtureSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      const readJournal = () =>
        inspectWorkflowJournal(f.config, initialized.bindingId).pipe(Effect.provideService(SystemInfo, fixtureSystem));

      const observations = yield* withWorkflowReadCache(
        Effect.gen(function* () {
          const firstNative = yield* readNativeWorkflowState(f.config, 'native-run');
          if (!firstNative) throw new Error('Expected initialized native state');
          const secondNative = yield* readNativeWorkflowState(f.config, 'native-run');
          const firstJournal = yield* readJournal();
          const secondJournal = yield* readJournal();
          const beforeBytes = yield* f.fs.readFileString(nativeFile);

          // Case is not part of the canonical family slug, so this remains valid
          // while changing serialized bytes without changing their length.
          const changedState = {...firstNative.state, title: 'Feature'};
          yield* withNativeWorkflowLock(
            f.config,
            'native-run',
            false,
            writeNativeWorkflowState(f.config, changedState, firstNative.revision),
          ).pipe(Effect.provideService(CurrentWorkflowReadCache, undefined));
          const afterBytes = yield* f.fs.readFileString(nativeFile);
          const refreshedNative = yield* readNativeWorkflowState(f.config, 'native-run');
          if (!refreshedNative) throw new Error('Changed native state disappeared');

          return {
            firstNative: firstNative.state,
            secondNative: secondNative?.state,
            firstJournal: firstJournal.state,
            secondJournal: secondJournal.state,
            beforeBytes,
            afterBytes,
            refreshedNative: refreshedNative.state,
          };
        }),
      );

      expect(observations.secondNative).toBe(observations.firstNative);
      expect(observations.secondJournal).toBe(observations.firstJournal);
      expect(Object.isFrozen(observations.firstNative)).toBe(true);
      expect(Object.isFrozen(observations.firstNative.operations)).toBe(true);
      expect(observations.beforeBytes).not.toBe(observations.afterBytes);
      expect(new TextEncoder().encode(observations.beforeBytes).byteLength).toBe(
        new TextEncoder().encode(observations.afterBytes).byteLength,
      );
      expect(observations.refreshedNative).not.toBe(observations.firstNative);
      expect(observations.refreshedNative.title).toBe('Feature');

      const nextScope = yield* withWorkflowReadCache(readNativeWorkflowState(f.config, 'native-run'));
      expect(nextScope?.state).not.toBe(observations.refreshedNative);
      const journalAfterScope = yield* f.fs.readFileString(journalFile);
      expect(journalAfterScope).toBeTruthy();
    }).pipe(run),
  );

  effectIt.effect('does not let cached success hide changed native, journal, or manifest state', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const nativeFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const journalFile = f.journalPath(initialized.bindingId);
      const originalState = yield* f.fs.readFileString(nativeFile);
      const originalJournal = yield* f.fs.readFileString(journalFile);
      const journal = JSON.parse(originalJournal) as {manifestUri: string};
      const originalManifest = yield* f.store.read(f.location, journal.manifestUri);

      yield* withWorkflowReadCache(
        Effect.gen(function* () {
          const initial = yield* f.call(f.base('inspect'));
          expect(initial).toMatchObject({status: 'ok', runId: 'native-run'});

          const corruptState = '{"format":"threadnote-native-workflow",';
          yield* f.fs.writeFileString(nativeFile, corruptState);
          const nativeFailure = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(nativeFailure)).toBe(true);
          if (Result.isFailure(nativeFailure)) expect(nativeFailure.failure).toMatchObject({code: 'invalid-state'});
          expect(yield* f.fs.readFileString(nativeFile)).toBe(corruptState);
          yield* f.fs.writeFileString(nativeFile, originalState);
          expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', runId: 'native-run'});

          const corruptJournal = '{"protocolVersion":1,';
          yield* f.fs.writeFileString(journalFile, corruptJournal);
          const journalFailure = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(journalFailure)).toBe(true);
          if (Result.isFailure(journalFailure)) expect(journalFailure.failure).toMatchObject({code: 'invalid-journal'});
          expect(yield* f.fs.readFileString(journalFile)).toBe(corruptJournal);
          yield* f.fs.writeFileString(journalFile, originalJournal);
          expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', runId: 'native-run'});

          const corruptManifest = originalManifest.replace('workflow-feature', 'workflow-fEature');
          expect(corruptManifest).not.toBe(originalManifest);
          yield* f.store.write(f.location, journal.manifestUri, corruptManifest, {mode: 'replace'});
          const manifestFailure = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(manifestFailure)).toBe(true);
          if (Result.isFailure(manifestFailure))
            expect(manifestFailure.failure).toMatchObject({code: 'task-state-lost'});
          expect(yield* f.store.read(f.location, journal.manifestUri)).toBe(corruptManifest);
          yield* f.store.write(f.location, journal.manifestUri, originalManifest, {mode: 'replace'});
          expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', runId: 'native-run'});
        }),
      );

      expect(yield* f.fs.readFileString(nativeFile)).toBe(originalState);
      expect(yield* f.fs.readFileString(journalFile)).toBe(originalJournal);
      expect(yield* f.store.read(f.location, journal.manifestUri)).toBe(originalManifest);
    }).pipe(run),
  );

  effectIt.effect('observes missing and linked state/journal files despite a warm cache', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const nativeFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const journalFile = f.journalPath(initialized.bindingId);
      const system = yield* SystemInfo;
      const fixtureSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      const readJournal = () =>
        inspectWorkflowJournal(f.config, initialized.bindingId).pipe(Effect.provideService(SystemInfo, fixtureSystem));
      const nativeBytes = yield* f.fs.readFileString(nativeFile);
      const journalBytes = yield* f.fs.readFileString(journalFile);
      const external = f.path.join(f.root, 'external-state.json');
      yield* f.fs.writeFileString(external, nativeBytes);

      yield* withWorkflowReadCache(
        Effect.gen(function* () {
          expect(yield* readNativeWorkflowState(f.config, 'native-run')).toBeTruthy();
          expect((yield* readJournal()).state.binding.bindingId).toBe(initialized.bindingId);

          yield* f.fs.remove(nativeFile);
          expect(yield* readNativeWorkflowState(f.config, 'native-run')).toBeUndefined();
          const missingRun = yield* f.call(f.base('inspect')).pipe(Effect.result);
          expect(Result.isFailure(missingRun)).toBe(true);
          if (Result.isFailure(missingRun)) expect(missingRun.failure).toMatchObject({code: 'run-not-found'});
          yield* f.fs.writeFileString(nativeFile, nativeBytes);

          yield* f.fs.remove(journalFile);
          const missingJournal = yield* readJournal().pipe(Effect.result);
          expect(Result.isFailure(missingJournal)).toBe(true);
          if (Result.isFailure(missingJournal)) expect(missingJournal.failure).toMatchObject({code: 'task-state-lost'});
          yield* f.fs.writeFileString(journalFile, journalBytes);

          const linkedFs = FileSystem.FileSystem.of({
            ...f.fs,
            readLink: file =>
              file === nativeFile || file === journalFile ? Effect.succeed(external) : f.fs.readLink(file),
          });
          const linkedRun = yield* readNativeWorkflowState(f.config, 'native-run').pipe(
            Effect.provideService(FileSystem.FileSystem, linkedFs),
            Effect.result,
          );
          expect(Result.isFailure(linkedRun)).toBe(true);
          if (Result.isFailure(linkedRun)) expect(linkedRun.failure).toMatchObject({code: 'unsafe-state'});

          const linkedJournal = yield* readJournal().pipe(
            Effect.provideService(FileSystem.FileSystem, linkedFs),
            Effect.result,
          );
          expect(Result.isFailure(linkedJournal)).toBe(true);
          if (Result.isFailure(linkedJournal)) expect(linkedJournal.failure).toMatchObject({code: 'unsafe-journal'});
        }),
      );
      expect(yield* f.fs.readFileString(external)).toBe(nativeBytes);
    }).pipe(run),
  );

  effectIt.effect('updates cached postimages after a real native write and verifies exact readback', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const journalFile = f.journalPath(initialized.bindingId);
      const nativeFile = f.statePath();
      const system = yield* SystemInfo;
      const fixtureSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      const readJournal = () =>
        inspectWorkflowJournal(f.config, initialized.bindingId).pipe(Effect.provideService(SystemInfo, fixtureSystem));
      const nativeBefore = yield* f.fs.readFileString(nativeFile);
      const journalBefore = yield* f.fs.readFileString(journalFile);

      yield* withWorkflowReadCache(
        Effect.gen(function* () {
          const initialState = yield* readNativeWorkflowState(f.config, 'native-run');
          const initialJournal = yield* readJournal();
          expect(initialState?.state.operations).toHaveLength(0);
          expect(Object.keys(initialJournal.state.operations)).toHaveLength(0);

          const write = f.write();
          const result = yield* f.call(write).pipe(Effect.result);
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isFailure(result)) return;
          if (!('artifact' in result.success)) throw new Error('Expected a verified artifact');
          const artifact = result.success.artifact as {uri: string; body?: string};

          const writtenState = yield* readNativeWorkflowState(f.config, 'native-run');
          const writtenJournal = yield* readJournal();
          expect(writtenState?.state.operations.map(operation => operation.intent.operationId)).toContain('write-1');
          expect(Object.keys(writtenJournal.state.operations)).toContain('write-1');
          const readback = yield* f.call({...f.base('read'), uri: artifact.uri});
          expect(readback).toMatchObject({status: 'ok', artifact: {uri: artifact.uri, body: write.body}});

          expect(yield* f.fs.readFileString(nativeFile)).not.toBe(nativeBefore);
          expect(yield* f.fs.readFileString(journalFile)).not.toBe(journalBefore);
        }),
      );
    }).pipe(run),
  );
});

it('deep-freezes descendants even when the image root was already shallow-frozen', () => {
  const image = Object.freeze({nested: {leaf: {value: 'stable'}}, rows: [{value: 1}]});
  expect(immutableWorkflowImage(image)).toBe(image);
  expect(Object.isFrozen(image)).toBe(true);
  expect(Object.isFrozen(image.nested)).toBe(true);
  expect(Object.isFrozen(image.nested.leaf)).toBe(true);
  expect(Object.isFrozen(image.rows)).toBe(true);
  expect(Object.isFrozen(image.rows[0])).toBe(true);
});
