import {it, expect} from '@effect/vitest';
import {Clock, Context, DateTime, Effect, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {vi} from 'vitest';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';
import {SystemInfo} from '@threadnote/platform/system';
import {runCommandEffect} from '@threadnote/platform/command';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {prepareWorkflowOperation, withWorkflowProjectionCitations} from '../../src/workflow_memory/artifacts.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {inspectWorkflowJournal} from '../../src/workflow_memory/journal.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {reserveNativeCloseoutCapacity} from '../../src/workflow_automation/closeout_capacity.js';
import {workflowWriteRequest} from '../../src/workflow_automation/memory.js';
import {projectNativeCloseoutKnowledge} from '../../src/workflow_automation/closeout_projection.js';
import type {NativeCloseoutPlannedDocument} from '../../src/workflow_automation/closeout_documents.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const mode = vi.hoisted(() => ({ordinary: false}));
vi.mock('../../src/workflow_memory/artifacts.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/workflow_memory/artifacts.js')>();
  return {
    ...original,
    withWorkflowProjectionCitations: (...args: Parameters<typeof original.withWorkflowProjectionCitations>) =>
      Effect.suspend(() =>
        mode.ordinary
          ? args[3]((journal, request) => original.prepareWorkflowOperation(args[0], journal, request))
          : original.withWorkflowProjectionCitations(...args),
      ),
  };
});
const transaction = 'a'.repeat(64);

