import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import type {RecallCandidate} from '@threadnote/recall/rank';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Layer, Option, Path, Schedule, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {currentRecallCorpusGeneration, loadRecallIndexData} from '@threadnote/recall/index';
import {loadMcpRecallSemanticScoresResult} from '@threadnote/recall/runtime';
import {
  ensureVectorIndex,
  selectedSemanticScores,
  vectorIndexDatabaseFilename,
  vectorIndexGenerationReadiness,
  vectorIndexStatus,
} from '@threadnote/recall/vector-index';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const manifest = Option.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;
const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'vector-scope-upgrade.test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const modelStore = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die('Unexpected model installation'),
    path: home => `${home}/models/fake.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(installation(home)),
    verify: home => Effect.succeed(installation(home)),
  } satisfies LocalModelStoreShape),
);
const base = Layer.mergeAll(BunServices.layer, systemLayer, LocalModelCatalog.layer([manifest]), modelStore);

function installation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/fake.gguf`,
    verified: true,
  };
}
function database<A>(home: string, use: (database: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(`${home}/indexes/vectors/${manifest.id}/${vectorIndexDatabaseFilename()}`)),
    handle => Effect.sync(() => use(handle)),
    handle => Effect.sync(() => handle.close()),
  );
}
function legacyScopeMapping(home: string) {
  return database(home, handle => {
    const columns = handle.query<{name: string}, []>('PRAGMA table_info(vector_generations)').all();
    if (EffectArray.some(columns, column => column.name === 'scope_mapping_version')) {
      handle.exec('ALTER TABLE vector_generations DROP COLUMN scope_mapping_version');
    }
    handle.query('UPDATE vector_chunks SET project = ?').run('communication-style');
    handle.query('UPDATE vector_generations SET job_id = ?').run(Effect2.pipe('b', EffectString.repeat(64)));
  });
}
function withRuntime<A, E, R>(use: (embedded: string[]) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const embedded: string[] = [];
      const context = yield* Layer.build(
        Layer.succeed(
          LocalModelRuntime,
          LocalModelRuntime.of({
            diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
            embedMany: ({inputs}) =>
              Effect.sync(() => {
                embedded.push(...inputs);
                return EffectArray.map(inputs, () => [1, ...new Array<number>(manifest.dimensions - 1).fill(0)]);
              }),
            generate: () => Effect.die('Unexpected generation'),
            rerank: () => Effect.die('Unexpected reranking'),
          }),
        ),
      );
      return yield* use(embedded).pipe(Effect.provide(context));
    }),
  );
}

