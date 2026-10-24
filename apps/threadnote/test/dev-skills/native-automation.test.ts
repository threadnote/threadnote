import {Effect, FileSystem, Result} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

describe('native workflow automation', () => {
  effectIt.effect('creates and resumes a stable native run without rewriting verified bytes', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      expect(initialized).toMatchObject({status: 'ok', runId: 'native-run', generation: 'skill-generation-v1'});
      const bindingId = initialized.bindingId;
      const initialState = yield* f.fs.readFileString(f.statePath());
      const journalPath = f.journalPath(bindingId);
      const firstJournal = yield* f.fs.readFileString(journalPath);
      const write = f.write();
      const writeResult = yield* f.call(write).pipe(Effect.result);
      const writtenState = yield* f.fs.readFileString(f.statePath());
      expect(Result.isSuccess(writeResult), writtenState).toBe(true);
      if (Result.isFailure(writeResult)) return;
      const written = writeResult.success;
      if (!('artifact' in written)) throw new Error('Expected verified native artifact');
      expect(written).toMatchObject({status: 'ok', operationId: 'write-1', artifact: {body: write.body}});
      const artifactUri = (written.artifact as {uri: string}).uri;
      const artifactBytes = yield* f.store.read(f.location, artifactUri);
      const journalAfterWrite = yield* f.fs.readFileString(journalPath);
      const journalValue = JSON.parse(journalAfterWrite) as {manifestUri: string};
      const manifestBytes = yield* f.store.read(f.location, journalValue.manifestUri);
      const stateAfterWrite = yield* f.fs.readFileString(f.statePath());
      const read = yield* f.call({...f.base('read'), uri: artifactUri});
      expect(read).toMatchObject({status: 'ok', artifact: {body: write.body, uri: artifactUri}});
      const inspected = yield* f.call(f.base('inspect'));
      expect(JSON.stringify(inspected)).not.toContain(write.body);
      expect(inspected).toMatchObject({operations: [{operationId: 'write-1', status: 'verified'}]});
      yield* f.init();
      const replayPreflight = yield* f.call({...write, action: 'preflight'}).pipe(Effect.result);
      expect(Result.isSuccess(replayPreflight), JSON.stringify(replayPreflight)).toBe(true);
      const replayWrite = yield* f.call(write).pipe(Effect.result);
      expect(
        Result.isSuccess(replayWrite),
        'same verified write intent should replay without creating a duplicate',
      ).toBe(true);
      const replayRecovery = yield* f.call({...f.base('recover'), operationId: 'write-1'}).pipe(Effect.result);
      expect(Result.isSuccess(replayRecovery), 'verified operation recovery should be a read-only confirmation').toBe(
        true,
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stateAfterWrite);
      expect(yield* f.fs.readFileString(journalPath)).toBe(journalAfterWrite);
      expect(yield* f.store.read(f.location, artifactUri)).toBe(artifactBytes);
      expect(yield* f.store.read(f.location, journalValue.manifestUri)).toBe(manifestBytes);
      expect(initialState).not.toBe(stateAfterWrite);
      expect(firstJournal).not.toBe(journalAfterWrite);
      expect(yield* failure(f.call(f.write({body: 'Changed intent.\n'})))).toMatchObject({
        failure: {code: 'operation-intent-conflict'},
      });
      const changedGeneration = yield* failure(f.call(f.base('inspect', 'native-run', 'other-generation')));
      expect(changedGeneration).toMatchObject({failure: {code: 'generation-conflict'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(stateAfterWrite);
    }).pipe(run),
  );

  effectIt.effect('recovers a prepared receipt after checked native memory write fails', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const statePath = f.statePath();
      const journalPath = f.journalPath(initialized.bindingId);
      const existing = (yield* f.call(f.write())) as {artifact: {uri: string; revision: string}};
      const replace = f.write({
        action: 'write',
        operationId: 'replace-interrupted',
        artifactKey: 'plan-root',
        uri: existing.artifact.uri,
        expectedRevision: existing.artifact.revision,
        body: 'Replacement after interruption.\n',
      });
      const beforeJournal = yield* f.fs.readFileString(journalPath);
      const store = f.store;
      let failed = false;
      const guardedStore = {
        ...store,
        writeChecked: (...args: Parameters<typeof store.writeChecked>) => {
          if (!failed) {
            failed = true;
            return Effect.fail(
              ResourceIoFailed.make({
                uri: args[1],
                operation: 'write',
                message: 'Synthetic interrupted native artifact write',
                cause: new Error('Synthetic interrupted native artifact write'),
              }),
            );
          }
          return store.writeChecked(...args);
        },
      };
      const interrupted = yield* failure(f.call(replace).pipe(Effect.provideService(ResourceStore, guardedStore)));
      expect(Result.isFailure(interrupted)).toBe(true);
      expect(failed).toBe(true);
      expect(JSON.parse(yield* f.fs.readFileString(statePath))).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({
            status: 'prepared',
            intent: expect.objectContaining({operationId: 'replace-interrupted'}),
          }),
        ]),
      });
      expect(yield* f.fs.readFileString(journalPath)).not.toBe(beforeJournal);
      const recovered = yield* f.call({...f.base('recover'), operationId: 'replace-interrupted'});
      expect(recovered).toMatchObject({
        status: 'ok',
        operationId: 'replace-interrupted',
        artifact: {body: replace.body},
      });
      const journalAfter = JSON.parse(yield* f.fs.readFileString(journalPath)) as {artifacts: Record<string, unknown>};
      expect(Object.keys(journalAfter.artifacts)).toHaveLength(1);
      expect(JSON.parse(yield* f.fs.readFileString(statePath))).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({
            status: 'verified',
            intent: expect.objectContaining({operationId: 'replace-interrupted'}),
          }),
        ]),
      });
    }).pipe(run),
  );

  effectIt.effect('recovers native success when the local verified receipt rename is interrupted', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const stateFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const journalFile = f.journalPath(initialized.bindingId);
      const originalFs = yield* FileSystem.FileSystem;
      let stateCommits = 0;
      const interruptedFs = FileSystem.FileSystem.of({
        ...originalFs,
        rename: (from, to) =>
          to === stateFile && ++stateCommits === 2
            ? Effect.sync(() => {
                throw new Error('Synthetic native receipt rename interruption');
              })
            : originalFs.rename(from, to),
      });
      const result = yield* failure(
        f.call(f.write()).pipe(Effect.provideService(FileSystem.FileSystem, interruptedFs)),
      );
      expect(Result.isFailure(result)).toBe(true);
      const nativeState = JSON.parse(yield* f.fs.readFileString(stateFile)) as {operations: {status: string}[]};
      expect(nativeState.operations).toMatchObject([{status: 'prepared'}]);
      const pendingStateBytes = yield* f.fs.readFileString(stateFile);
      const verifiedJournal = yield* f.fs.readFileString(journalFile);
      expect(JSON.parse(verifiedJournal)).toMatchObject({operations: {'write-1': {status: 'verified'}}});
      const inspection = yield* f.call(f.base('inspect'));
      expect(inspection).toMatchObject({operations: [{status: 'prepared'}]});
      expect(yield* f.fs.readFileString(stateFile)).toBe(pendingStateBytes);
      const recovered = yield* f.call({...f.base('recover'), operationId: 'write-1'});
      expect(recovered).toMatchObject({status: 'ok', operationId: 'write-1'});
      expect(JSON.parse(yield* f.fs.readFileString(stateFile))).toMatchObject({operations: [{status: 'verified'}]});
      expect(yield* f.fs.readFileString(journalFile)).toBe(verifiedJournal);
    }).pipe(run),
  );
});
