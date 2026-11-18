import {Array as EffectArray} from 'effect';
import {it} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Fiber, Logger, Result, Schema} from 'effect';
import {expect} from 'vitest';
import {TestClock} from 'effect/testing';
import {
  CurrentResourceRecallInvalidationObserver,
  consumeResourceRecallInvalidationReceipt,
} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';
import {recallIndexDatabaseFilename, recallIndexStatus} from '@threadnote/recall/index';
import {decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {SystemInfo} from '@threadnote/platform/system';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {workflowLocation} from '../../src/workflow_memory/journal.js';
import {buildAuthorizedOwnedMemoryIdProofs, resolveAuthoredMemoryRelations} from '../../src/memory/relations.js';
import {makeWorkflowRecallRefresh} from '../../src/workflow_memory/recall_refresh.js';
import {runWorkflowAutomation} from '../../src/workflow_automation/index.js';
import {CurrentNativeProgress} from './native-authoring-progress-diagnostics.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const config = {
  account: 'local',
  user: 'fixture',
  agentContextHome: '/private/fixture',
  manifestPath: '/private/fixture/manifest.json',
};
const fixture = () => {
  const calls: (readonly string[])[] = [];
  const batching = makeWorkflowRecallRefresh((_config, uris) =>
    Effect.sync(() => {
      calls.push([...uris]);
    }),
  );
  return {...batching, calls};
};

it.effect.prop(
  'flushes the deduplicated URI union exactly once before a request returns',
  {
    writes: Schema.Array(
      Schema.Array(
        Schema.Literals([
          'threadnote://user/fixture/memories/durable/a.md',
          'threadnote://user/fixture/memories/durable/b.md',
          'threadnote://user/fixture/memories/durable/c.md',
        ]),
      ).check(Schema.isMaxLength(8)),
    ).check(Schema.isMaxLength(8)),
  },
  ({writes}) =>
    Effect.gen(function* () {
      const f = fixture();
      const result = yield* f.withBatch(
        config,
        Effect.gen(function* () {
          for (const uris of writes) yield* f.refresh(config, uris);
          expect(f.calls).toHaveLength(0);
          return 'saved';
        }),
      );
      expect(result).toBe('saved');
      const expected = [...new Set(writes.flat())];
      expect(f.calls).toEqual(expected.length ? [expected] : []);
    }),
  {arbitrary: {runs: 30}},
);

it.effect('keeps two requests and nested scopes independent', () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.withBatch(
      config,
      Effect.gen(function* () {
        yield* f.refresh(config, ['outer']);
        yield* f.withBatch(config, f.refresh(config, ['inner']));
        expect(f.calls).toEqual([['inner']]);
        yield* f.refresh(config, ['outer', 'later']);
      }),
    );
    yield* f.withBatch(config, f.refresh(config, ['second']));
    expect(f.calls).toEqual([['inner'], ['outer', 'later'], ['second']]);
  }),
);

it.effect('refreshes direct and mismatched configuration writes immediately', () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.refresh(config, ['direct']);
    yield* f.withBatch(
      config,
      Effect.gen(function* () {
        for (const different of [
          {...config, account: 'other'},
          {...config, user: 'other'},
          {...config, agentContextHome: '/other'},
          {...config, manifestPath: '/other/manifest.json'},
        ])
          yield* f.refresh(different, ['different']);
        expect(f.calls).toHaveLength(5);
        yield* f.refresh({...config}, ['matching']);
        expect(f.calls).toHaveLength(5);
      }),
    );
    expect(f.calls).toHaveLength(6);
    expect(f.calls.at(-1)).toEqual(['matching']);
  }),
);

it.effect('does not let an inherited closed token swallow a later detached write', () =>
  Effect.gen(function* () {
    const f = fixture();
    const gate = yield* Deferred.make<void>();
    const child = yield* f.withBatch(
      config,
      Effect.gen(function* () {
        yield* f.refresh(config, ['before']);
        return yield* Effect.forkDetach(Deferred.await(gate).pipe(Effect.andThen(f.refresh(config, ['after']))));
      }),
    );
    expect(f.calls).toEqual([['before']]);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(child);
    expect(f.calls).toEqual([['before'], ['after']]);
  }),
);