const fixture = Effect.fn('test.closeoutCitationProjection')(function* () {
  const f = yield* nativeFixture();
  const system = yield* SystemInfo;
  const clock = yield* Clock.Clock;
  const fixed = yield* Clock.currentTimeMillis;
  let leaseElapsed = 0n;
  let closingFailure: 'expiry' | 'interruption' | undefined;
  const fixedClock: Clock.Clock = {
    currentTimeMillis: Effect.succeed(fixed),
    currentTimeMillisUnsafe: () => fixed,
    currentTimeNanos: Effect.succeed(BigInt(fixed) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(fixed) * 1_000_000n,
    monotonicTimeNanos: clock.monotonicTimeNanos.pipe(Effect.map(time => time + leaseElapsed)),
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe() + leaseElapsed,
    sleep: duration => clock.sleep(duration),
  };
  const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
  yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
  yield* runCommandEffect('git', [
    '-C',
    f.repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  const initialized = yield* f.init();
  const graphStore = yield* CodeGraphStore;
  const packs = createCodeGraphLanguagePackRegistry([]);
  const identity = yield* resolveRepositoryIdentity(f.repo);
  const layout = codeGraphLayout(f.path, f.home, identity.checkoutId, identity.worktreeId);
  const bytes = yield* f.fs.readFile(f.path.join(f.repo, 'source.ts'));
  const snapshot: CodeGraphSnapshot = {
    id: 'cgsn_' + '1'.repeat(40),
    commit: identity.headCommit,
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    extractorSet: extractorSetIdentityFromPackProvenance([]),
    dirty: false,
    edgeCount: 0,
    fileCount: 1,
    symbolCount: 0,
    state: 'ready',
    completedAt: DateTime.formatIso(DateTime.makeUnsafe(fixed)),
  };
  yield* graphStore.activate(
    layout.databasePath,
    identity,
    snapshot,
    [
      {
        blobId: (yield* runCommandEffect('git', ['-C', f.repo, 'rev-parse', 'HEAD:source.ts'])).stdout.trim(),
        contentHash: codeGraphCommittedFileContentHash('sha1', bytes),
        path: 'source.ts',
        language: 'typescript',
        mode: '100644',
        size: bytes.length,
        source: 'commit',
      },
    ],
    [],
    [],
    [],
  );
  yield* graphStore.promote(layout.databasePath, identity, snapshot.id);
  yield* recordCodeGraphSnapshotAdmission(
    layout,
    snapshot,
    yield* observeCodeGraphAdmissionEnvironment(identity),
    packs,
    false,
  );
  const stored = yield* readNativeWorkflowState(f.config, 'native-run');
  if (!stored) throw new Error('Expected native state');
  const journal = (yield* inspectWorkflowJournal(f.config, initialized.bindingId).pipe(
    Effect.provideService(SystemInfo, scopedSystem),
  )).state;
  const queryContext = yield* Layer.build(Layer.fresh(CodeGraphQueryService.layer)).pipe(
    Effect.provideService(CodeGraphLanguagePackRegistry, packs),
  );
  const query = Context.get(queryContext, CodeGraphQueryService);
  const counts = {opening: 0, closing: 0, leases: 0, releases: 0};
  let drift = false;
  const session = query.withStatusSession;
  if (!session) throw new Error('Expected real status sessions');
  const observedQuery = CodeGraphQueryService.of({
    ...query,
    withStatusSession: (...args) => Effect.sync(() => void counts.opening++).pipe(Effect.andThen(session(...args))),
    status: (...args) =>
      Effect.gen(function* () {
        counts.closing++;
        if (closingFailure === 'expiry') leaseElapsed = 60_000_000_000n;
        if (closingFailure === 'interruption') return yield* Effect.interrupt;
        if (drift) yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = false;\n');
        return yield* query.status(...args);
      }),
  });
  const observedStore = CodeGraphStore.of({
    ...graphStore,
    acquireSnapshotLease: (...args) =>
      graphStore.acquireSnapshotLease(...args).pipe(Effect.tap(() => Effect.sync(() => void counts.leases++))),
    releaseSnapshotLease: (...args) =>
      graphStore.releaseSnapshotLease(...args).pipe(Effect.tap(() => Effect.sync(() => void counts.releases++))),
  });
  const apply = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(
      Effect.provideService(SystemInfo, scopedSystem),
      Effect.provideService(Clock.Clock, fixedClock),
      Effect.provideService(CodeGraphQueryService, observedQuery),
      Effect.provideService(CodeGraphStore, observedStore),
    );
  const request = (key: string, body: string, refs: readonly string[] = []) =>
    workflowWriteRequest({
      operationId: `closeout-${transaction.slice(0, 24)}-${key}`,
      artifactKey: `closeout-${transaction.slice(0, 24)}-${key}`,
      bindingId: journal.binding.bindingId,
      sourceRunId: stored.state.runId,
      role: 'closeout-' + key,
      nameHint: key,
      body,
      expectedRevision: null,
      storageKind: 'durable',
      codeRefs: refs,
    });
  const document = (key: string, body: string) =>
    prepareWorkflowOperation(f.config, journal, request(key, body)).pipe(
      apply,
      Effect.map(
        operation =>
          ({key, body, uri: operation.artifact.canonicalUri, relations: []}) satisfies NativeCloseoutPlannedDocument,
      ),
    );
  return {
    ...f,
    journal,
    state: stored.state,
    counts,
    failClosing: (failure: 'expiry' | 'interruption') => {
      closingFailure = failure;
    },
    apply,
    request,
    document,
    reset: () => {
      for (const key of ['opening', 'closing', 'leases', 'releases'] as const) counts[key] = 0;
    },
    drift: () => {
      drift = true;
    },
    project: (
      documents: readonly NativeCloseoutPlannedDocument[],
      refs: readonly string[] = ['source.ts'],
      original = journal,
      state = stored.state,
    ) => projectNativeCloseoutKnowledge(f.config, state, original, transaction, documents, refs).pipe(apply),
  };
});

it.effect(
  'admits one real capture for D=3, preserves repeated-key relations and admits a following actual write afresh',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.document('first', 'First output.\n');
      const second = {
        ...(yield* f.document('second', 'Second output.\n')),
        relations: [{type: 'references' as const, uri: first.uri}],
      };
      const documents = [
        first,
        second,
        {...first, body: 'Final first output.\n', relations: [{type: 'references' as const, uri: second.uri}]},
      ];
      const nativeBytes = yield* f.fs.readFile(f.statePath());
      const journalBytes = yield* f.fs.readFile(f.journalPath(f.journal.binding.bindingId));
      const projected = yield* f.project(documents);
      expect(Object.keys(projected.journal.operations).length - Object.keys(f.journal.operations).length).toBe(3);
      expect(f.counts).toEqual({opening: 1, closing: 1, leases: 1, releases: 1});
      for (const operation of Object.values(projected.journal.operations))
        expect(
          parseMemoryDocument(operation.artifact.canonicalUri, operation.desired)?.metadata.codeCitations,
        ).toHaveLength(1);
      expect(yield* f.fs.readFile(f.statePath())).toEqual(nativeBytes);
      expect(yield* f.fs.readFile(f.journalPath(f.journal.binding.bindingId))).toEqual(journalBytes);
      yield* f.project(documents);
      expect(f.counts).toEqual({opening: 2, closing: 2, leases: 2, releases: 2});
      yield* f
        .call(
          f.write({
            operationId: 'fresh-after-projection',
            artifactKey: 'fresh',
            role: 'fresh',
            nameHint: 'fresh',
            body: 'Fresh actual output.\n',
            codeRefs: ['source.ts'],
          }),
        )
        .pipe(f.apply);
      expect(f.counts).toEqual({opening: 4, closing: 4, leases: 4, releases: 4});
    }).pipe(provideNative, TestClock.withLive),
);

fcEffectProp(
  it,
  'batched and ordinary projection postimages and byte maxima agree across bounded bodies',
  [fc.integer({min: 1, max: 58_000}), fc.boolean()],
  ([length, unicode]) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.document('first', (unicode ? 'β' : 'x').repeat(unicode ? Math.ceil(length / 2) : length));
      const second = {
        ...(yield* f.document('second', 'Second output.\n')),
        relations: [{type: 'references' as const, uri: first.uri}],
      };
      const documents = [
        first,
        second,
        {...first, body: 'Final output.\n', relations: [{type: 'references' as const, uri: second.uri}]},
      ];
      const batched = yield* f.project(documents);
      expect(f.counts).toEqual({opening: 1, closing: 1, leases: 1, releases: 1});
      f.reset();
      mode.ordinary = true;
      const ordinary = yield* f.project(documents).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            mode.ordinary = false;
          }),
        ),
      );
      expect(f.counts).toEqual({opening: 3, closing: 3, leases: 3, releases: 3});
      expect(batched).toEqual(ordinary);
      expect(batched.maximumJournalBytes).toBeGreaterThan(batched.initialJournalBytes);
    }).pipe(provideNative, TestClock.withLive),
  {fastCheck: {numRuns: 3}},
);