describe('vector scope mapping upgrades', () => {
  effectIt.layer(base)(it => {
    it.effect('refreshes a populated legacy generation through MCP with an unchanged lexical corpus', () =>
      withRuntime(embedded =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'vector-scope-upgrade-'});
          const manifestPath = path.join(home, 'seed-manifest.yaml');
          yield* fs.writeFileString(manifestPath, JSON.stringify({version: 1, projects: []}));
          const relative = 'memories/preferences/communication-style/concise.md';
          const preferencePath = path.join(home, 'data/local/user/tester', relative);
          yield* fs.makeDirectory(path.dirname(preferencePath), {recursive: true});
          const content =
            'MEMORY\nkind: preference\nstatus: active\nproject: communication-style\ntopic: concise\nsource_agent_client: test\ntimestamp: 2026-08-01T00:00:00.000Z\n\nUse brief sentences.';
          yield* fs.writeFileString(preferencePath, content);
          const config = {account: 'local', agentContextHome: home, manifestPath, user: 'tester'};
          yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
          const index = yield* loadRecallIndexData(config, {includeInactive: false});
          expect(index.candidates).toHaveLength(1);
          const old = yield* ensureVectorIndex(config, manifest, index.candidates, {
            corpusGeneration: index.generation,
          });
          yield* legacyScopeMapping(home);
          expect(yield* currentRecallCorpusGeneration(config)).toEqual(Option.some(index.generation));
          expect(yield* vectorIndexGenerationReadiness(home, manifest, index.generation)).toBe('stale');
          expect(yield* vectorIndexStatus(home, manifest)).toMatchObject({ready: true, generation: old.generation});
          expect((yield* selectedSemanticScores(config, 'brief sentences'))?.size).toBe(1);
          const beforeRefresh = embedded.length;
          const eligibility = {
            kind: 'candidate-policy' as const,
            authority: 'any' as const,
            projects: {mode: 'allow-projects-and-projectless' as const, projects: ['workspace-project']},
          };
          const first = yield* loadMcpRecallSemanticScoresResult(config, 'brief sentences', 5, eligibility);
          expect(first.status).toBe('unavailable');
          expect(Option.getOrUndefined(first.result.warning)).toContain('refresh');
          yield* Effect.gen(function* () {
            if ((yield* vectorIndexGenerationReadiness(home, manifest, index.generation)) !== 'current') {
              return yield* TestError.make({message: 'Upgrade refresh has not completed'});
            }
          }).pipe(Effect.retry({times: 200, schedule: Schedule.spaced('25 millis')}));
          expect(embedded).toHaveLength(beforeRefresh);
          const next = yield* loadMcpRecallSemanticScoresResult(config, 'brief sentences', 5, eligibility);
          expect(next.status).toBe('available');
          expect(Option.getOrUndefined(next.result.scores)?.size).toBe(1);
          expect(yield* database(home, handle => handle.query('SELECT project FROM vector_chunks').all())).toEqual([
            {project: null},
          ]);
          expect(yield* currentRecallCorpusGeneration(config)).toEqual(Option.some(index.generation));
          expect(yield* fs.readFileString(preferencePath)).toBe(content);
        }),
      ).pipe(TestClock.withLive),
    );

    it.effect('keeps version-zero vectors readable when a mapping upgrade fails before activation', () =>
      withRuntime(embedded =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'vector-scope-upgrade-failure-'});
          const config = {agentContextHome: home};
          const candidates: RecallCandidate[] = [
            {
              kind: 'preference',
              fields: {project: 'communication-style'},
              text: 'Use brief sentences.',
              uri: 'threadnote://resources/repos/fixture/preference.md',
            },
          ];
          yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
          const old = yield* ensureVectorIndex(config, manifest, candidates, {corpusGeneration: 'unchanged'});
          yield* legacyScopeMapping(home);
          const embeddedBeforeUpgrade = embedded.length;
          const failed = yield* ensureVectorIndex(config, manifest, candidates, {
            corpusGeneration: 'unchanged',
            onProgress: progress =>
              progress.phase === 'activating' ? Effect.fail(TestError.make({message: 'paused upgrade'})) : Effect.void,
          }).pipe(Effect.result);
          expect(failed._tag).toBe('Failure');
          expect(embedded).toHaveLength(embeddedBeforeUpgrade);
          expect(
            yield* database(home, handle =>
              handle
                .query('SELECT scope_mapping_version FROM vector_generations WHERE generation = ?')
                .get(old.generation ?? null),
            ),
          ).toEqual({scope_mapping_version: 0});
          expect(yield* vectorIndexGenerationReadiness(home, manifest, 'unchanged')).toBe('stale');
          expect(yield* vectorIndexStatus(home, manifest)).toMatchObject({ready: true, generation: old.generation});
          expect((yield* selectedSemanticScores(config, 'brief sentences'))?.size).toBe(1);
        }),
      ).pipe(TestClock.withLive),
    );

    fcEffectProp(
      it,
      'legacy mapping migration equals a clean build and is idempotent without re-embedding',
      {
        entries: fc.array(
          fc.record({
            preference: fc.boolean(),
            project: fc.constantFrom('communication-style', 'coding-style', 'workflow-style'),
          }),
          {minLength: 1, maxLength: 4},
        ),
      },
      ({entries}) =>
        withRuntime(embedded =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'vector-scope-upgrade-property-'});
            const cleanHome = yield* fs.makeTempDirectoryScoped({prefix: 'vector-scope-clean-property-'});
            const candidates: RecallCandidate[] = EffectArray.map(entries, (entry, index) => ({
              kind: entry.preference ? 'preference' : 'durable',
              fields: {project: entry.project},
              text: `# Entry ${index}\n\nStable source ${index}.`,
              uri: `threadnote://resources/repos/fixture/${index}.md`,
            }));
            const config = {agentContextHome: home};
            yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
            yield* selectLocalModel(cleanHome, yield* LocalModelCatalog, 'embedding', manifest.id);
            const before = yield* ensureVectorIndex(config, manifest, candidates, {
              corpusGeneration: 'unchanged-corpus',
            });
            yield* legacyScopeMapping(home);
            yield* database(home, handle => {
              for (const candidate of candidates)
                handle
                  .query('UPDATE vector_chunks SET project = ? WHERE uri = ?')
                  .run(candidate.fields!.project!, candidate.uri);
            });
            const embeddedBeforeMigration = embedded.length;
            const migrated = yield* ensureVectorIndex(config, manifest, candidates, {
              corpusGeneration: 'unchanged-corpus',
            });
            expect(migrated).toMatchObject({embeddedChunkCount: 0, reusedChunkCount: candidates.length});
            expect(migrated.generation).not.toBe(before.generation);
            const repeated = yield* ensureVectorIndex(config, manifest, candidates, {
              corpusGeneration: 'unchanged-corpus',
            });
            expect(repeated.generation).toBe(migrated.generation);
            expect(embedded).toHaveLength(embeddedBeforeMigration);
            expect(yield* vectorIndexGenerationReadiness(home, manifest, 'unchanged-corpus')).toBe('current');
            const rows = (directory: string) =>
              database(directory, handle =>
                handle
                  .query(
                    'SELECT chunks.uri, chunks.project, hex(value.vector) AS vector FROM vector_chunks AS chunks JOIN vector_values AS value ON value.id = chunks.vector_id ORDER BY chunks.uri',
                  )
                  .all(),
              );
            const actual = yield* rows(home);
            const actualRows = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({project: Schema.NullOr(Schema.String)})),
            )(actual);
            const actualProjects = EffectArray.map(actualRows, row => row.project);
            expect(actualProjects).toEqual(
              EffectArray.map(entries, entry => (entry.preference ? null : entry.project)),
            );
            yield* ensureVectorIndex({agentContextHome: cleanHome}, manifest, candidates, {
              corpusGeneration: 'unchanged-corpus',
            });
            expect(actual).toEqual(yield* rows(cleanHome));
            expect(
              yield* database(home, handle => handle.query('SELECT COUNT(*) AS count FROM vector_generations').get()),
            ).toEqual({count: 1});
          }),
        ).pipe(TestClock.withLive),
      {fastCheck: {numRuns: 12}},
    );
  });
});