it.effect('flushes durable writes on failure and interruption while retaining the original exit', () =>
  Effect.gen(function* () {
    const f = fixture();
    const failed = yield* f
      .withBatch(config, f.refresh(config, ['failed']).pipe(Effect.andThen(Effect.fail('original'))))
      .pipe(Effect.result);
    expect(failed).toEqual(Result.fail('original'));
    let inherited: Context.Context<never> | undefined;
    const interrupted = yield* f
      .withBatch(
        config,
        Effect.gen(function* () {
          inherited = yield* Effect.context<never>();
          yield* f.refresh(config, ['interrupted']);
          return yield* Effect.interrupt;
        }),
      )
      .pipe(Effect.exit);
    expect(interrupted._tag).toBe('Failure');
    if (interrupted._tag === 'Failure') expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
    if (!inherited) throw new Error('Expected inherited batch context');
    yield* f.refresh(config, ['after-interruption']).pipe(Effect.provide(inherited));
    expect(f.calls).toEqual([['failed'], ['interrupted'], ['after-interruption']]);
  }),
);

it.effect('does not replace the original failure when optional refresh defects', () =>
  Effect.gen(function* () {
    const f = makeWorkflowRecallRefresh(() => Effect.die('optional refresh defect'));
    const result = yield* f
      .withBatch(config, f.refresh(config, ['written']).pipe(Effect.andThen(Effect.fail('original'))))
      .pipe(Effect.result);
    expect(result).toEqual(Result.fail('original'));
  }),
);

it.effect('tracks potential writes without adding work outside an active matching batch', () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.track(config, ['direct-potential']);
    expect(f.calls).toHaveLength(0);
    const failed = yield* f
      .withBatch(
        config,
        Effect.gen(function* () {
          yield* f.track({...config, user: 'other'}, ['unrelated']);
          yield* f.track(config, ['committed-prefix']);
          return yield* Effect.fail('readback-failed');
        }),
      )
      .pipe(Effect.result);
    expect(failed).toEqual(Result.fail('readback-failed'));
    expect(f.calls).toEqual([['committed-prefix']]);
  }),
);

it.effect('allocates fresh state for a reused Effect and concurrent requests', () =>
  Effect.gen(function* () {
    const f = fixture();
    const reused = f.withBatch(config, f.refresh(config, ['reused']));
    yield* reused;
    yield* reused;
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    yield* Effect.all(
      [
        f.withBatch(
          config,
          Effect.gen(function* () {
            yield* f.refresh(config, ['first']);
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(secondEntered);
            yield* f.refresh(config, ['first-tail']);
          }),
        ),
        f.withBatch(
          config,
          Effect.gen(function* () {
            yield* Deferred.await(firstEntered);
            yield* f.refresh(config, ['second']);
            yield* Deferred.succeed(secondEntered, undefined);
          }),
        ),
      ],
      {concurrency: 'unbounded'},
    );
    expect(f.calls.slice(0, 2)).toEqual([['reused'], ['reused']]);
    expect(EffectArray.map(f.calls.slice(2), uris => EffectArray.join(uris, ',')).sort()).toEqual([
      'first,first-tail',
      'second',
    ]);
  }),
);