it.effect.each(['expiry', 'interruption'] as const)('fresh reservation discards a projection on closing %s', failure =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const document = yield* f.document('first', 'Complete output.\n');
    const before = yield* f.fs.readFile(f.statePath());
    f.reset();
    f.failClosing(failure);
    const result = yield* reserveNativeCloseoutCapacity(
      f.config,
      'native-run',
      transaction,
      [document],
      ['source.ts'],
      [],
      {requireFreshOutputs: true},
    ).pipe(f.apply, Effect.exit);
    expect(result._tag).toBe('Failure');
    expect(f.counts.leases).toBe(1);
    expect(f.counts.releases).toBe(1);
    expect(yield* f.fs.readFile(f.statePath())).toEqual(before);
    expect(yield* f.fs.exists(f.statePath() + '.closeout.json')).toBe(false);
  }).pipe(provideNative, TestClock.withLive),
);

it.effect('uses zero admissions for empty refs and D=0 and rejects late drift before returning modeled output', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const documents = [yield* f.document('first', 'One output.\n')];
    yield* f.project([], ['source.ts']);
    yield* f.project(documents, []);
    expect(f.counts).toEqual({opening: 0, closing: 0, leases: 0, releases: 0});
    const projected = yield* f.project(documents);
    f.reset();
    yield* f.project(documents, ['source.ts'], projected.journal, projected.native);
    expect(f.counts).toEqual({opening: 0, closing: 0, leases: 0, releases: 0});
    f.drift();
    const failed = yield* f.project(documents).pipe(Effect.flip);
    expect(String(failed)).toContain('changed while code citations');
    expect(f.counts).toEqual({opening: 1, closing: 1, leases: 1, releases: 1});
  }).pipe(provideNative, TestClock.withLive),
);

it.effect('preserves per-document invalid-body and relation failure classifications', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const document = yield* f.document('first', 'One output.\n');
    const invalidBody = yield* f.project([{...document, body: ''}]).pipe(Effect.flip);
    expect(invalidBody).toMatchObject({_tag: 'WorkflowMemoryError', code: 'invalid-body'});
    const missingRelation = yield* f
      .project([
        {
          ...document,
          relations: [
            {type: 'references', uri: 'threadnote://user/tester/memories/durable/projects/fixture/missing.md'},
          ],
        },
      ])
      .pipe(Effect.flip);
    expect(missingRelation).toMatchObject({_tag: 'ResourceNotFound'});
    expect(f.counts.leases).toBe(f.counts.releases);
  }).pipe(provideNative, TestClock.withLive),
);

