import {readLocalMemoryRecordsByUri} from '@threadnote/memory/local-path';
import {readRecallMemoryConnections, retrieveRecallMemoryConnections} from '@threadnote/recall/memory/connections';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {makeReadDeadline, readDeadlineRemaining} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandCleanupUnconfirmed, CommandExecutor, CommandTimedOut} from '@threadnote/platform/command';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {readRecallLexicalDemand, requestRecallLexicalRefresh} from '@threadnote/recall/background/lexical-demand';
import {loadRecallIndexData, readRecallExactMatches, readRecallIndexData} from '@threadnote/recall/index';
import {recallIndexDataResult} from '@threadnote/recall/index/result';
import {
  RecallReadyReadBoundary,
  RecallReadyReadBoundaryError,
  type RecallReadyReadRequest,
} from '@threadnote/recall/read_boundary';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  makeReadyRecallReadBoundary,
  withReadyRecallReadBoundary,
  readyRecallReadRequestBinding,
  readyReadWorkerInvocation,
  ReadyRecallReadWorkerAdmission,
} from '../../src/recall/ready_read_boundary.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {RECALL_READY_READ_WORKER_ARGUMENT} from '../../src/worker_protocol.js';
import {createRecallRerankerCache, prepareRecallSections, warmRecallReranker} from '@threadnote/recall/runtime';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {readMemoryRecordsByUri} from '../../src/memory/index.js';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-owned-ready-read-'});
  const config = {account: 'local', agentContextHome: home, user: 'test'};
  const uri = 'threadnote://user/test/memories/durable/alpha.md';
  const filename = path.join(home, 'data/local/user/test/memories/durable/alpha.md');
  yield* fs.makeDirectory(path.dirname(filename), {recursive: true});
  yield* fs.writeFileString(
    filename,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        timestamp: '2026-11-04T00:00:00.000Z',
        sourceAgentClient: 'test',
        memoryId: 'tn_owned_alpha',
      },
      'Alpha bounded ready recall evidence.',
    ),
  );
  yield* loadRecallIndexData(config, {includeInactive: false});
  return {fs, path, home, config, uri};
});

const waitForPid = Effect.fn('test.waitForReadyReadPid')(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const end = (yield* Clock.currentTimeMillis) + 1500;
  while ((yield* Clock.currentTimeMillis) < end) {
    const value = yield* fs.readFileString(filename).pipe(Effect.orElseSucceed(() => ''));
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    yield* Effect.sleep(10);
  }
  return yield* TestError.make({message: 'Owned read fixture did not report its PID.'});
});