it.effect('bounds stalled failure cleanup and retains the original failure or interruption', () =>
  Effect.gen(function* () {
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    for (const interrupted of [false, true]) {
      const entered = yield* Deferred.make<void>();
      let attempts = 0;
      const f = makeWorkflowRecallRefresh(() =>
        Effect.gen(function* () {
          attempts++;
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      );
      const child = yield* f
        .withBatch(
          config,
          f.track(config, ['written']).pipe(Effect.andThen(interrupted ? Effect.interrupt : Effect.fail('original'))),
        )
        .pipe(Effect.exit, Effect.provideService(Logger.CurrentLoggers, new Set([logger])), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust('5 seconds');
      const exit = yield* Fiber.join(child);
      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure') {
        if (interrupted) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        else expect(Cause.findError(exit.cause)).toEqual(Result.succeed('original'));
      }
      expect(attempts).toBe(1);
    }
    expect(logs).toEqual(
      new Array(2).fill(
        'Canonical memory was committed, but derived recall indexes could not be refreshed [workflow-cleanup:timeout]. Run threadnote repair.',
      ),
    );
  }),
);

it.effect('does not impose a timeout on normal complete refresh or retry after its interruption', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    const nextEntered = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<void>();
    let attempts = 0;
    const f = makeWorkflowRecallRefresh(() =>
      Effect.gen(function* () {
        attempts++;
        if (attempts === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(complete);
        } else {
          yield* Deferred.succeed(nextEntered, undefined);
          yield* Deferred.await(blocked);
        }
      }),
    );
    const child = yield* f.withBatch(config, f.refresh(config, ['written'])).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust('6 seconds');
    expect(attempts).toBe(1);
    yield* Deferred.succeed(complete, undefined);
    yield* Fiber.join(child);
    expect(attempts).toBe(1);
    const stopped = yield* f.withBatch(config, f.refresh(config, ['next'])).pipe(Effect.forkChild);
    yield* Deferred.await(nextEntered);
    const stopping = yield* Fiber.interrupt(stopped).pipe(Effect.forkChild);
    yield* TestClock.adjust('5 seconds');
    yield* Fiber.join(stopping);
    expect(attempts).toBe(2);
  }),
);

