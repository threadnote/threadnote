import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Clock, Effect, Fiber, FileSystem, Option, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {
  ensureVectorIndex,
  rebuildVectorIndex,
  vectorIndexDatabaseFilename,
  loadRecallVectorAuthorizationKey,
  recallVectorStorage,
} from '@threadnote/recall/vector-index';
import {deriveRecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {
  recallVectorQueryStateSchema,
  RecallReadyReadBoundaryError,
  type RecallReadyReadRequest,
} from '@threadnote/recall/read_boundary';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {makeReadyRecallReadBoundary} from '../../src/recall/ready_read_boundary.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {advanceCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {
  externalResourceUri,
  renderExternalResource,
  serializeExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {writeSourceConfiguration, sourceConfigurationFingerprint} from '../../src/integrations/config.js';
import {captureConsole} from '../../src/effect/console.js';
import {withProductionLogging, productionLogSupportExcerpt} from '../../src/effect/production_log.js';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import * as SqlClient from 'effect/sql/SqlClient';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';

const manifest = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);
const model = {
  id: manifest.id,
  sha256: manifest.sha256,
  dimensions: manifest.dimensions,
  promptPrefixes: manifest.promptPrefixes,
};
const vector = Array.from({length: manifest.dimensions}, (_, index) => (index === 0 ? 1 : 0));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-vector-'});
  const config = {
    account: 'local',
    user: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const uris: string[] = [];
  const files: string[] = [];
  for (const project of ['alpha', 'beta']) {
    const uri = `threadnote://user/test/memories/durable/projects/${project}/entry.md`;
    const file = path.join(home, `data/local/user/test/memories/durable/projects/${project}/entry.md`);
    yield* fs.makeDirectory(path.dirname(file), {recursive: true});
    yield* fs.writeFileString(
      file,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          project,
          memoryId: `tn_vector_${project}`,
          sourceAgentClient: 'test',
          timestamp: '2026-11-04T00:00:00.000Z',
        },
        `PRIVATE_VECTOR_${project}`,
      ),
    );
    uris.push(uri);
    files.push(file);
  }
  const lexical = yield* loadRecallIndexData(config, {includeInactive: false});
  const installed = {
    installed: true,
    bytes: manifest.size,
    modelId: manifest.id,
    path: path.join(home, 'unused.gguf'),
    partialBytes: 0,
    verified: true,
  };
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fixture', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: ({inputs}) => Effect.succeed(EffectArray.map(inputs, () => vector)),
    generate: () => Effect.die('unexpected'),
    rerank: () => Effect.die('unexpected'),
  });
  const store = LocalModelStore.of({
    install: () => Effect.die('unexpected'),
    remove: () => Effect.succeed(false),
    path: () => installed.path,
    status: () => Effect.succeed(installed),
    verify: () => Effect.succeed(installed),
  });
  yield* ensureVectorIndex(config, manifest, lexical.candidates, {corpusGeneration: lexical.generation}).pipe(
    Effect.provideService(LocalModelRuntime, runtime),
    Effect.provideService(LocalModelStore, store),
  );
  const database = path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
  const scope = deriveRecallEligibilityPolicy({explicitProject: 'alpha', originalQuery: 'private vector'});
  return {fs, path, home, config, uris, files, database, scope, lexical, runtime, store};
});

const installSynchronousScoringStall = (database: string, stall = true) =>
  Effect.sync(() => {
    const db = new Database(database);
    try {
      db.exec('ALTER TABLE vector_values RENAME TO fixture_vector_values');
      db.exec(`CREATE VIEW vector_values AS SELECT id, vector_key, vector FROM fixture_vector_values
      WHERE ${stall ? '(WITH RECURSIVE n(x) AS (VALUES(fixture_native_entered()) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n)>0' : 'fixture_native_entered()=1'}`);
    } finally {
      db.close();
    }
  });

