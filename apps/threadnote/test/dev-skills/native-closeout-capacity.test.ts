import {it} from '@effect/vitest';
import {Effect, Result, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  reserveNativeCloseoutCapacity,
  clearNativeCloseoutCapacity,
  CurrentNativeCloseoutByteLimit,
  CurrentNativeCloseoutStoredByteLimit,
} from '../../src/workflow_automation/closeout_capacity.js';
import {
  CurrentNativeCloseoutSave,
  CurrentNativeOperationLimit,
  readNativeWorkflowState,
  serializeNativeWorkflowState,
} from '../../src/workflow_automation/store.js';
import {
  inspectWorkflowJournal,
  withWorkflowLock,
  workflowJournalLogicalBytes,
  serializeWorkflowJournal,
  writeJournalFile,
  workflowTransition,
} from '../../src/workflow_memory/journal.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {prepareWorkflowOperation} from '../../src/workflow_memory/artifacts.js';
import type {NativeCloseoutPlannedDocument} from '../../src/workflow_automation/closeout_documents.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const transaction = 'c'.repeat(64);
const operationId = (key: string) => 'closeout-' + transaction.slice(0, 24) + '-' + key;
const fixture = Effect.gen(function* () {
  const f = yield* nativeFixture();
  const system = yield* SystemInfo;
  const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
  yield* f.init();
  const documents = [];
  for (const key of ['one', 'two']) {
    const request = f.write({
      operationId: operationId(key),
      artifactKey: operationId(key),
      role: 'closeout-' + key,
      nameHint: key,
      body: 'Complete ' + key + '\n',
    });
    const predicted = yield* Schema.decodeUnknownEffect(Schema.Struct({uri: Schema.String}))(
      yield* f.call({...request, action: 'preflight'}),
    );
    documents.push({key, body: request.body, uri: predicted.uri, relations: []});
  }
  return {...f, documents, scopedSystem};
});