it.effect('only reuses lexical markers after fully covered artifact and manifest verification', () =>
  Effect.gen(function* () {
    for (const variant of [
      'covered',
      'missing-manifest',
      'failed-manifest',
      'missing-verification',
      'outer-failure',
      'custom-store',
      'wrong-scope',
      'repeated-uri',
    ]) {
      const calls: {uris: readonly string[]; covered: boolean}[] = [];
      const location = {home: config.agentContextHome, account: config.account, user: config.user};
      const f = makeWorkflowRecallRefresh((_config, uris, receipt) =>
        Effect.sync(() => {
          calls.push({uris, covered: consumeResourceRecallInvalidationReceipt(receipt, location, uris)});
        }),
      );
      const result = yield* f
        .withBatch(
          config,
          Effect.gen(function* () {
            const observer = yield* CurrentResourceRecallInvalidationObserver;
            for (const [index, uri] of ['artifact', 'manifest'].entries()) {
              yield* f.track(config, [uri]);
              if (variant !== 'custom-store' && !(variant === 'missing-manifest' && uri === 'manifest')) {
                for (const scope of [false, true])
                  observer!.begin(
                    {...location, ...(variant === 'wrong-scope' ? {account: 'other'} : {})},
                    [uri],
                    {previousGeneration: `generation-${index}`, currentGeneration: `generation-${index + 1}`},
                    scope,
                  )(!(variant === 'failed-manifest' && uri === 'manifest' && scope));
              }
              if (!(variant === 'missing-verification' && uri === 'artifact')) yield* f.verified(config, [uri]);
            }
            if (variant === 'repeated-uri') {
              yield* f.track(config, ['artifact']);
              yield* f.verified(config, ['artifact']);
            }
            if (variant === 'outer-failure') return yield* Effect.fail('native-state-commit-failed');
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(variant === 'outer-failure');
      expect(calls).toEqual([{uris: ['artifact', 'manifest'], covered: variant === 'covered'}]);
    }
  }),
);

it.effect('deduplicates aliases within a hook while counting repeated mutations across hooks', () =>
  Effect.gen(function* () {
    const location = {home: config.agentContextHome, account: config.account, user: config.user};
    for (const [calls, transitions] of [
      [1, 1],
      [2, 1],
      [2, 2],
    ]) {
      let covered = false;
      const f = makeWorkflowRecallRefresh((_config, uris, receipt) =>
        Effect.sync(() => {
          expect(uris).toEqual(['root']);
          covered = consumeResourceRecallInvalidationReceipt(receipt, location, uris);
        }),
      );
      yield* f.withBatch(
        config,
        Effect.gen(function* () {
          const observer = yield* CurrentResourceRecallInvalidationObserver;
          for (let index = 0; index < calls; index++) {
            yield* f.track(config, ['root', 'root']);
            if (index < transitions)
              for (const scope of [false, true])
                observer!.begin(
                  location,
                  ['root'],
                  {
                    previousGeneration: `before-${index}`,
                    currentGeneration: `after-${index}`,
                  },
                  scope,
                )(true);
            yield* f.refresh(config, ['root', 'root']);
          }
        }),
      );
      expect(covered).toBe(transitions === calls);
    }
  }),
);

it.effect.prop(
  'cleanup warnings retain the original failure and exclude arbitrary defect payloads',
  {payload: Schema.String},
  ({payload}) =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const logger = Logger.make<unknown, void>(options => {
        logs.push(String(options.message));
      });
      const f = makeWorkflowRecallRefresh(() => Effect.die(payload));
      const result = yield* f
        .withBatch(config, f.track(config, ['committed']).pipe(Effect.andThen(Effect.fail('original'))))
        .pipe(Effect.result, Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
      expect(result).toEqual(Result.fail('original'));
      expect(logs).toEqual([
        'Canonical memory was committed, but derived recall indexes could not be refreshed [workflow-cleanup:failed]. Run threadnote repair.',
      ]);
    }),
  {arbitrary: {runs: 30}},
);

const batchPlanDocument = () =>
  decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'feature',
    project: 'fixture',
    title: 'Batched authoring save plan',
    objective: 'Save multi-artifact authoring state with one end-of-batch lexical refresh.',
    requirements: [{id: 'req-batch', behavior: 'All child and root artifacts persist under one recall refresh batch.'}],
    context: {
      codeRefs: [],
      evidenceRefs: [],
      note: 'Synthetic batch verification fixture.',
    },
    source: null,
    sourceFreeReason: 'This fixture exercises recall refresh batching without Git source capture.',
    current: {
      summary: 'Mid-batch child relation checks previously rebuilt the lexical index per artifact.',
      components: ['Native authoring', 'Workflow memory'],
      contracts: [],
      diagram: 'flowchart TD\n  Child --> Index --> Root',
    },
    target: {
      summary: 'Unshared journal-owned child relations verify live bytes directly and flush recall once.',
      components: ['Native authoring', 'Workflow memory', 'Recall refresh batch'],
      contracts: ['Shared team bindings retain full recall identity admission.'],
      diagram: 'flowchart TD\n  Child --> DirectCheck --> FlushOnce',
    },
    phases: [
      {
        id: 'phase-batch',
        title: 'Batch refresh verification',
        outcome: 'Save completes with one final lexical refresh.',
        dependsOn: [],
        affectedPaths: ['src/authoring.ts'],
        newPaths: [],
        contracts: ['Preserve canonical memory_id aliases on stored relations.'],
        acceptance: [
          {
            id: 'accept-batch',
            criterion: 'No mid-batch prepareDatabase runs on unshared child writes.',
            verification: 'Observe recall.prepareDatabase spans across runNativeAuthoring save.',
            requirementIds: ['req-batch'],
          },
        ],
        safeBoundary: 'Keep configured shares on full recall identity admission.',
      },
    ],
    decisions: [
      {
        id: 'decision-batch',
        question: 'When can workflow relation writes bypass mid-batch lexical rebuilds?',
        selection: 'no-better-alternative',
        selected:
          'Only when no shared team roots or external evidence refs exist and targets are active journal-owned artifacts.',
        alternatives: [],
        rationale: 'Journal lock + live byte verification proves unique active ownership.',
        affectedPhases: ['phase-batch'],
        authority: 'orchestrator',
      },
    ],
    openQuestions: [],
    review: {required: false, reason: 'Synthetic batch test.'},
  });

const traceRecallRefreshes = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const progress = yield* CurrentNativeProgress;
    if (!progress) throw new Error('Expected native progress diagnostics');
    const before = progress.snapshot().totals;
    const beforeRefresh = before['recall.ensureDatabaseFresh']?.started ?? 0;
    const beforeIdentity = before['recall.loadMemoryIdentities']?.started ?? 0;
    const value = yield* effect;
    const after = progress.snapshot().totals;
    return {
      value,
      ensureDatabaseFreshCalls: (after['recall.ensureDatabaseFresh']?.started ?? 0) - beforeRefresh,
      identityAdmissionCalls: (after['recall.loadMemoryIdentities']?.started ?? 0) - beforeIdentity,
    };
  });