// The SQLite scalar runs inside the actual scoring query before native recursion.
// The shim only installs this fixture function; production worker/layer and SQL stay real.
const observedWorker = (f: Effect.Success<typeof fixture>, promote = false) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const script = f.path.join(f.home, 'observed-vector-worker.ts');
    const entered = f.path.join(f.home, 'native-query-entered.pid');
    const timeoutFile = f.path.join(f.home, 'native-query-timeout.json');
    yield* f.fs.writeFileString(
      script,
      `
import {Database} from 'bun:sqlite';
import {writeFileSync} from 'node:fs';
const original = Database.prototype.query;
const registered = new WeakSet();
let promoted = false;
Database.prototype.query = function(sql) {
  if (!registered.has(this)) {
    this.function('fixture_native_entered', () => { writeFileSync(${JSON.stringify(entered)}, String(process.pid));
      ${
        promote
          ? `if (!promoted) {
        promoted = true;
        const writer = new Database(${JSON.stringify(f.database)});
        try {
          writer.exec('PRAGMA foreign_keys=OFF; BEGIN');
          for (const table of ['vector_generations','vector_chunks','vector_aliases','vector_pointer']) writer.exec("UPDATE "+table+" SET generation=generation||'-abcdef'");
          writer.exec('COMMIT');
        } finally {writer.close();}
      }`
          : ''
      }
      return 1; });
    registered.add(this);
  }
  if (sql.includes('FROM vector_chunks AS chunk') && sql.includes('JOIN vector_values'))
    writeFileSync(${JSON.stringify(timeoutFile)}, JSON.stringify(original.call(this, 'PRAGMA busy_timeout').get()));
  return original.call(this, sql);
};
await import(${JSON.stringify(system.developmentEntrypoint)});
`,
    );
    return {system: {...system, developmentEntrypoint: script}, entered, timeoutFile};
  });

const awaitNativePid = (f: Effect.Success<typeof fixture>, entered: string) =>
  Effect.gen(function* () {
    const end = (yield* Clock.currentTimeMillis) + 700;
    while (!(yield* f.fs.exists(entered))) {
      if ((yield* Clock.currentTimeMillis) >= end)
        return yield* TestError.make({
          message: 'Owned vector worker did not enter synchronous scoring within its request allowance.',
        });
      yield* Effect.sleep(5);
    }
    const pid = Number(yield* f.fs.readFileString(entered));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      return yield* TestError.make({message: 'Owned vector worker supplied an invalid PID.'});
    return pid;
  });