describe('owned native ready-read boundary', () => {
  it('preserves compiled and explicitly injected source worker routing', () => {
    expect(readyReadWorkerInvocation('/runtime/threadnote', '/source/standalone.ts')).toEqual({
      executable: '/runtime/threadnote',
      arguments: [RECALL_READY_READ_WORKER_ARGUMENT],
    });
    fc.assert(
      fc.property(fc.uuid(), token => {
        const entrypoint = `/injected/${token}/worker.ts`;
        expect(readyReadWorkerInvocation('/runtime/bun', entrypoint)).toEqual({
          executable: '/runtime/bun',
          arguments: [entrypoint, RECALL_READY_READ_WORKER_ARGUMENT],
        });
      }),
      {numRuns: 24},
    );
  });
  effectIt.effect.prop(
    'one source worker preserves direct connection proof and excludes a foreign identity for every relation kind',
    {relationType: Schema.Literals(['depends_on', 'evidence_for', 'related_to', 'references'])},
    ({relationType}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-connection-worker-'});
        const f = {fs, path, home, config: {account: 'local', agentContextHome: home, user: 'test'}};
        yield* fs.makeDirectory(path.join(home, 'data/local/user/test/memories/durable'), {recursive: true});
        const seed = formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            status: 'active',
            memoryId: 'tn_owned_alpha',
            timestamp: '2026-11-04T00:00:00.000Z',
            sourceAgentClient: 'test',
            relations: [{type: relationType, uri: 'threadnote://memory/tn_owned_beta'}],
          },
          'Explicit source entrypoint seed.',
        );
        const target = 'threadnote://user/test/memories/durable/beta.md';
        yield* f.fs.writeFileString(f.path.join(f.home, 'data/local/user/test/memories/durable/alpha.md'), seed);
        yield* f.fs.writeFileString(
          f.path.join(f.home, 'data/local/user/test/memories/durable/beta.md'),
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              memoryId: 'tn_owned_beta',
              timestamp: '2026-11-04T00:00:00.000Z',
              sourceAgentClient: 'test',
            },
            'Authorized one-hop neighbor.',
          ),
        );
        const foreign = f.path.join(f.home, 'data/local/user/foreign/memories/durable/beta.md');
        yield* f.fs.makeDirectory(f.path.dirname(foreign), {recursive: true});
        yield* f.fs.writeFileString(
          foreign,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              memoryId: 'tn_owned_beta',
              timestamp: '2026-11-04T00:00:00.000Z',
              sourceAgentClient: 'test',
            },
            'FOREIGN_CONNECTION_PRIVATE_SENTINEL',
          ),
        );
        yield* loadRecallIndexData(f.config, {includeInactive: false});
        yield* loadRecallIndexData(f.config, {includeInactive: true});
        const input = {
          allowedUriScopes: ['threadnote://user/test/memories'],
          memoryRefs: ['threadnote://memory/tn_owned_alpha'],
          relationTypes: [relationType],
          now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-04T12:00:00.000Z')),
        };
        const direct = yield* retrieveRecallMemoryConnections(f.config, {
          ...input,
          readRecords: uris => readLocalMemoryRecordsByUri(f.config, uris),
        });
        const command = yield* CommandExecutor;
        let nativeReads = 0;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.suspend(() => {
              nativeReads++;
              return command.execute(executable, args, options);
            }),
        });
        const deadline = yield* makeReadDeadline(2000);
        const boundary = yield* makeReadyRecallReadBoundary(deadline).pipe(
          Effect.provideService(CommandExecutor, observed),
        );
        const result = yield* readRecallMemoryConnections(f.config, input).pipe(
          Effect.provideService(RecallReadyReadBoundary, boundary),
        );
        expect(result).toEqual(direct);
        expect(result.connections).toContainEqual(
          expect.objectContaining({neighborUri: target, relationType, resolution: 'resolved', currentness: 'current'}),
        );
        expect(JSON.stringify(result)).not.toContain('FOREIGN_CONNECTION_PRIVATE_SENTINEL');
        expect(JSON.stringify(result)).not.toContain('user/foreign');
        expect(nativeReads).toBe(1);
        expect(yield* readDeadlineRemaining(deadline)).toBeGreaterThan(0);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {arbitrary: {runs: 4}},
  );

  effectIt.effect(
    'fresh closing reads reject canonical revocation even when optional reranking cached the old authorized row',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* selectLocalModel(f.home, yield* LocalModelCatalog, 'reranker', 'jina-reranker-v1-turbo-en-f16');
        const store = yield* LocalModelStore;
        const runtime = yield* LocalModelRuntime;
        let warmed = false;
        const program = Effect.gen(function* () {
          const baseline = yield* readRecallIndexData(f.config, {includeInactive: false, query: 'alpha bounded'});
          expect(baseline.candidates[0]?.uri).toBe(f.uri);
          const cache = createRecallRerankerCache();
          yield* warmRecallReranker(f.home, 'alpha bounded', baseline.candidates, cache);
          expect(warmed).toBe(true);
          expect(cache.scores.size).toBeGreaterThan(0);
          const closed = yield* prepareRecallSections(f.config, {
            allowExactRescue: true,
            allowReranker: true,
            exactMatches: [],
            feedbackQuery: 'alpha bounded',
            includeInactive: false,
            limit: 12,
            passes: [],
            query: 'alpha bounded',
            rerankerCache: cache,
            semanticResult: Option.some({
              corpusGeneration: Option.none(),
              scores: Option.none(),
              warning: Option.none(),
            }),
            readRecords: uris =>
              readMemoryRecordsByUri(
                {...f.config, agentId: 'test', manifestPath: f.path.join(f.home, 'unused.json')},
                uris,
              ),
          });
          expect(closed.ranked).toEqual([]);
        });
        yield* withReadyRecallReadBoundary(program, {boundProgram: true}).pipe(
          Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
          Effect.provideService(LocalModelStore, {
            ...store,
            status: (_home, model) =>
              Effect.succeed({
                installed: true,
                bytes: model.size,
                modelId: model.id,
                path: '/unused/model.gguf',
                partialBytes: 0,
                verified: true,
              }),
          }),
          Effect.provideService(LocalModelRuntime, {
            ...runtime,
            rerank: ({documents}) =>
              Effect.gen(function* () {
                warmed = true;
                yield* f.fs
                  .writeFileString(
                    f.path.join(f.home, 'data/local/user/test/memories/durable/alpha.md'),
                    formatMemoryDocument(
                      'MEMORY',
                      {
                        kind: 'durable',
                        status: 'archived',
                        timestamp: '2026-11-04T00:00:00.000Z',
                        sourceAgentClient: 'test',
                        memoryId: 'tn_owned_alpha',
                      },
                      'Revoked during optional inference.',
                    ),
                  )
                  .pipe(Effect.orDie);
                return EffectArray.map(documents, () => 1);
              }),
          }),
        );
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  it('binds equivalent typed requests independently of object insertion order', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 64}), fc.boolean(), (query, includeInactive) => {
        const first: RecallReadyReadRequest = {
          operation: 'data',
          config: {account: 'local', user: 'test', agentContextHome: '/private/fixture'},
          options: {query, includeInactive},
        };
        const second: RecallReadyReadRequest = {
          config: {agentContextHome: '/private/fixture', user: 'test', account: 'local'},
          options: {includeInactive, query},
          operation: 'data',
        };
        expect(readyRecallReadRequestBinding(first)).toBe(readyRecallReadRequestBinding(second));
        expect(readyRecallReadRequestBinding(first)).not.toBe(
          readyRecallReadRequestBinding({...first, options: {...first.options, query: `${query}-changed`}}),
        );
      }),
      {numRuns: 24},
    );
  });
  effectIt.effect(
    'serves exact then ranked reads through real source workers within the one request window',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const commands = yield* CommandExecutor;
        const system = yield* SystemInfo;
        const workerArguments: (readonly string[])[] = [];
        const observed = CommandExecutor.of({
          ...commands,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              workerArguments.push(args);
              expect(executable).toBe(system.executablePath);
              expect(options?.env?.THREADNOTE_HOME).toBe(f.home);
              expect(options?.verifyOwnedProcessExit).toBeDefined();
              return yield* commands.execute(executable, args, options);
            }),
        });
        const started = yield* Clock.monotonicTimeNanos;
        const deadline = yield* makeReadDeadline(2000);
        const boundary = yield* makeReadyRecallReadBoundary(deadline).pipe(
          Effect.provideService(CommandExecutor, observed),
        );
        const exact = yield* boundary.read({
          operation: 'exact',
          config: f.config,
          options: {includeInactive: false, terms: ['Alpha'], uriScopes: [`threadnote://user/test/memories`]},
        });
        expect(exact.outcome).toBe('success');
        expect(exact.value).toEqual([{terms: ['Alpha'], uri: f.uri}]);
        const ranked = yield* boundary.read({
          operation: 'data',
          config: f.config,
          options: {includeInactive: false, query: 'bounded ready recall'},
        });
        expect(ranked.outcome).toBe('success');
        expect(recallIndexDataResult(ranked.value).candidates[0]?.uri).toBe(f.uri);
        const sourceEntry = Bun.fileURLToPath(new URL('../../src/recall/ready_read_entry.ts', import.meta.url));
        expect(workerArguments).toEqual([
          [sourceEntry, RECALL_READY_READ_WORKER_ARGUMENT],
          [sourceEntry, RECALL_READY_READ_WORKER_ARGUMENT],
        ]);
        expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
        expect(yield* readDeadlineRemaining(deadline)).toBeGreaterThan(0);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 15000},
  );

  effectIt.effect(
    'cold actual workers return unavailable without creating the lexical database',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cold-ready-read-'});
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const response = yield* boundary.read({
          operation: 'data',
          config: {account: 'local', agentContextHome: home, user: 'test'},
          options: {includeInactive: false, query: 'alpha'},
        });
        expect(response.outcome).toBe('unavailable');
        expect(response.maintenanceRequested).toBe(true);
        const connections = yield* boundary.read({
          operation: 'memory-connections',
          config: {account: 'local', agentContextHome: home, user: 'test'},
          options: {
            allowedUriScopes: ['threadnote://user/test/memories'],
            memoryRefs: ['threadnote://memory/tn_missing_seed'],
            now: '2026-11-04T12:00:00.000Z',
          },
        });
        expect(connections.outcome).toBe('unavailable');
        expect(connections.maintenanceRequested).toBe(true);
        expect(yield* fs.exists(path.join(home, 'indexes/lexical/active-v13.sqlite'))).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect(
    'actual ordinary runtime admission routes public exact and ranking APIs through the same scope',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const start = yield* Clock.monotonicTimeNanos;
        yield* withReadyRecallReadBoundary(
          Effect.gen(function* () {
            const exact = yield* readRecallExactMatches(f.config, {
              includeInactive: false,
              terms: ['Alpha'],
              uriScopes: ['threadnote://user/test/memories'],
            });
            expect(exact[0]?.uri).toBe(f.uri);
            const ranked = yield* readRecallIndexData(f.config, {includeInactive: false, query: 'bounded alpha'});
            expect(ranked.candidates[0]?.uri).toBe(f.uri);
            expect(ranked.readState?.freshness).toBe('current');
          }),
        ).pipe(Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}));
        expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(2000);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect(
    'does not replace injected services without actual runtime admission',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = yield* CommandExecutor;
        const direct = yield* withReadyRecallReadBoundary(
          readRecallIndexData(f.config, {includeInactive: false, query: 'alpha'}),
        ).pipe(
          Effect.provideService(CommandExecutor, {
            ...command,
            execute: () => Effect.die('Injected command must not run.'),
          }),
        );
        expect(direct.candidates[0]?.uri).toBe(f.uri);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect(
    'reaps a real synchronous SQLite-stalled worker before returning budget exhaustion',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        const script = f.path.join(f.home, 'stalled-read.ts');
        const pidFile = f.path.join(f.home, 'worker.pid');
        yield* f.fs.writeFileString(
          script,
          `import {Database} from 'bun:sqlite';\nBun.write(process.env.READY_READ_TEST_PID_FILE!,String(process.pid)).then(()=>{const db=new Database(':memory:');db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();});\n`,
        );
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            developmentEntrypoint: script,
            environment: () => ({...system.environment(), READY_READ_TEST_PID_FILE: pidFile}),
          }),
        );
        const started = yield* Clock.monotonicTimeNanos;
        const result = yield* boundary
          .read({operation: 'data', config: f.config, options: {includeInactive: false, query: 'alpha'}})
          .pipe(Effect.result);
        const elapsed = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
        const pid = yield* waitForPid(pidFile);
        expect(
          Result.isFailure(result) && Schema.is(RecallReadyReadBoundaryError)(result.failure) && result.failure.reason,
        ).toBe('budget-exhausted');
        expect(elapsed).toBeLessThan(2000);
        expect(system.isProcessRunning(pid)).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect(
    'caller cancellation joins the owned native child instead of leaving a live process',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        const script = f.path.join(f.home, 'cancel-read.ts');
        const pidFile = f.path.join(f.home, 'worker.pid');
        yield* f.fs.writeFileString(
          script,
          `Bun.write(process.env.READY_READ_TEST_PID_FILE!,String(process.pid)).then(()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});\n`,
        );
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            developmentEntrypoint: script,
            environment: () => ({...system.environment(), READY_READ_TEST_PID_FILE: pidFile}),
          }),
        );
        const child = yield* boundary
          .read({operation: 'data', config: f.config, options: {includeInactive: false, query: 'alpha'}})
          .pipe(Effect.forkScoped);
        const pid = yield* waitForPid(pidFile);
        yield* Fiber.interrupt(child);
        expect(system.isProcessRunning(pid)).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect(
    'malformed private output is sanitized and never falls back to parent-native reads',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        const script = f.path.join(f.home, 'malformed-read.ts');
        const sensitive = 'private-query-and-project-sentinel';
        yield* f.fs.writeFileString(script, `process.stdout.write(${JSON.stringify(sensitive)});`);
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(SystemInfo, {...system, developmentEntrypoint: script}),
        );
        const request: RecallReadyReadRequest = {
          operation: 'data',
          config: f.config,
          options: {includeInactive: false, query: sensitive},
        };
        const result = yield* boundary.read(request).pipe(Effect.result);
        expect(
          Result.isFailure(result) && Schema.is(RecallReadyReadBoundaryError)(result.failure) && result.failure.reason,
        ).toBe('invalid-protocol');
        expect(JSON.stringify(result)).not.toContain(sensitive);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect('private protocol failures do not copy output into command error or span diagnostics', () =>
    Effect.gen(function* () {
      const command = yield* CommandExecutor;
      const system = yield* SystemInfo;
      const sensitive = 'private-output-query-sentinel';
      const result = yield* command
        .execute(
          system.executablePath,
          [
            '-e',
            'process.stdout.write(process.env.READY_READ_TEST_PRIVATE);process.stderr.write(process.env.READY_READ_TEST_PRIVATE);process.exit(7)',
          ],
          {env: {...system.environment(), READY_READ_TEST_PRIVATE: sensitive}, sensitiveOutput: true},
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sensitive);
      if (Result.isFailure(result) && result.failure._tag === 'CommandFailed') {
        expect(result.failure.stdout).toBe('');
        expect(result.failure.stderr).toBe('');
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect(
    'deadline cleanup joins the worker and an owned descendant in its process group',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        const script = f.path.join(f.home, 'descendant-read.ts');
        const pidFile = f.path.join(f.home, 'worker.pid');
        const descendantFile = f.path.join(f.home, 'descendant.pid');
        yield* f.fs.writeFileString(
          script,
          `import {writeFileSync} from 'node:fs';const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{detached:false,stdin:'ignore',stdout:'ignore',stderr:'ignore'});writeFileSync(process.env.READY_READ_TEST_DESCENDANT_FILE!,String(child.pid));writeFileSync(process.env.READY_READ_TEST_PID_FILE!,String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`,
        );
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            developmentEntrypoint: script,
            environment: () => ({
              ...system.environment(),
              READY_READ_TEST_PID_FILE: pidFile,
              READY_READ_TEST_DESCENDANT_FILE: descendantFile,
            }),
          }),
        );
        const started = yield* Clock.monotonicTimeNanos;
        const result = yield* boundary
          .read({operation: 'data', config: f.config, options: {includeInactive: false, query: 'alpha'}})
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        const worker = yield* waitForPid(pidFile);
        const descendant = yield* waitForPid(descendantFile);
        expect(system.isProcessRunning(worker)).toBe(false);
        expect(system.isProcessRunning(descendant)).toBe(false);
        expect(Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000).toBeLessThan(2000);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect('unknown owned-group exit refuses otherwise successful command output', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const context = yield* Layer.build(Layer.fresh(CommandExecutor.layer)).pipe(
        Effect.provideService(SystemInfo, {...system, isProcessGroupRunning: () => undefined}),
      );
      const command = Context.get(context, CommandExecutor);
      const result = yield* command
        .execute(system.executablePath, ['-e', 'process.stdout.write("done")'], {verifyOwnedProcessExit: 'group'})
        .pipe(Effect.result);
      expect(Result.isFailure(result) && Schema.is(CommandCleanupUnconfirmed)(result.failure)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect(
    'native ready results apply current canonical eligibility after an unmarked source change',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const filename = f.path.join(f.home, 'data/local/user/test/memories/durable/alpha.md');
        const database = f.path.join(f.home, 'indexes/lexical/active-v13.sqlite');
        const before = yield* f.fs.readFile(database);
        yield* f.fs.writeFileString(
          filename,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              project: 'denied',
              timestamp: '2026-11-04T00:00:00.000Z',
              sourceAgentClient: 'test',
              memoryId: 'tn_owned_alpha',
            },
            'Alpha bounded ready recall evidence.',
          ),
        );
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const response = yield* boundary.read({
          operation: 'data',
          config: f.config,
          options: {
            includeInactive: false,
            query: 'alpha',
            eligibility: {
              kind: 'candidate-policy',
              authority: 'any',
              projects: {mode: 'allow-projects-and-projectless', projects: ['allowed']},
            },
          },
        });
        expect(response.outcome).toBe('success');
        expect(recallIndexDataResult(response.value).candidates).toEqual([]);
        expect(recallIndexDataResult(response.value).readState?.freshness).toBe('stale');
        expect(response.maintenanceRequested).toBe(true);
        expect(yield* f.fs.readFile(database)).toEqual(before);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect('replays the child durable-maintenance wake through the parent capability', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      const requests: readonly RecallReadyReadRequest[] = [
        {operation: 'data', config: f.config, options: {includeInactive: false, query: 'alpha'}},
        {
          operation: 'vector-scores',
          config: f.config,
          options: {
            model: {
              id: 'fixture',
              sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              dimensions: 1,
            },
            state: {chunkCount: 0, generation: 'fixture', authorizationKey: 'fixture'},
          },
        },
      ];
      for (const request of requests) {
        let wakes = 0;
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(RecallEmbeddingWakePort, home =>
            Effect.sync(() => {
              expect(home).toBe(f.home);
              wakes += 1;
            }),
          ),
          Effect.provideService(CommandExecutor, {
            ...command,
            execute: () =>
              Effect.succeed({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                  protocol: 1,
                  operation: request.operation,
                  binding: readyRecallReadRequestBinding(request),
                  outcome: 'unavailable',
                  observations: [],
                  maintenanceRequested: true,
                }),
              }),
          }),
        );
        yield* boundary.read(request);
        expect(wakes).toBe(1);
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('a lost worker response wakes existing durable demand without creating a new revision', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      const scope = {...f.config, includeInactive: false};
      const revision = yield* requestRecallLexicalRefresh(scope);
      let wakes = 0;
      const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes += 1;
          }),
        ),
        Effect.provideService(CommandExecutor, {
          ...command,
          execute: () =>
            Effect.fail(
              CommandTimedOut.make({args: [], executable: '<worker>', message: 'Owned fixture timeout.', timeoutMs: 1}),
            ),
        }),
      );
      yield* boundary
        .read({operation: 'data', config: f.config, options: {includeInactive: false}})
        .pipe(Effect.result);
      expect(wakes).toBe(1);
      expect((yield* readRecallLexicalDemand(scope))?.revision).toBe(revision);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('a lost composite connection response wakes inactive demand without revising or preparing it', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      const scope = {...f.config, includeInactive: true};
      const revision = yield* requestRecallLexicalRefresh(scope);
      let wakes = 0;
      const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes += 1;
          }),
        ),
        Effect.provideService(CommandExecutor, {
          ...command,
          execute: () =>
            Effect.fail(
              CommandTimedOut.make({args: [], executable: '<worker>', message: 'Owned fixture timeout.', timeoutMs: 1}),
            ),
        }),
      );
      yield* boundary
        .read({
          operation: 'memory-connections',
          config: f.config,
          options: {
            allowedUriScopes: ['threadnote://user/test/memories'],
            memoryRefs: ['threadnote://memory/tn_owned_alpha'],
            now: '2026-11-04T12:00:00.000Z',
          },
        })
        .pipe(Effect.result);
      expect(wakes).toBe(1);
      expect((yield* readRecallLexicalDemand(scope))?.revision).toBe(revision);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('caller interruption and unconfirmed cleanup never trigger an additional wake', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      yield* requestRecallLexicalRefresh({...f.config, includeInactive: false});
      const entered = yield* Deferred.make<void>();
      let wakes = 0;
      const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes += 1;
          }),
        ),
        Effect.provideService(CommandExecutor, {
          ...command,
          execute: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const fiber = yield* boundary
        .read({operation: 'data', config: f.config, options: {includeInactive: false}})
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(wakes).toBe(0);
      const unknown = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes += 1;
          }),
        ),
        Effect.provideService(CommandExecutor, {
          ...command,
          execute: () =>
            Effect.fail(
              CommandCleanupUnconfirmed.make({
                args: [],
                executable: '<worker>',
                message: 'Owned cleanup is unconfirmed.',
              }),
            ),
        }),
      );
      const result = yield* unknown
        .read({operation: 'data', config: f.config, options: {includeInactive: false}})
        .pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure.reason).toBe('cleanup-unconfirmed');
      expect(wakes).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});