it.effect(
  'flushes lexical recall once at batch completion for unshared multi-artifact authoring saves while keeping full recall admission for configured team shares',
  () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const runTracedSave = (f: Effect.Success<ReturnType<typeof nativeFixture>>) =>
        traceRecallRefreshes(
          runWorkflowAutomation(f.config, {
            ...f.base('authoring'),
            command: 'save',
            document: batchPlanDocument(),
            ready: false,
            expectedRevision: null,
          }).pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => f.repo})),
        );

      const unshared = yield* nativeFixture();
      yield* unshared.init();
      const unsharedSave = yield* runTracedSave(unshared);
      expect(unsharedSave.value).toMatchObject({status: 'ok'});
      expect(unsharedSave.identityAdmissionCalls).toBe(0);
      expect(unsharedSave.ensureDatabaseFreshCalls).toBe(1);
      const unsharedStatus = yield* recallIndexStatus(unshared.config, false);
      expect(unsharedStatus.ready).toBe(true);
      expect(unsharedStatus.documentCount).toBeGreaterThanOrEqual(6);

      const shared = yield* nativeFixture();
      yield* shared.fs.makeDirectory(shared.path.join(shared.home, 'share'), {recursive: true});
      yield* shared.fs.writeFileString(
        shared.path.join(shared.home, 'share', 'teams.json'),
        JSON.stringify({
          version: 1,
          teams: {
            engineering: {
              remote: 'https://example.invalid/engineering.git',
              branch: 'main',
            },
          },
        }),
      );
      yield* shared.init();
      const sharedSave = yield* runTracedSave(shared);
      expect(sharedSave.value).toMatchObject({status: 'ok'});
      expect(sharedSave.identityAdmissionCalls).toBeGreaterThan(0);
      expect(sharedSave.ensureDatabaseFreshCalls).toBeGreaterThan(1);
      const sharedStatus = yield* recallIndexStatus(shared.config, false);
      expect(sharedStatus.ready).toBe(true);
    }).pipe(TestClock.withLive, provideNative),
);

const SavedWriteResponseSchema = Schema.Struct({
  artifact: Schema.Struct({
    uri: Schema.String,
    memoryId: Schema.String,
    revision: Schema.String,
  }),
});