it.effect('preserves ownership, identity and CAS errors inside the shared fence', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const document = yield* f.document('first', 'Owned output.\n');
    const projection = yield* f.project([document]);
    const operation = Object.values(projection.journal.operations)[0];
    if (!operation) throw new Error('Expected projected operation');
    yield* f.store.write(f.location, operation.artifact.canonicalUri, operation.desired, {mode: 'create'});
    const request = {
      ...operation.request,
      action: 'replace' as const,
      operationId: 'check-cas',
      uri: operation.artifact.canonicalUri,
      expectedRevision: '0'.repeat(64),
      body: 'Replacement.\n',
      bodySha256: sha256HexSync('Replacement.\n'),
    };
    const captured = (journal: typeof f.journal) =>
      withWorkflowProjectionCitations(f.config, journal.binding, ['source.ts'], prepare =>
        prepare(journal, request),
      ).pipe(f.apply, Effect.flip);
    f.reset();
    expect(yield* captured(projection.journal)).toMatchObject({_tag: 'WorkflowMemoryError', code: 'revision-conflict'});
    expect(yield* captured(f.journal)).toMatchObject({_tag: 'WorkflowMemoryError', code: 'out-of-scope'});
    yield* f.store.write(
      f.location,
      operation.artifact.canonicalUri,
      operation.desired.replace(operation.artifact.memoryId, 'tn_changed_identity'),
      {mode: 'replace'},
    );
    expect(yield* captured(projection.journal)).toMatchObject({_tag: 'WorkflowMemoryError', code: 'identity-conflict'});
    expect(f.counts).toEqual({opening: 3, closing: 0, leases: 3, releases: 3});
  }).pipe(provideNative, TestClock.withLive),
);

it.effect('uses ordinary preparation for unsupported refs and revokes a captured preparer on return', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const refs = ['cgr_' + 'f'.repeat(40)];
    const unsupported = yield* withWorkflowProjectionCitations(f.config, f.journal.binding, refs, prepare =>
      prepare(f.journal, f.request('first', '', refs)),
    ).pipe(f.apply, Effect.flip);
    expect(unsupported).toMatchObject({_tag: 'WorkflowMemoryError', code: 'invalid-body'});
    expect(f.counts).toEqual({opening: 0, closing: 0, leases: 0, releases: 0});
    const escaped = yield* withWorkflowProjectionCitations(f.config, f.journal.binding, ['source.ts'], prepare =>
      Effect.succeed(prepare),
    ).pipe(f.apply);
    const failure = yield* escaped(f.journal, f.request('first', 'Unusable authority.\n', ['source.ts'])).pipe(
      f.apply,
      Effect.flip,
    );
    expect(failure).toMatchObject({_tag: 'WorkflowMemoryError', code: 'invalid-request'});
    expect(f.counts).toEqual({opening: 1, closing: 1, leases: 1, releases: 1});
  }).pipe(provideNative, TestClock.withLive),
);

it.effect('preserves saved intent refs before common admission and ignores skipped lower-present vectors', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const document = yield* f.document('first', 'Reserved output.\n');
    const reserved = yield* f.project([document]);
    const saved = reserved.native.operations[0];
    if (!saved) throw new Error('Expected reserved native intent');
    const pending = {
      ...f.state,
      operations: [{status: 'prepared' as const, intent: saved.intent, intentDigest: saved.intentDigest}],
    };
    f.reset();
    mode.ordinary = true;
    const ordinary = yield* f.project([document], ['unresolved-common.ts'], f.journal, pending).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          mode.ordinary = false;
        }),
      ),
    );
    expect(f.counts).toEqual({opening: 1, closing: 1, leases: 1, releases: 1});
    f.reset();
    const optimized = yield* f.project([document], ['unresolved-common.ts'], f.journal, pending);
    expect(optimized).toEqual(ordinary);
    expect(f.counts).toEqual({opening: 1, closing: 1, leases: 1, releases: 1});

    // This differing vector belongs to a skipped lower-present operation. Only
    // the two new operations need the common fence, preserving D=2 -> 1 capture.
    const second = yield* f.document('second', 'Second output.\n');
    const third = yield* f.document('third', 'Third output.\n');
    f.reset();
    const continued = yield* f.project(
      [document, second, third],
      ['source.ts', 'source.ts'],
      reserved.journal,
      reserved.native,
    );
    expect(Object.keys(continued.journal.operations).length - Object.keys(reserved.journal.operations).length).toBe(2);
    expect(f.counts).toEqual({opening: 1, closing: 1, leases: 1, releases: 1});
  }).pipe(provideNative, TestClock.withLive),
);
