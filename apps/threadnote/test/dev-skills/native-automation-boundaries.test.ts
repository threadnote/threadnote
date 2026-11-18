import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Result, Schema, Stdio, Stream} from 'effect';
import {describe, expect} from 'vitest';
import {nativeWorkflowIntentDigest} from '@threadnote/workflow-automations/native';
import {readNativeWorkflowInput} from '../../src/effect/workflow_automation_cli.js';
import {
  readNativeWorkflowState,
  withNativeWorkflowLock,
  writeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('native workflow automation boundaries', () => {
  effectIt.effect('decodes UTF-8 across stdin chunks and rejects malformed or truncated input', () =>
    Effect.gen(function* () {
      const encoded = new TextEncoder().encode('{"text":"🌊"}');
      const split = encoded.findIndex(byte => byte >= 0xf0);
      const chunks = [encoded.slice(0, split + 2), encoded.slice(split + 2)];
      const decoded = yield* provideTestStdin(Stream.fromIterable(chunks))(readNativeWorkflowInput);
      expect(decoded).toBe('{"text":"🌊"}');
      for (const bytes of [[0xff], [0xc3]] as const) {
        const result = yield* provideTestStdin(Stream.make(new Uint8Array(bytes)))(readNativeWorkflowInput).pipe(
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure).toMatchObject({code: 'invalid-request'});
      }
    }),
  );

  effectIt.effect('stops reading stdin as soon as the byte limit is crossed', () =>
    Effect.gen(function* () {
      let consumed = 0;
      const stream = Stream.fromIterable([
        new Uint8Array(2_000_000),
        new Uint8Array([0x20]),
        new TextEncoder().encode('trailing-sentinel'),
      ]).pipe(Stream.tap(() => Effect.sync(() => (consumed += 1))));
      const result = yield* provideTestStdin(stream)(readNativeWorkflowInput).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toMatchObject({code: 'invalid-request'});
      expect(consumed).toBe(2);
    }),
  );

  effectIt.effect('rejects legacy, foreign-version and linked state without changing state or native documents', () =>
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
      const canonicalJournal = yield* f.fs.readFileString(journalFile);
      const written = JSON.parse(yield* f.fs.readFileString(stateFile));
      const cases = [
        ['{"protocolVersion":1,"binding":{},"operations":{}}\n', 'unsupported-state'],
        [
          JSON.stringify({...written, stateVersion: written.stateVersion + 1, fieldAddedByNewerRuntime: true}),
          'state-version-mismatch',
        ],
        [
          JSON.stringify({
            format: 'python-workflow-run',
            stateVersion: 1,
            executorVersion: 1,
          }),
          'unsupported-state',
        ],
      ] as const;
      for (const [bytes, code] of cases) {
        yield* f.fs.writeFileString(stateFile, bytes);
        const inspect = yield* f.call(f.base('inspect')).pipe(Effect.result);
        expect(Result.isFailure(inspect)).toBe(true);
        if (Result.isFailure(inspect)) expect(inspect.failure).toMatchObject({code});
        expect(yield* f.fs.readFileString(stateFile)).toBe(bytes);
        expect(yield* f.fs.readFileString(journalFile)).toBe(canonicalJournal);
        const initialize = yield* f.init().pipe(Effect.result);
        expect(Result.isFailure(initialize)).toBe(true);
        if (Result.isFailure(initialize)) expect(initialize.failure).toMatchObject({code});
        expect(yield* f.fs.readFileString(stateFile)).toBe(bytes);
        const write = yield* f.call(f.write()).pipe(Effect.result);
        expect(Result.isFailure(write)).toBe(true);
        if (Result.isFailure(write)) expect(write.failure).toMatchObject({code});
        expect(yield* f.fs.readFileString(stateFile)).toBe(bytes);
        expect(yield* f.fs.readFileString(journalFile)).toBe(canonicalJournal);
      }
      yield* f.fs.remove(stateFile);
      const external = f.path.join(f.root, 'external-state.json');
      const foreignBytes = '{"format":"legacy","must":"remain untouched"}\n';
      yield* f.fs.writeFileString(external, foreignBytes);
      // Windows file links require host privileges; exercise the same platform readLink boundary there.
      if (process.platform !== 'win32') yield* f.fs.symlink(external, stateFile);
      const linkedFs =
        process.platform === 'win32'
          ? FileSystem.FileSystem.of({
              ...f.fs,
              readLink: file => (file === stateFile ? Effect.succeed(external) : f.fs.readLink(file)),
            })
          : f.fs;
      const unsafe = yield* f
        .call(f.base('inspect'))
        .pipe(Effect.provideService(FileSystem.FileSystem, linkedFs), Effect.result);
      expect(Result.isFailure(unsafe)).toBe(true);
      if (Result.isFailure(unsafe)) expect(unsafe.failure).toMatchObject({code: 'unsafe-state'});
      expect(yield* f.fs.readFileString(external)).toBe(foreignBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(canonicalJournal);
    }).pipe(provideNative),
  );

  effectIt.effect('declares a state version newer than the policy-free first schema on every write', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init('native-run', 'skill-generation-v1', 'fixture', 'standard');
      const capabilities = yield* f.call({protocolVersion: 1, executorVersion: 1, action: 'capabilities'});
      const declared = () => f.fs.readFileString(f.statePath()).pipe(Effect.map(bytes => JSON.parse(bytes)));
      const initialized = yield* declared();
      expect(initialized.policy).toEqual({mode: 'standard'});
      expect(initialized.stateVersion).toBeGreaterThan(1);
      expect(capabilities).toMatchObject({stateVersion: initialized.stateVersion});
      // A run an earlier runtime wrote at the first version stays readable and is re-declared when rewritten.
      yield* f.fs.writeFileString(f.statePath(), JSON.stringify({...initialized, stateVersion: 1}) + '\n');
      expect(yield* f.call(f.base('inspect'))).toMatchObject({status: 'ok', stateVersion: 1});
      yield* f.call(f.write());
      expect((yield* declared()).stateVersion).toBe(initialized.stateVersion);
    }).pipe(provideNative),
  );

  effectIt.effect('rejects stale generation and other native homes without rewriting a valid run', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const before = yield* f.fs.readFileString(f.statePath());
      const initializedAgain = yield* f
        .call({
          ...f.base('init'),
          project: 'fixture',
          featureId: 'feature',
          profile: 'codex-cloud-personal',
        })
        .pipe(Effect.result);
      expect(Result.isFailure(initializedAgain)).toBe(true);
      const stale = yield* f.call(f.base('inspect', 'native-run', 'different-generation')).pipe(Effect.result);
      expect(Result.isFailure(stale)).toBe(true);
      if (Result.isFailure(stale)) expect(stale.failure).toMatchObject({code: 'generation-conflict'});
      const otherHome = f.path.join(f.root, 'other-home');
      yield* f.fs.makeDirectory(otherHome);
      const drift = yield* f.call(f.base('inspect'), {...f.config, agentContextHome: otherHome}).pipe(Effect.result);
      expect(Result.isFailure(drift)).toBe(true);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(provideNative),
  );

  effectIt.effect('preserves a concurrent native state revision at the local receipt CAS boundary', () =>
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
      const stateBefore = yield* f.fs.readFileString(stateFile);
      const journalBefore = yield* f.fs.readFileString(journalFile);
      const competingState = Effect2.pipe(
        stateBefore,
        EffectString.replace('skill-generation-v1', 'competing-generation'),
      );
      const originalFs = yield* FileSystem.FileSystem;
      let reads = 0;
      let injected = false;
      const racingFs = FileSystem.FileSystem.of({
        ...originalFs,
        readFileString: file =>
          file === stateFile && ++reads === 2
            ? originalFs.writeFileString(stateFile, competingState).pipe(
                Effect.andThen(originalFs.readFileString(stateFile)),
                Effect.tap(() => Effect.sync(() => (injected = true))),
              )
            : originalFs.readFileString(file),
      });
      const result = yield* f
        .call(f.write())
        .pipe(Effect.provideService(FileSystem.FileSystem, racingFs), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toMatchObject({code: 'state-conflict'});
      expect(injected).toBe(true);
      expect(yield* f.fs.readFileString(stateFile)).toBe(competingState);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBefore);
    }).pipe(provideNative),
  );

  effectIt.effect('round-trips a compressed native state whose valid prepared intents exceed one MiB', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const runId = 'native-run';
      const body = `Large native receipt payload — ${Effect2.pipe('evidence remains deterministic. ', EffectString.repeat(96))}\n`;
      const operations = Array.from({length: 400}, (_, index) => {
        const operationId = `op-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`;
        const intent = {
          bindingId: initialized.bindingId,
          operationId,
          artifactKey: operationId,
          sourceRunId: runId,
          role: 'root',
          body,
          expectedRevision: null,
        };
        return {
          status: 'prepared' as const,
          intent,
          intentDigest: nativeWorkflowIntentDigest(intent),
        };
      });
      const payload = yield* withNativeWorkflowLock(
        f.config,
        runId,
        false,
        Effect.gen(function* () {
          const current = yield* readNativeWorkflowState(f.config, runId);
          if (!current) throw new Error('Expected initialized native state');
          const state = {...current.state, operations};
          expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeGreaterThan(1_000_000);
          yield* writeNativeWorkflowState(f.config, state, current.revision);
          return state;
        }),
      );
      const bytes = yield* f.fs.readFileString(f.statePath());
      const envelope = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          format: Schema.String,
          expandedBytes: Schema.Int,
        }),
      )(JSON.parse(bytes));
      expect(envelope).toMatchObject({
        format: 'threadnote-native-workflow-state-gzip-v1',
      });
      expect(envelope.expandedBytes).toBeGreaterThan(1_000_000);
      const reread = yield* readNativeWorkflowState(f.config, runId);
      expect(reread?.state).toEqual(payload);
    }).pipe(provideNative),
  );
});

function provideTestStdin(stdin: Stream.Stream<Uint8Array>) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(provideTestLayer(Stdio.layerTest({stdin})));
}