it.effect(
  'enforces commit-fence recall admission for shared bindings, memory_id aliases, and relocated URIs targeting active journal-owned artifacts',
  () =>
    Effect.gen(function* () {
      const writeChild = (f: Effect.Success<ReturnType<typeof nativeFixture>>, operationId: string) =>
        f
          .call({
            ...f.base('write'),
            operationId,
            artifactKey: operationId,
            role: 'authoring-child',
            nameHint: operationId,
            expectedRevision: null,
            body: `# ${operationId}\n\nOwned active target.\n`,
            storageKind: 'durable',
          })
          .pipe(Effect.map(value => Schema.decodeUnknownSync(SavedWriteResponseSchema)(value).artifact));

      const withStaleInjectionAtCommitFence = <A, E, R>(
        f: Effect.Success<ReturnType<typeof nativeFixture>>,
        effect: Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const stalePath = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(false)) + '.stale';
          const injectedStore = ResourceStore.of({
            ...store,
            writeChecked: (location, uri, content, options, beforeCommit) =>
              store.writeChecked(
                location,
                uri,
                content,
                options,
                f.fs
                  .writeFileString(stalePath, 'external-commit-fence-stale')
                  .pipe(Effect.orDie, Effect.andThen(beforeCommit ?? Effect.void)),
              ),
          });
          return yield* effect.pipe(
            Effect.provideService(ResourceStore, injectedStore),
            Effect.ensuring(f.fs.remove(stalePath, {force: true}).pipe(Effect.ignore)),
          );
        });

      // 1. Direct canonical URI on unshared binding bypasses commit-fence readCut, whereas shared binding enforces it.
      const unshared = yield* nativeFixture();
      yield* unshared.init();
      const unsharedTarget = yield* writeChild(unshared, 'owned-target');
      const unsharedDirect = yield* withStaleInjectionAtCommitFence(
        unshared,
        unshared
          .call({
            ...unshared.base('write'),
            operationId: 'direct-owned-link',
            artifactKey: 'direct-owned-link',
            role: 'authoring-child',
            nameHint: 'direct-owned-link',
            expectedRevision: null,
            body: '# Direct link\n\nLinks directly to owned URI.\n',
            storageKind: 'durable',
            relations: [{type: 'references', uri: unsharedTarget.uri}],
          })
          .pipe(Effect.result),
      );
      expect(Result.isSuccess(unsharedDirect)).toBe(true);

      const shared = yield* nativeFixture();
      yield* shared.fs.makeDirectory(shared.path.join(shared.home, 'share'), {recursive: true});
      yield* shared.fs.writeFileString(
        shared.path.join(shared.home, 'share', 'teams.json'),
        JSON.stringify({
          version: 1,
          teams: {
            engineering: {
              remote: 'https://example.invalid/engineering.git',
              branch: 'main',
            },
          },
        }),
      );
      yield* shared.init();
      const sharedTarget = yield* writeChild(shared, 'owned-target');
      const sharedFenceFailure = yield* withStaleInjectionAtCommitFence(
        shared,
        shared
          .call({
            ...shared.base('write'),
            operationId: 'shared-owned-link',
            artifactKey: 'shared-owned-link',
            role: 'authoring-child',
            nameHint: 'shared-owned-link',
            expectedRevision: null,
            body: '# Shared link\n\nRequires commit-fence recall admission.\n',
            storageKind: 'durable',
            relations: [{type: 'references', uri: sharedTarget.uri}],
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(sharedFenceFailure)).toBe(true);
      if (Result.isFailure(sharedFenceFailure)) {
        expect(sharedFenceFailure.failure).toMatchObject({code: 'admission-busy'});
      }
      expect(yield* shared.call({...shared.base('recover'), operationId: 'shared-owned-link'})).toMatchObject({
        status: 'ok',
      });

      // 2. Identity alias (threadnote://memory/tn_...) targeting an active journal-owned artifact never takes directOwnedBypass or isDirectlyVerifiedOwned.
      const aliasUri = `threadnote://memory/${unsharedTarget.memoryId}`;
      const targetContent = yield* unshared.store.read(unshared.location, unsharedTarget.uri);
      const ownedActiveArtifacts = {
        [unsharedTarget.uri]: {
          memoryId: unsharedTarget.memoryId,
          revision: unsharedTarget.revision,
          state: 'active' as const,
        },
      };
      const resolveOwnedRelation = (uri: string) =>
        Effect.gen(function* () {
          const allowedUriScopes = [`threadnote://user/${unshared.config.user}/memories`];
          return yield* resolveAuthoredMemoryRelations(unshared.config, [{type: 'references', uri}], {
            allowedUriScopes,
            ownedActiveArtifacts,
            ownedMemoryIdProofs: yield* buildAuthorizedOwnedMemoryIdProofs(
              unshared.config,
              allowedUriScopes,
              ownedActiveArtifacts,
            ),
          });
        });
      const directRelationTrace = yield* traceRecallRefreshes(resolveOwnedRelation(unsharedTarget.uri));
      expect(directRelationTrace.identityAdmissionCalls).toBe(0);

      const aliasRelationTrace = yield* traceRecallRefreshes(resolveOwnedRelation(aliasUri));
      expect(aliasRelationTrace.identityAdmissionCalls).toBeGreaterThan(0);

      const aliasFenceFailure = yield* withStaleInjectionAtCommitFence(
        unshared,
        unshared
          .call({
            ...unshared.base('write'),
            operationId: 'alias-owned-link',
            artifactKey: 'alias-owned-link',
            role: 'authoring-child',
            nameHint: 'alias-owned-link',
            expectedRevision: null,
            body: '# Alias link\n\nUses memory_id alias to owned artifact.\n',
            storageKind: 'durable',
            relations: [{type: 'references', uri: aliasUri}],
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(aliasFenceFailure)).toBe(true);
      if (Result.isFailure(aliasFenceFailure)) {
        expect(aliasFenceFailure.failure).toMatchObject({code: 'admission-busy'});
      }
      expect(yield* unshared.call({...unshared.base('recover'), operationId: 'alias-owned-link'})).toMatchObject({
        status: 'ok',
      });

      // 3. Relocated URI targeting an active journal-owned artifact never takes directOwnedBypass or isDirectlyVerifiedOwned.
      const relocatedFromUri = `threadnote://user/${unshared.config.user}/memories/durable/projects/fixture/relocated-origin.md`;
      const recordedRelocation = yield* recordMemoryRelocation(unshared.config, {
        fromContent: targetContent,
        fromUri: relocatedFromUri,
        toContent: targetContent,
        toUri: unsharedTarget.uri,
      });
      expect(recordedRelocation).toBe(true);

      const relocatedRelationTrace = yield* traceRecallRefreshes(resolveOwnedRelation(relocatedFromUri));
      expect(relocatedRelationTrace.identityAdmissionCalls).toBeGreaterThan(0);

      const relocatedFenceFailure = yield* withStaleInjectionAtCommitFence(
        unshared,
        unshared
          .call({
            ...unshared.base('write'),
            operationId: 'relocated-owned-link',
            artifactKey: 'relocated-owned-link',
            role: 'authoring-child',
            nameHint: 'relocated-owned-link',
            expectedRevision: null,
            body: '# Relocated link\n\nUses relocated URI to owned artifact.\n',
            storageKind: 'durable',
            relations: [{type: 'references', uri: relocatedFromUri}],
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(relocatedFenceFailure)).toBe(true);
      if (Result.isFailure(relocatedFenceFailure)) {
        expect(relocatedFenceFailure.failure).toMatchObject({code: 'admission-busy'});
      }
      expect(yield* unshared.call({...unshared.base('recover'), operationId: 'relocated-owned-link'})).toMatchObject({
        status: 'ok',
      });
    }).pipe(TestClock.withLive, provideNative),
);

it.effect('falls back to recall identity admission when another owned artifact reuses the same live memory id', () =>
  Effect.gen(function* () {
    const writeChild = (f: Effect.Success<ReturnType<typeof nativeFixture>>, operationId: string) =>
      f
        .call({
          ...f.base('write'),
          operationId,
          artifactKey: operationId,
          role: 'authoring-child',
          nameHint: operationId,
          expectedRevision: null,
          body: `# ${operationId}\n\nOwned active target.\n`,
          storageKind: 'durable',
        })
        .pipe(Effect.map(value => Schema.decodeUnknownSync(SavedWriteResponseSchema)(value).artifact));
    const f = yield* nativeFixture();
    yield* f.init();
    const ownerA = yield* writeChild(f, 'collision-owner-a');
    const ownerB = yield* writeChild(f, 'collision-owner-b');
    const store = yield* ResourceStore;
    const location = workflowLocation(f.config);
    const forgedBody = yield* store.read(location, ownerB.uri);
    const forged = parseMemoryDocument(ownerB.uri, forgedBody);
    if (!forged) throw new Error('Expected owned artifact B on disk.');
    yield* store.write(
      location,
      ownerB.uri,
      formatMemoryDocument('MEMORY', {...forged.metadata, memoryId: ownerA.memoryId}, forged.body),
      {mode: 'replace'},
    );
    const forgedRevision = sha256HexSync(yield* store.read(location, ownerB.uri));
    const allowedUriScopes = [ownerA.uri, ownerB.uri];
    const ownedActiveArtifacts = {
      [ownerA.uri]: {memoryId: ownerA.memoryId, revision: ownerA.revision, state: 'active' as const},
      [ownerB.uri]: {memoryId: ownerB.memoryId, revision: forgedRevision, state: 'active' as const},
    };
    const relationFailure = yield* resolveAuthoredMemoryRelations(f.config, [{type: 'references', uri: ownerA.uri}], {
      allowedUriScopes,
      ownedActiveArtifacts,
      ownedMemoryIdProofs: yield* buildAuthorizedOwnedMemoryIdProofs(f.config, allowedUriScopes, ownedActiveArtifacts),
    }).pipe(Effect.flip);
    expect(String(relationFailure)).toContain('identity');
  }).pipe(TestClock.withLive, provideNative),
);