describe('model-free native vector reads', () => {
  effectIt.effect(
    'the closing vector fence rejects promotion performed during the actual SQLite score query',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const reply = yield* boundary.read({operation: 'vector-state', config: f.config, options: {model}});
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(reply.value);
        if (proof.readiness !== 'current') return yield* Effect.die('Missing closing-fence opening proof');
        yield* installSynchronousScoringStall(f.database, false);
        const observed = yield* observedWorker(f, true);
        const scoring = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(SystemInfo, observed.system),
        );
        const result = yield* scoring.read({
          operation: 'vector-scores',
          config: f.config,
          options: {model, state: proof.state, queryVector: vector, eligibility: f.scope},
        });
        expect(result.outcome).toBe('success');
        expect(result.value).toBeUndefined();
        const pid = yield* awaitNativePid(f, observed.entered);
        expect(observed.system.isProcessRunning(pid)).toBe(false);
        expect(JSON.parse(yield* f.fs.readFileString(observed.timeoutFile))).toEqual({timeout: 50});
        const current = yield* scoring.read({operation: 'vector-state', config: f.config, options: {model}});
        const closing = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(current.value);
        expect(closing.readiness).toBe('current');
        if (closing.readiness === 'current') expect(closing.state.generation).not.toBe(proof.state.generation);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 15000},
  );
  effectIt.effect(
    'rejects a replaced vector generation and a newly published lexical corpus',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const reply = yield* boundary.read({operation: 'vector-state', config: f.config, options: {model}});
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(reply.value);
        if (proof.readiness !== 'current') return yield* Effect.die('Missing opening proof');
        yield* Effect.sync(() => {
          const db = new Database(f.database);
          try {
            db.exec('PRAGMA foreign_keys=OFF; BEGIN');
            for (const table of ['vector_generations', 'vector_chunks', 'vector_aliases', 'vector_pointer'])
              db.query(`UPDATE ${table} SET generation = generation || '-abcdef' WHERE generation = ?`).run(
                proof.state.generation,
              );
            db.exec('COMMIT');
          } finally {
            db.close();
          }
        });
        const request: RecallReadyReadRequest = {
          operation: 'vector-scores',
          config: f.config,
          options: {model, state: proof.state, queryVector: vector},
        };
        const staleVector = yield* boundary.read(request);
        expect(staleVector.outcome).toBe('success');
        expect(staleVector.value).toBeUndefined();
        const second = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const reopened = yield* second.read({operation: 'vector-state', config: f.config, options: {model}});
        const current = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(reopened.value);
        if (current.readiness !== 'current') return yield* Effect.die('Missing replacement proof');
        yield* advanceCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
        const published = yield* loadRecallIndexData(f.config, {includeInactive: false, validateNow: true});
        expect(published.generation).not.toBe(current.corpusGeneration);
        // Omission of corpusGeneration must still bind to the opening state's corpus.
        const staleCorpus = yield* second.read({...request, options: {...request.options, state: current.state}});
        expect(staleCorpus.outcome).toBe('failed');
        expect(staleCorpus.value).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 15000},
  );

  effectIt.effect(
    'revokes actual external-source authorization after an opening proof',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const source = {
          type: 'superhuman' as const,
          id: 'fixture-source',
          enabled: true,
          credentialEnv: 'UNUSED_FIXTURE_TOKEN',
          project: 'alpha',
          documents: [{id: 'doc'}],
          includeHidden: false,
          refreshIntervalMinutes: 15,
          maxStaleHours: 24,
        };
        yield* writeSourceConfiguration(f.config, {version: 2, sources: [source], projections: []});
        const metadata = {
          version: 1 as const,
          sourceId: source.id,
          documentId: 'doc',
          pageId: 'page',
          chunkId: 'line',
          project: 'alpha',
          title: 'Private fixture',
          rendererVersion: '1',
          scrubberVersion: '1',
          coverage: 'canvas-plain-text' as const,
        };
        const uri = externalResourceUri(metadata);
        const content = renderExternalResource(metadata, 'PRIVATE_EXTERNAL_VECTOR_CONTENT');
        const document = f.path.join(f.home, 'data/local/resources/external/superhuman/fixture-source/docs/doc');
        yield* f.fs.makeDirectory(f.path.join(document, 'pages/page'), {recursive: true});
        yield* f.fs.writeFileString(f.path.join(document, 'pages/page/line.md'), content);
        yield* f.fs.writeFileString(
          f.path.join(document, '.manifest.json'),
          serializeExternalDocumentManifest({
            version: 1,
            sourceId: source.id,
            documentId: 'doc',
            configFingerprint: sourceConfigurationFingerprint(source),
            status: 'active',
            fetchedAt: yield* Clock.currentTimeMillis,
            maxStaleMilliseconds: 3600000,
            chunks: {[uri]: sha256HexSync(content)},
          }),
        );
        const lexical = yield* loadRecallIndexData(f.config, {includeInactive: false, forceRefresh: true});
        expect(EffectArray.some(lexical.candidates, candidate => candidate.uri === uri)).toBe(true);
        yield* rebuildVectorIndex(f.config, manifest, lexical.candidates, {corpusGeneration: lexical.generation}).pipe(
          Effect.provideService(LocalModelRuntime, f.runtime),
          Effect.provideService(LocalModelStore, f.store),
        );
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const reply = yield* boundary.read({operation: 'vector-state', config: f.config, options: {model}});
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(reply.value);
        if (proof.readiness !== 'current') return yield* Effect.die('Missing authorized opening proof');
        const request: RecallReadyReadRequest = {
          operation: 'vector-scores',
          config: f.config,
          options: {model, state: proof.state, queryVector: vector, allowedUriScopes: [uri]},
        };
        expect((yield* boundary.read(request)).value).toEqual([[uri, 1]]);
        yield* writeSourceConfiguration(f.config, {
          version: 2,
          sources: [{...source, enabled: false}],
          projections: [],
        });
        expect(yield* loadRecallVectorAuthorizationKey(f.config)).not.toBe(proof.state.authorizationKey);
        const revoked = yield* boundary.read(request);
        expect(revoked.outcome).toBe('success');
        expect(revoked.value).toBeUndefined();
        expect(JSON.stringify(revoked)).not.toContain(uri);
        expect(JSON.stringify(revoked)).not.toContain('PRIVATE_EXTERNAL_VECTOR_CONTENT');
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 15000},
  );

  fcEffectProp(
    effectIt,
    'score export is the intersection of independent project and URI scopes',
    [fc.constantFrom('alpha', 'beta'), fc.subarray(['alpha', 'beta'], {minLength: 1})],
    ([project, selected]) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const reply = yield* boundary.read({operation: 'vector-state', config: f.config, options: {model}});
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(reply.value);
        if (proof.readiness !== 'current') return yield* Effect.die('Missing property opening proof');
        const allowedUriScopes = EffectArray.map(
          selected,
          name => `threadnote://user/test/memories/durable/projects/${name}`,
        );
        const result = yield* boundary.read({
          operation: 'vector-scores',
          config: f.config,
          options: {
            model,
            state: proof.state,
            queryVector: vector,
            allowedUriScopes,
            eligibility: deriveRecallEligibilityPolicy({explicitProject: project, originalQuery: 'private vector'}),
          },
        });
        expect(result.outcome).toBe('success');
        expect(result.value).toEqual(
          selected.includes(project)
            ? [[`threadnote://user/test/memories/durable/projects/${project}/entry.md`, 1]]
            : [],
        );
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {numRuns: 8}, timeout: 15000},
  );

  effectIt.effect(
    'malformed private vectors remain redacted in errors and production logs without waking maintenance',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let wakes = 0;
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(RecallEmbeddingWakePort, () =>
            Effect.sync(() => {
              wakes++;
            }),
          ),
        );
        const reply = yield* boundary.read({operation: 'vector-state', config: f.config, options: {model}});
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(reply.value);
        if (proof.readiness !== 'current') return yield* Effect.die('Missing private opening proof');
        yield* f.fs.writeFileString(
          f.path.join(f.home, 'layout.json'),
          JSON.stringify({createdBy: 'threadnote', version: 2}),
        );
        const result = yield* captureConsole(
          withProductionLogging(
            f.home,
            {component: 'mcp', operation: 'recall_context'},
            boundary.read({
              operation: 'vector-scores',
              config: f.config,
              options: {
                model: {...model, promptPrefixes: {query: 'PRIVATE_QUERY_SENTINEL'}},
                state: proof.state,
                queryVector: [Number.NaN, 0.3141592653589793],
                allowedUriScopes: ['threadnote://resources/PRIVATE_SCOPE_SENTINEL'],
              },
            }),
          ),
        ).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        const logs = yield* productionLogSupportExcerpt(f.home, 16000);
        const rendered = JSON.stringify({result, logs});
        for (const secret of [f.home, 'PRIVATE_QUERY_SENTINEL', 'PRIVATE_SCOPE_SENTINEL', '0.3141592653589793'])
          expect(rendered).not.toContain(secret);
        expect(logs.includedEntries).toBeGreaterThan(0);
        expect(wakes).toBe(0);
        expect(yield* f.fs.exists(f.path.join(f.home, 'models'))).toBe(false);
        expect(yield* f.fs.exists(f.path.join(f.home, 'indexes/code-graph'))).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 15000},
  );

  effectIt.effect(
    'readonly vector validation preserves the existing fifty-millisecond SQLite cap',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const timeout = yield* recallVectorStorage.read(
          f.database,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* recallVectorStorage.validate(sql, 50);
            return yield* sql.unsafe('PRAGMA busy_timeout');
          }),
        );
        expect(timeout).toEqual([{timeout: 50}]);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {timeout: 15000},
  );
  effectIt.effect(
    'exports only current canonical eligible URI scores and refuses logical-scope/source changes',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000));
        const opened = yield* boundary.read({operation: 'vector-state', config: f.config, options: {model}});
        expect(opened.outcome).toBe('success');
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(opened.value);
        expect(proof.readiness).toBe('current');
        if (proof.readiness !== 'current') return;
        const request: RecallReadyReadRequest = {
          operation: 'vector-scores',
          config: f.config,
          options: {
            model,
            state: proof.state,
            corpusGeneration: proof.corpusGeneration,
            queryVector: vector,
            eligibility: f.scope,
            allowedUriScopes: ['threadnote://user/test/memories'],
            limit: 12,
          },
        };
        const scores = yield* boundary.read(request);
        expect(scores.outcome).toBe('success');
        expect(scores.value).toEqual([[f.uris[0], 1]]);
        expect(JSON.stringify(scores)).not.toContain('PRIVATE_VECTOR');
        const wrong = yield* (yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000))).read({
          ...request,
          config: {...f.config, user: 'other'},
        });
        expect(wrong.outcome).toBe('failed');
        expect(JSON.stringify(wrong)).not.toContain(f.uris[0]);
        yield* f.fs.writeFileString(
          f.files[0],
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'archived',
              project: 'beta',
              memoryId: 'tn_vector_alpha',
              sourceAgentClient: 'test',
              timestamp: '2026-11-04T00:00:00.000Z',
            },
            'PRIVATE_CHANGED_SOURCE',
          ),
        );
        const changed = yield* (yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000))).read(request);
        expect(changed.outcome).toBe('success');
        expect(changed.value).toEqual([]);
        expect(JSON.stringify(changed)).not.toContain('PRIVATE_CHANGED_SOURCE');
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 15000},
  );

  effectIt.effect(
    'a real vector SQLite stall is reaped inside the original request deadline',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const proofReply = yield* (yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000))).read({
          operation: 'vector-state',
          config: f.config,
          options: {model},
        });
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(proofReply.value);
        if (proof.readiness !== 'current') return yield* Effect.die('Vector opening proof unavailable.');
        yield* installSynchronousScoringStall(f.database);
        const deadline = yield* makeReadDeadline(1800);
        const observed = yield* observedWorker(f);
        const boundary = yield* makeReadyRecallReadBoundary(deadline).pipe(
          Effect.provideService(SystemInfo, observed.system),
        );
        const start = yield* Clock.monotonicTimeNanos;
        const result = yield* boundary
          .read({
            operation: 'vector-scores',
            config: f.config,
            options: {
              model,
              state: proof.state,
              corpusGeneration: proof.corpusGeneration,
              queryVector: vector,
              limit: 12,
            },
          })
          .pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure')
          expect(Schema.is(RecallReadyReadBoundaryError)(result.failure) && result.failure.reason).toBe(
            'budget-exhausted',
          );
        expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(1800);
        const pid = yield* awaitNativePid(f, observed.entered);
        expect(observed.system.isProcessRunning(pid)).toBe(false);
        expect(JSON.parse(yield* f.fs.readFileString(observed.timeoutFile))).toEqual({timeout: 50});
        const later = yield* boundary
          .read({operation: 'generation', config: f.config, options: {includeInactive: false}})
          .pipe(Effect.result);
        expect(later._tag).toBe('Failure');
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );

  effectIt.effect(
    'caller cancellation joins the actual model-free worker stalled inside vector scoring',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const proofReply = yield* (yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000))).read({
          operation: 'vector-state',
          config: f.config,
          options: {model},
        });
        const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(proofReply.value);
        if (proof.readiness !== 'current') return yield* Effect.die('Vector opening proof unavailable.');
        yield* installSynchronousScoringStall(f.database);
        const observed = yield* observedWorker(f);
        const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
          Effect.provideService(SystemInfo, observed.system),
        );
        const child = yield* boundary
          .read({
            operation: 'vector-scores',
            config: f.config,
            options: {
              model,
              state: proof.state,
              corpusGeneration: proof.corpusGeneration,
              queryVector: vector,
              limit: 12,
            },
          })
          .pipe(Effect.forkScoped);
        const pid = yield* awaitNativePid(f, observed.entered);
        yield* Fiber.interrupt(child);
        expect(observed.system.isProcessRunning(pid)).toBe(false);
        expect(JSON.parse(yield* f.fs.readFileString(observed.timeoutFile))).toEqual({timeout: 50});
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 10000},
  );
});