describe('whole closeout capacity reservation', () => {
  it.effect('fresh admission rejects a raced reservation without changing its ordinary retry', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reserve = (requireFreshOutputs = false) =>
        reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, f.documents, [], [], {
          requireFreshOutputs,
        }).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
      const prior = yield* reserve();
      const before = yield* f.fs.readFileString(f.statePath());
      const rejected = yield* reserve(true).pipe(Effect.result);
      expect(rejected).toMatchObject({_tag: 'Failure', failure: {code: 'closeout-capacity'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      expect(yield* reserve()).toEqual(prior);
    }).pipe(TestClock.withLive, provideNative),
  );

  for (const final of [false, true])
    it.effect('fresh admission rejects raced native output intents: final=' + final, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const id = operationId('one') + (final ? '-final' : '');
        yield* f.call(
          f.write({
            operationId: id,
            artifactKey: operationId('one'),
            role: 'closeout-one',
            nameHint: 'one',
            body: f.documents[0].body,
          }),
        );
        const before = yield* f.fs.readFileString(f.statePath());
        const documents = final ? [...f.documents, f.documents[0]] : f.documents;
        const result = yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, documents, [], [], {
          requireFreshOutputs: true,
        }).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.result);
        expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'closeout-capacity'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }).pipe(TestClock.withLive, provideNative),
    );

  it.effect('fresh admission rejects lower-only intent and pending manifest recovery before reserving', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!native) throw new Error('Expected native state');
      const bindingId = native.state.bindingId;
      const original = (yield* inspectWorkflowJournal(f.config, bindingId).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
      )).state;
      const prepared = yield* prepareWorkflowOperation(f.config, original, {
        protocolVersion: 1,
        action: 'create',
        bindingId,
        operationId: operationId('one'),
        artifactKey: operationId('one'),
        role: 'closeout-one',
        nameHint: 'one',
        sourceRunId: 'native-run',
        body: f.documents[0].body,
        bodySha256: sha256HexSync(f.documents[0].body),
        expectedRevision: null,
        storageKind: 'durable',
      }).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
      yield* withWorkflowLock(
        f.config,
        bindingId,
        writeJournalFile(f.config, {...original, operations: {...original.operations, [operationId('one')]: prepared}}),
      );
      const before = yield* f.fs.readFileString(f.statePath());
      const reserve = () =>
        reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, f.documents, [], [], {
          requireFreshOutputs: true,
        }).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.result);
      expect(yield* reserve()).toMatchObject({_tag: 'Failure', failure: {code: 'closeout-capacity'}});
      yield* withWorkflowLock(
        f.config,
        bindingId,
        writeJournalFile(f.config, workflowTransition(original, original, '2050-01-01T00:00:00.000Z')),
      );
      expect(yield* reserve()).toMatchObject({_tag: 'Failure', failure: {code: 'binding-recovery-needed'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(TestClock.withLive, provideNative),
  );
  it.effect('rejects insufficient total slots without any child write or reservation', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* f.fs.readFileString(f.statePath());
      const result = yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, f.documents, []).pipe(
        Effect.provideService(CurrentNativeOperationLimit, 1),
        Effect.provideService(SystemInfo, f.scopedSystem),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.operations).toHaveLength(0);
    }).pipe(TestClock.withLive, provideNative),
  );

  it.effect('reserves exact slots, blocks unrelated callers, resumes exact intent and releases only its owner', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reserve = (documents = f.documents) =>
        reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, documents, []).pipe(
          Effect.provideService(CurrentNativeOperationLimit, 2),
          Effect.provideService(SystemInfo, f.scopedSystem),
        );
      const admitted = yield* reserve();
      expect(admitted.operationIds).toEqual(['one', 'two'].map(operationId));
      const bytes = yield* f.fs.readFileString(f.statePath());
      expect(yield* reserve()).toEqual(admitted);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(bytes);
      expect(
        Result.isFailure(
          yield* reserve([{...f.documents[0], body: 'Changed intent.'}, f.documents[1]]).pipe(Effect.result),
        ),
      ).toBe(true);
      for (const action of ['write', 'preflight']) {
        expect(Result.isFailure(yield* f.call({...f.write(), action}).pipe(Effect.result))).toBe(true);
        expect(
          Result.isFailure(
            yield* f
              .call({...f.write(), action})
              .pipe(Effect.provideService(CurrentNativeCloseoutSave, transaction), Effect.result),
          ),
        ).toBe(true);
      }
      for (const document of f.documents) {
        yield* f
          .call(
            f.write({
              operationId: operationId(document.key),
              artifactKey: operationId(document.key),
              role: 'closeout-' + document.key,
              nameHint: document.key,
              body: document.body,
            }),
          )
          .pipe(Effect.provideService(CurrentNativeCloseoutSave, transaction));
        expect(yield* reserve()).toEqual(admitted);
      }
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.operations).toHaveLength(2);
      expect(
        Result.isFailure(
          yield* clearNativeCloseoutCapacity(f.config, 'native-run', 'd'.repeat(64)).pipe(Effect.result),
        ),
      ).toBe(true);
      yield* clearNativeCloseoutCapacity(f.config, 'native-run', transaction);
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.closeoutSave).toBeUndefined();
    }).pipe(TestClock.withLive, provideNative),
  );
  it.effect('reserves the behavior-final operation and rejects conservative packed byte overflow', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* f.fs.readFileString(f.statePath());
      const rejected = yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, f.documents, []).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
        Effect.provideService(CurrentNativeCloseoutByteLimit, 4096),
        Effect.result,
      );
      expect(Result.isFailure(rejected)).toBe(true);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      const admitted = yield* reserveNativeCloseoutCapacity(
        f.config,
        'native-run',
        transaction,
        [
          f.documents[0],
          f.documents[1],
          {...f.documents[0], relations: [{type: 'references', uri: f.documents[1].uri}]},
        ],
        [],
      ).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
      expect(admitted.operationIds).toEqual([operationId('one'), operationId('two'), operationId('one') + '-final']);
    }).pipe(TestClock.withLive, provideNative),
  );
  for (const sharedController of [false, true]) {
    it.effect('audits full original archive receipts before writes: shared controller=' + sharedController, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const sourceRun = sharedController ? 'native-run' : 'original-run';
        if (!sharedController) yield* f.init(sourceRun);
        for (let index = 0; index < 10; index++)
          yield* f.call(
            f.write({
              ...f.base('write', sourceRun),
              operationId: 'source-' + index,
              artifactKey: 'source-' + index,
              body: 'Original complete draft '.repeat(1700),
            }),
          );
        const source = yield* readNativeWorkflowState(f.config, sourceRun);
        if (!source) throw new Error('Expected authoritative original binding.');
        const journal = yield* withWorkflowLock(
          f.config,
          source.state.bindingId,
          inspectWorkflowJournal(f.config, source.state.bindingId),
        ).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
        const artifact = Object.values(journal.state.artifacts).find(item => item.artifactKey === 'source-0');
        if (!artifact) throw new Error('Expected original source artifact.');
        const archiveId = 'archive-fixture-source';
        const inventory = [
          {
            bindingId: source.state.bindingId,
            uri: artifact.canonicalUri,
            memoryId: artifact.memoryId,
            revision: artifact.revision,
            operationId: archiveId,
            artifactKey: artifact.artifactKey,
            role: artifact.role,
            sourceRunId: artifact.sourceRunId,
            destination: (yield* prepareWorkflowOperation(f.config, journal.state, {
              protocolVersion: 1,
              action: 'archive',
              bindingId: source.state.bindingId,
              operationId: archiveId,
              artifactKey: artifact.artifactKey,
              role: artifact.role,
              sourceRunId: artifact.sourceRunId,
              uri: artifact.canonicalUri,
              expectedRevision: artifact.revision,
            })).artifact.canonicalUri,
          },
        ];
        const baseline = yield* reserveNativeCloseoutCapacity(
          f.config,
          'native-run',
          transaction,
          f.documents,
          [],
        ).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
        yield* clearNativeCloseoutCapacity(f.config, 'native-run', transaction);
        const limit =
          workflowJournalLogicalBytes(journal.state, true) + (sharedController ? baseline.reservedBytes : 0) + 1;
        const beforeNative = yield* f.fs.readFileString(f.statePath());
        const beforeJournal = yield* f.fs.readFileString(f.journalPath(source.state.bindingId));
        const beforeDraft = yield* f.store.read(f.location, artifact.canonicalUri);
        const rejected = yield* reserveNativeCloseoutCapacity(
          f.config,
          'native-run',
          transaction,
          f.documents,
          [],
          inventory,
        ).pipe(
          Effect.provideService(SystemInfo, f.scopedSystem),
          Effect.provideService(CurrentNativeCloseoutByteLimit, limit),
          Effect.result,
        );
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected))
          expect(rejected.failure.message).toContain(
            sharedController ? 'complete knowledge and archive transaction' : 'original authoring journal',
          );
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeNative);
        expect(yield* f.fs.readFileString(f.journalPath(source.state.bindingId))).toBe(beforeJournal);
        expect(yield* f.store.read(f.location, artifact.canonicalUri)).toBe(beforeDraft);
        const storedLimit =
          new TextEncoder().encode(serializeWorkflowJournal(journal.state, true)).byteLength +
          (sharedController ? baseline.reservedStoredBytes : 0) +
          1;
        const storedRejected = yield* reserveNativeCloseoutCapacity(
          f.config,
          'native-run',
          transaction,
          f.documents,
          [],
          inventory,
        ).pipe(
          Effect.provideService(SystemInfo, f.scopedSystem),
          Effect.provideService(CurrentNativeCloseoutStoredByteLimit, storedLimit),
          Effect.result,
        );
        expect(Result.isFailure(storedRejected)).toBe(true);
        if (Result.isFailure(storedRejected)) expect(storedRejected.failure.message).toContain('stored byte limit');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeNative);
        expect(yield* f.fs.readFileString(f.journalPath(source.state.bindingId))).toBe(beforeJournal);
        expect(yield* f.store.read(f.location, artifact.canonicalUri)).toBe(beforeDraft);
        const admitted = yield* reserveNativeCloseoutCapacity(
          f.config,
          'native-run',
          transaction,
          f.documents,
          [],
          inventory,
        ).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
        expect(admitted.operationIds).toHaveLength(2);
        expect(
          yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, f.documents, [], inventory).pipe(
            Effect.provideService(SystemInfo, f.scopedSystem),
          ),
        ).toEqual(admitted);
        expect(yield* f.fs.readFileString(f.journalPath(source.state.bindingId))).toBe(beforeJournal);
        yield* runWorkflowMemory(f.config, {
          protocolVersion: 1,
          action: 'archive',
          bindingId: source.state.bindingId,
          operationId: archiveId,
          artifactKey: artifact.artifactKey,
          role: artifact.role,
          sourceRunId: artifact.sourceRunId,
          uri: artifact.canonicalUri,
          expectedRevision: artifact.revision,
        }).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
        expect(
          yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, f.documents, [], inventory).pipe(
            Effect.provideService(SystemInfo, f.scopedSystem),
          ),
        ).toEqual(admitted);
        const archivedContent = yield* f.store.read(f.location, inventory[0].destination);
        yield* f.store.write(f.location, inventory[0].destination, archivedContent + '\nExternal edit.\n', {
          mode: 'replace',
        });
        const nativeBeforeDriftCheck = yield* f.fs.readFileString(f.statePath());
        const drift = yield* reserveNativeCloseoutCapacity(
          f.config,
          'native-run',
          transaction,
          f.documents,
          [],
          inventory,
        ).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.result);
        expect(Result.isFailure(drift)).toBe(true);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(nativeBeforeDriftCheck);
      }).pipe(TestClock.withLive, provideNative),
    );
  }
  it.effect('admits and completes thirty small decisions with all indexes and exact stored retry credit', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const documents: NativeCloseoutPlannedDocument[] = [];
      const add = (key: string, targets: readonly NativeCloseoutPlannedDocument[] = []) =>
        Effect.gen(function* () {
          const body = 'Complete original selected/rejected choices and rationale for ' + key + '.\n';
          const predicted = yield* Schema.decodeUnknownEffect(Schema.Struct({uri: Schema.String}))(
            yield* f.call({
              ...f.write({
                operationId: operationId(key),
                artifactKey: operationId(key),
                role: 'closeout-' + key,
                nameHint: key,
                body,
              }),
              action: 'preflight',
            }),
          );
          const document = {
            key,
            body,
            uri: predicted.uri,
            relations: targets.map(target => ({type: 'references' as const, uri: target.uri})),
          };
          documents.push(document);
          return document;
        });
      for (let index = 0; index < 30; index++) yield* add('decision-' + index);
      let next: NativeCloseoutPlannedDocument | undefined;
      for (let end = 30; end > 0;) {
        const start = Math.max(0, end - 12);
        next = yield* add('decisions-' + start, [...documents.slice(start, end), ...(next ? [next] : [])]);
        end = start;
      }
      const handoff = yield* add('handoff');
      yield* add('architecture', [...(next ? [next] : []), handoff]);
      expect(documents).toHaveLength(35);
      const reserve = () =>
        reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, documents, []).pipe(
          Effect.provideService(SystemInfo, f.scopedSystem),
        );
      const reservation = yield* reserve();
      expect(reservation.reservedBytes).toBeGreaterThan(16 * 1024 * 1024);
      expect(reservation.reservedStoredBytes).toBeLessThan(16 * 1024 * 1024);
      for (const document of documents) {
        yield* f
          .call(
            f.write({
              operationId: operationId(document.key),
              artifactKey: operationId(document.key),
              role: 'closeout-' + document.key,
              nameHint: document.key,
              body: document.body,
              relations: document.relations,
            }),
          )
          .pipe(Effect.provideService(CurrentNativeCloseoutSave, transaction));
      }
      expect(yield* reserve()).toEqual(reservation);
      const completed = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(completed?.state.operations).toHaveLength(35);
      expect(completed?.state.operations.every(operation => operation.status === 'verified')).toBe(true);
      if (!completed) throw new Error('Expected completed native controller.');
      const actual = yield* withWorkflowLock(
        f.config,
        completed.state.bindingId,
        inspectWorkflowJournal(f.config, completed.state.bindingId),
      ).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
      expect(new TextEncoder().encode(serializeWorkflowJournal(actual.state, true)).byteLength).toBeLessThanOrEqual(
        reservation.journalStoredBytesAtStart + reservation.reservedStoredBytes,
      );
      expect(new TextEncoder().encode(serializeNativeWorkflowState(completed.state)).byteLength).toBeLessThanOrEqual(
        16 * 1024 * 1024,
      );
    }).pipe(TestClock.withLive, provideNative),
  );
});
