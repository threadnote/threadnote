import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Deferred, Effect, Fiber, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {
  expireRecallIndexValidation,
  loadRecallIndexData,
  readRecallIndexData,
  readRecallIndexDataBatch,
  readRecallExactMatches,
  loadRecallExactMatches,
  recallIndexStatus,
  recallIndexDatabaseFilename,
  readRecallMemoryIdentities,
} from '@threadnote/recall/index';
import {
  requestRecallLexicalRefresh,
  completeRecallLexicalRefresh,
  readRecallLexicalDemand,
  failRecallLexicalRefresh,
  recallLexicalDemandKey,
} from '@threadnote/recall/background/lexical-demand';

import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {indexCandidate} from '@threadnote/recall/index/candidate';
import {buildRecallSections} from '@threadnote/recall/results';
import {advanceCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';

const editDatabase = (filename: string, edit: (db: Database) => void) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Database(filename)),
    db => Effect.sync(() => edit(db)),
    db => Effect.sync(() => db.close()),
  );

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
    ),
  ),
);
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, system);
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- This is the scoped test entry point with one focused platform layer.
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(platform), TestClock.withLive);
const body = (
  project = 'allowed',
  status: 'active' | 'archived' = 'active',
  validity: {memoryId?: string; validFrom?: string; validTo?: string} = {},
) =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      project,
      status,
      sourceAgentClient: 'codex',
      timestamp: '2026-11-01T00:00:00.000Z',
      topic: 'ready-reader',
      ...validity,
    },
    '# Reader alpha\nUseful alpha sentinel evidence.',
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-ready-'});
  const config = {account: 'local', agentContextHome: home, user: 'me'};
  const uri = 'threadnote://user/me/memories/durable/alpha.md';
  const filename = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'alpha.md');
  yield* fs.makeDirectory(path.dirname(filename), {recursive: true});
  yield* fs.writeFileString(filename, body());
  const built = yield* loadRecallIndexData(config, {includeInactive: false});
  return {fs, path, config, uri, filename, generation: built.generation};
});
const eligibility = {
  kind: 'candidate-policy',
  authority: 'any',
  projects: {mode: 'allow-projects-and-projectless', projects: ['allowed']},
} as const;

describe('ready lexical readers', () => {
  effectIt.effect('fills the eligible ranked quota after date exclusion without counting pinned results', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename, uri} = yield* fixture;
      yield* fs.writeFileString(filename, body('allowed', 'active', {validTo: '2020-01-01T00:00:00.000Z'}));
      yield* fs.writeFileString(path.join(path.dirname(filename), 'z-next.md'), body());
      const record = parseMemoryDocument(uri, body())!;
      yield* fs.writeFileString(
        path.join(path.dirname(filename), 'pinned.md'),
        formatMemoryDocument('MEMORY', record.metadata, '# Pinned\nUnrelated beta evidence.'),
      );
      yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      const pinned = 'threadnote://user/me/memories/durable/pinned.md';
      const result = yield* readRecallIndexData(config, {
        includeInactive: false,
        query: 'alpha',
        limit: 1,
        requiredUris: [pinned],
      });
      expect(EffectArray.map(result.candidates, candidate => candidate.uri)).toEqual([
        pinned,
        'threadnote://user/me/memories/durable/z-next.md',
      ]);
      expect(result.readState).toEqual({freshness: 'current', maintenance: 'unneeded'});
      expect(yield* readRecallLexicalDemand({...config, includeInactive: false})).toBeUndefined();
    }).pipe(provide),
  );
  effectIt.effect('reports an exhausted nonexhaustive date-filtered window as incomplete without repair', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename} = yield* fixture;
      yield* fs.remove(filename);
      for (let i = 0; i < 256; i++)
        yield* fs.writeFileString(
          path.join(path.dirname(filename), `a-expired-${i}.md`),
          body('allowed', 'active', {
            memoryId: `tn_expired_${i}`,
            validTo: '2020-01-01T00:00:00.000Z',
          }),
        );
      yield* fs.writeFileString(path.join(path.dirname(filename), 'z-next.md'), body());
      yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha', limit: 1}).pipe(
        Effect.result,
      );
      expect(result._tag).toBe('Failure');
      expect(yield* readRecallLexicalDemand({...config, includeInactive: false})).toBeUndefined();
    }).pipe(provide),
  );
  effectIt.effect('retains each batch selection identity-conflict scope in either order', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename, uri} = yield* fixture;
      const record = parseMemoryDocument(uri, body())!;
      const metadata = {...record.metadata, memoryId: 'tn_conflicted'};
      yield* fs.writeFileString(filename, formatMemoryDocument('MEMORY', metadata, record.body));
      yield* fs.writeFileString(
        path.join(path.dirname(filename), 'different.md'),
        formatMemoryDocument('MEMORY', metadata, '# Beta\nOnly beta evidence.'),
      );
      yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      const broad = {query: 'alpha', allowedUriScopes: ['threadnote://user/me/memories']};
      const narrow = {query: 'alpha', allowedUriScopes: [uri]};
      for (const selections of [
        [broad, narrow],
        [narrow, broad],
      ]) {
        const result = yield* readRecallIndexDataBatch(config, {includeInactive: false, selections});
        for (let i = 0; i < selections.length; i++) {
          expect(result[i].candidates).toHaveLength(1);
          expect(result[i].candidates[0].identityConflict === true).toBe(selections[i] === broad);
        }
      }
    }).pipe(provide),
  );
  effectIt.effect('validates physical alias projections before merging their distinct relation metadata', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename, uri} = yield* fixture;
      const record = parseMemoryDocument(uri, body())!;
      const firstRelation = {type: 'references' as const, uri: 'threadnote://resources/first.md'};
      const secondRelation = {type: 'references' as const, uri: 'threadnote://resources/second.md'};
      const first = formatMemoryDocument(
        'MEMORY',
        {...record.metadata, memoryId: 'tn_alias', relations: [firstRelation]},
        record.body,
      );
      const second = formatMemoryDocument(
        'MEMORY',
        {...record.metadata, memoryId: 'tn_alias', relations: [secondRelation]},
        record.body,
      );
      yield* fs.writeFileString(filename, first);
      const alias = path.join(path.dirname(filename), 'z-alias.md');
      yield* fs.writeFileString(alias, second);
      yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      const options = {allowedUriScopes: ['threadnote://user/me/memories'], memoryIds: ['tn_alias']};
      const identities = yield* readRecallMemoryIdentities(config, options);
      expect(identities).toHaveLength(1);
      expect(identities[0].relations).toEqual([firstRelation, secondRelation]);
      expect(identities[0].equivalentUris).toHaveLength(1);
      expect(yield* readRecallLexicalDemand({...config, includeInactive: false})).toBeUndefined();
      yield* fs.writeFileString(alias, body('forbidden'));
      const changed = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha', eligibility});
      expect(EffectArray.map(changed.candidates, candidate => candidate.uri)).toEqual([uri]);
      expect(changed.candidates[0].relations).toEqual([firstRelation]);
      expect(changed.candidates[0].equivalentUris).toBeUndefined();
    }).pipe(provide),
  );
  fcEffectProp(
    effectIt,
    'time alone changes query eligibility without invalidating identity or scheduling maintenance',
    {offset: fc.integer({min: 1, max: 60_000})},
    ({offset}) =>
      Effect.gen(function* () {
        const {fs, config, filename, uri} = yield* fixture;
        const boundary = Date.parse('2026-11-03T12:00:00.000Z');
        yield* TestClock.setTime(boundary - offset);
        yield* fs.writeFileString(
          filename,
          body('allowed', 'active', {memoryId: 'tn_history', validTo: '2026-11-03T12:00:00.000Z'}),
        );
        yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
        const query = {includeInactive: false, query: 'alpha'};
        expect((yield* readRecallIndexData(config, query)).candidates).toHaveLength(1);
        yield* TestClock.setTime(boundary + offset);
        const expired = yield* readRecallIndexData(config, query);
        expect(expired.candidates).toEqual([]);
        expect(expired.readState).toEqual({freshness: 'current', maintenance: 'unneeded'});
        expect(
          yield* readRecallExactMatches(config, {
            includeInactive: false,
            terms: ['alpha'],
            uriScopes: ['threadnote://user/me/memories'],
          }),
        ).toEqual([]);
        const identities = yield* readRecallMemoryIdentities(config, {
          allowedUriScopes: ['threadnote://user/me/memories'],
          memoryIds: ['tn_history'],
        });
        expect(EffectArray.map(identities, candidate => candidate.uri)).toEqual([uri]);
        expect(yield* readRecallLexicalDemand({...config, includeInactive: false})).toBeUndefined();
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Deterministic clock boundary test with the focused platform layer.
      }).pipe(Effect.provide(platform)),
    {fastCheck: {numRuns: 4}},
  );
  effectIt.effect('does not request maintenance for unchanged future validity or caller policy exclusions', () =>
    Effect.gen(function* () {
      const {fs, config, filename} = yield* fixture;
      yield* fs.writeFileString(filename, body('allowed', 'active', {validFrom: '2999-01-01T00:00:00.000Z'}));
      yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'});
      expect(result.candidates).toEqual([]);
      expect(result.readState).toEqual({freshness: 'current', maintenance: 'unneeded'});
      expect(
        (yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha', project: 'other'})).candidates,
      ).toEqual([]);
      expect(yield* readRecallLexicalDemand({...config, includeInactive: false})).toBeUndefined();
    }).pipe(provide),
  );
  for (const [name, metadata] of [
    ['kind', {kind: 'handoff'}],
    ['timestamp', {timestamp: '2026-10-01T00:00:00.000Z'}],
    ['relations', {relations: [{type: 'references', uri: 'threadnote://resources/other.md'}]}],
    ['validTo', {validTo: '2020-01-01T00:00:00.000Z'}],
  ] as const)
    effectIt.effect(`queues reconciliation before eligibility for changed ${name}`, () =>
      Effect.gen(function* () {
        const {fs, config, filename, uri} = yield* fixture;
        const current = parseMemoryDocument(uri, body())!;
        yield* fs.writeFileString(
          filename,
          formatMemoryDocument('MEMORY', {...current.metadata, ...metadata}, current.body),
        );
        const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'});
        expect(result.candidates).toEqual([]);
        expect(result.readState).toEqual({freshness: 'stale', maintenance: 'queued'});
        expect((yield* readRecallLexicalDemand({...config, includeInactive: false}))?.reconcile).toBe(true);
      }).pipe(provide),
    );
  effectIt.effect('enqueues once with the strongest reason when a stale marker and source drift coexist', () =>
    Effect.gen(function* () {
      const {fs, config, filename, uri} = yield* fixture;
      yield* expireRecallIndexValidation(config.agentContextHome, false, [uri]);
      yield* fs.writeFileString(filename, body('changed'));
      let wakes = 0;
      yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'}).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes++;
          }),
        ),
      );
      expect(wakes).toBe(1);
      expect((yield* readRecallLexicalDemand({...config, includeInactive: false}))?.reconcile).toBe(true);
    }).pipe(provide),
  );
  effectIt.effect('does not schedule maintenance when selected hydration is interrupted', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename} = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const blocked = {
        ...fs,
        realPath: (target: string) =>
          path.basename(target) === path.basename(filename)
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : fs.realPath(target),
      };
      const reader = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'}).pipe(
        Effect.provideService(FileSystem.FileSystem, blocked),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(reader);
      expect(yield* readRecallLexicalDemand({...config, includeInactive: false})).toBeUndefined();
    }).pipe(provide),
  );
  effectIt.effect('does not retry maintenance after a later read-state callback failure', () =>
    Effect.gen(function* () {
      const {config, uri} = yield* fixture;
      yield* expireRecallIndexValidation(config.agentContextHome, false, [uri]);
      let wakes = 0;
      const result = yield* readRecallIndexData(config, {
        includeInactive: false,
        query: 'alpha',
        onReadState: () => {
          throw new Error('callback failure');
        },
      }).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes++;
          }),
        ),
        Effect.result,
      );
      expect(result._tag).toBe('Failure');
      expect(wakes).toBe(1);
    }).pipe(provide),
  );
  for (const stale of [false, true])
    effectIt.effect(
      `attempts ${stale ? 'one ordinary refresh' : 'no maintenance'} on exact work-window exhaustion`,
      () =>
        Effect.gen(function* () {
          const {fs, path, config, uri} = yield* fixture;
          if (stale) yield* expireRecallIndexValidation(config.agentContextHome, false, [uri]);
          const entered = yield* Deferred.make<string>();
          let attempts = 0;
          const delayed = {
            ...fs,
            rename: (source: string, destination: string) =>
              path.basename(path.dirname(source)) === 'lexical-demand-v1' && EffectString.endsWith('.tmp')(source)
                ? Effect.gen(function* () {
                    attempts++;
                    yield* Deferred.succeed(entered, yield* fs.readFileString(source));
                    return yield* Effect.never;
                  })
                : fs.rename(source, destination),
          };
          const terms = Array.from({length: 4_097}, (_, i) => `absent${i}`);
          const reader = yield* readRecallExactMatches(config, {
            includeInactive: false,
            terms,
            uriScopes: ['threadnote://user/me/memories'],
          }).pipe(Effect.provideService(FileSystem.FileSystem, delayed), Effect.result, Effect.forkScoped);
          if (stale) {
            expect(JSON.parse(yield* Deferred.await(entered))).toMatchObject({version: 2, reconcile: false});
            yield* TestClock.adjust('101 millis');
          }
          const result = yield* Fiber.join(reader);
          expect(result._tag).toBe('Failure');
          expect(attempts).toBe(stale ? 1 : 0);
          expect(yield* readRecallLexicalDemand({...config, includeInactive: false})).toBeUndefined();
          if (stale)
            expect(yield* fs.readDirectory(path.join(config.agentContextHome, 'recall', 'lexical-demand-v1'))).toEqual(
              [],
            );
          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The controlled admission timeout uses the test clock with a focused platform layer.
        }).pipe(Effect.provide(platform)),
    );
  effectIt.effect('retains binary SQL order for an exact limit before sorting the returned union', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename} = yield* fixture;
      for (const name of ['Z.md', 'a.md'])
        yield* fs.writeFileString(
          path.join(path.dirname(filename), name),
          EffectString.replace('Useful alpha sentinel evidence.', 'orderneedle source')(body()),
        );
      yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true, memoryIds: []});
      const options = {
        includeInactive: false,
        terms: [' orderneedle '],
        uriScopes: ['threadnote://user/me/memories'],
        limitPerTerm: 1,
      };
      const expected = yield* loadRecallExactMatches(config, options);
      expect(EffectArray.map(expected, match => match.uri)).toEqual(['threadnote://user/me/memories/durable/Z.md']);
      expect(yield* readRecallExactMatches(config, options)).toEqual(expected);
    }).pipe(provide),
  );
  effectIt.effect('bounds concurrent canonical checks and preserves deterministic candidate order', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename} = yield* fixture;
      for (let i = 0; i < 24; i++)
        yield* fs.writeFileString(
          path.join(path.dirname(filename), `parallel-${i}.md`),
          EffectString.replace('Useful alpha sentinel evidence.', `parallelcheck source ${i}`)(body()),
        );
      const options = {includeInactive: false, query: 'parallelcheck', limit: 64};
      const expected = yield* loadRecallIndexData(config, {...options, forceRefresh: true});
      expect(expected.candidates).toHaveLength(24);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const reads = new Map<string, number>();
      const tracedFs = {
        ...fs,
        realPath: (target: string) =>
          !EffectString.startsWith('parallel-')(path.basename(target))
            ? fs.realPath(target)
            : Effect.acquireUseRelease(
                Effect.sync(() => {
                  active++;
                  maximum = Math.max(maximum, active);
                  reads.set(target, (reads.get(target) ?? 0) + 1);
                  return active;
                }),
                count =>
                  (count === 8 ? Deferred.succeed(entered, undefined) : Effect.void).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(fs.realPath(target)),
                  ),
                () =>
                  Effect.sync(() => {
                    active--;
                  }),
              ),
      };
      const reader = yield* readRecallIndexDataBatch(config, {
        includeInactive: false,
        selections: [
          {query: 'parallelcheck', limit: 64},
          {query: 'parallelcheck', limit: 64},
        ],
      }).pipe(Effect.provideService(FileSystem.FileSystem, tracedFs), Effect.forkScoped);
      yield* Deferred.await(entered).pipe(Effect.timeout('2 seconds'));
      expect(maximum).toBe(8);
      yield* Deferred.succeed(release, undefined);
      const actual = yield* Fiber.join(reader);
      for (const selection of actual)
        expect(EffectArray.map(selection.candidates, candidate => candidate.uri)).toEqual(
          EffectArray.map(expected.candidates, candidate => candidate.uri),
        );
      expect(actual).toHaveLength(2);
      expect(maximum).toBe(8);
      expect(reads.size).toBe(24);
      expect([...reads.values()]).toEqual(Array.from({length: 24}, () => 1));
    }).pipe(provide),
  );
  effectIt.effect('rejects an unsupported ready schema without modifying the database', () =>
    Effect.gen(function* () {
      const {fs, path, config} = yield* fixture;
      const filename = path.join(config.agentContextHome, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
      yield* editDatabase(filename, db => {
        db.exec("UPDATE metadata SET value = '999' WHERE key = 'schema_version'");
      });
      const before = yield* fs.readFile(filename);
      expect((yield* readRecallIndexData(config, {includeInactive: false}).pipe(Effect.result))._tag).toBe('Failure');
      expect(yield* fs.readFile(filename)).toEqual(before);
    }).pipe(provide),
  );
  effectIt.effect('pins one complete database when the active pointer changes during resolution', () =>
    Effect.gen(function* () {
      const {fs, path, config, uri, generation} = yield* fixture;
      const root = yield* fs.realPath(path.join(config.agentContextHome, 'indexes', 'lexical'));
      const filename = recallIndexDatabaseFilename(false);
      yield* fs.makeDirectory(path.join(root, 'generations'), {recursive: true});
      yield* fs.copyFile(path.join(root, filename), path.join(root, 'generations', 'first.sqlite'));
      yield* fs.copyFile(path.join(root, filename), path.join(root, 'generations', 'second.sqlite'));
      yield* editDatabase(path.join(root, 'generations', 'first.sqlite'), db => {
        db.exec('PRAGMA journal_mode = DELETE');
      });
      const laterGeneration = 'pointer-race-next';
      yield* editDatabase(path.join(root, 'generations', 'second.sqlite'), db => {
        db.query(
          "UPDATE metadata SET value = ? WHERE key IN ('content_generation', 'logical_scope_content_generation', 'memory_identity_conflict_generation')",
        ).run(laterGeneration);
        db.exec('PRAGMA journal_mode = DELETE');
      });
      const pointer = path.join(root, EffectString.replace(/\.sqlite$/, '.pointer.json')(filename));
      const first = JSON.stringify({version: 1, database: 'generations/first.sqlite'});
      const second = JSON.stringify({version: 1, database: 'generations/second.sqlite'});
      yield* fs.writeFileString(pointer, first);
      let swapped = false;
      const racingFs = {
        ...fs,
        readFileString: (name: string, encoding?: string) =>
          fs.readFileString(name, encoding).pipe(
            Effect.tap(() => {
              if (name !== pointer || swapped) return Effect.void;
              swapped = true;
              return fs.writeFileString(pointer, second);
            }),
          ),
      };
      const before = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'}).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFs),
      );
      expect(swapped).toBe(true);
      expect(before.generation).toBe(generation);
      expect(EffectArray.map(before.candidates, candidate => candidate.uri)).toEqual([uri]);
      const after = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'});
      expect(after.generation).toBe(laterGeneration);
      expect(EffectArray.map(after.candidates, candidate => candidate.uri)).toEqual([uri]);
    }).pipe(provide),
  );
  effectIt.effect('reports unavailable admission promptly while another producer holds demand metadata', () =>
    Effect.gen(function* () {
      const {fs, path, config, uri} = yield* fixture;
      const scope = {...config, includeInactive: false};
      yield* requestRecallLexicalRefresh(scope);
      yield* expireRecallIndexValidation(config.agentContextHome, false, [uri]);
      const lock = path.join(
        config.agentContextHome,
        'recall',
        'lexical-demand-v1',
        recallLexicalDemandKey(scope) + '.lock',
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* withExclusiveFileLock(
        fs,
        lock,
        {
          retryIntervalMilliseconds: 5,
          staleAfterMilliseconds: 5000,
          waitTimeoutMilliseconds: 1000,
          useCanonicalProcessStartIdentity: true,
        },
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const started = performance.now();
      const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'});
      expect(result.readState).toEqual({freshness: 'stale', maintenance: 'unavailable'});
      expect(EffectArray.map(result.candidates, candidate => candidate.uri)).toEqual([uri]);
      expect(performance.now() - started).toBeLessThan(500);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
    }).pipe(provide),
  );
  effectIt.effect('serves the last snapshot without consuming a stale marker or changing its database', () =>
    Effect.gen(function* () {
      const {fs, path, config, uri, generation} = yield* fixture;
      yield* expireRecallIndexValidation(config.agentContextHome, false, [uri]);
      const filename = path.join(config.agentContextHome, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
      const before = yield* fs.readFile(filename);
      const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha', eligibility});
      expect(EffectArray.map(result.candidates, candidate => candidate.uri)).toEqual([uri]);
      expect(result.generation).toBe(generation);
      expect(result.readState).toEqual({freshness: 'stale', maintenance: 'queued'});
      expect(yield* fs.readFile(filename)).toEqual(before);
      expect((yield* recallIndexStatus(config, false)).ready).toBe(false);
      expect((yield* readRecallLexicalDemand({...config, includeInactive: false}))?.revision).toBeDefined();
    }).pipe(provide),
  );
  for (const change of ['delete', 'archive', 'project'] as const)
    effectIt.effect(`rejects live ${change} changes in ranking and exact lookup before maintenance`, () =>
      Effect.gen(function* () {
        const {fs, config, filename} = yield* fixture;
        if (change === 'delete') yield* fs.remove(filename);
        else
          yield* fs.writeFileString(
            filename,
            body(change === 'project' ? 'forbidden' : 'allowed', change === 'archive' ? 'archived' : 'active'),
          );
        const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha', eligibility});
        expect(result.candidates).toEqual([]);
        const exact = yield* readRecallExactMatches(config, {
          includeInactive: false,
          terms: ['alpha'],
          uriScopes: ['threadnote://user/me/memories'],
          eligibility,
        });
        expect(exact).toEqual([]);
      }).pipe(provide),
    );
  fcEffectProp(
    effectIt,
    'never returns ineligible content during finite canonical mutation orders before publication',
    {actions: fc.array(fc.constantFrom('allowed', 'forbidden', 'archived', 'deleted'), {minLength: 1, maxLength: 4})},
    ({actions}) =>
      Effect.gen(function* () {
        const {fs, config, filename, uri} = yield* fixture;
        for (const action of actions) {
          if (action === 'deleted') yield* fs.remove(filename, {force: true});
          else
            yield* fs.writeFileString(
              filename,
              body(action === 'forbidden' ? 'forbidden' : 'allowed', action === 'archived' ? 'archived' : 'active'),
            );
          const ranked = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha', eligibility});
          const exact = yield* readRecallExactMatches(config, {
            includeInactive: false,
            terms: ['alpha'],
            uriScopes: ['threadnote://user/me/memories'],
            eligibility,
          });
          // This model observes each command before any derived publication.
          const expected = action === 'allowed' ? [uri] : [];
          expect(EffectArray.map(ranked.candidates, candidate => candidate.uri)).toEqual(expected);
          expect(EffectArray.map(exact, match => match.uri)).toEqual(expected);
        }
      }).pipe(provide),
    {fastCheck: {numRuns: 8}},
  );
  for (const corrupt of [false, true])
    effectIt.effect(`returns unavailable for ${corrupt ? 'corrupt' : 'cold'} storage without building a database`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-cold-'});
        const config = {account: 'local', agentContextHome: home, user: 'me'};
        const filename = path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
        if (corrupt) {
          yield* fs.makeDirectory(path.dirname(filename), {recursive: true});
          yield* fs.writeFileString(filename, 'corrupt');
        }
        const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha'}).pipe(Effect.exit);
        expect(result._tag).toBe('Failure');
        if (corrupt) expect(yield* fs.readFileString(filename)).toBe('corrupt');
        else expect(yield* fs.exists(filename)).toBe(false);
        expect((yield* readRecallLexicalDemand({...config, includeInactive: false}))?.revision).toBeDefined();
      }).pipe(provide),
    );
  effectIt.effect('revalidates every equivalent alias independently', () =>
    Effect.gen(function* () {
      const {fs, path, config, filename, uri} = yield* fixture;
      const alias = path.join(path.dirname(filename), 'z-alias.md');
      yield* fs.writeFileString(alias, body());
      yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      yield* fs.writeFileString(alias, body('forbidden'));
      const result = yield* readRecallIndexData(config, {includeInactive: false, query: 'alpha', eligibility});
      expect(
        EffectArray.flatMap(result.candidates, candidate => [candidate.uri, ...(candidate.equivalentUris ?? [])]),
      ).toEqual([uri]);
    }).pipe(provide),
  );
  effectIt.effect('does not treat a stale identity snapshot as a proved absence', () =>
    Effect.gen(function* () {
      const {config, uri} = yield* fixture;
      yield* expireRecallIndexValidation(config.agentContextHome, false, [uri]);
      const result = yield* readRecallMemoryIdentities(config, {
        allowedUriScopes: ['threadnote://user/me/memories'],
        memoryIds: ['tn_unknown'],
      }).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
    }).pipe(provide),
  );
  effectIt.effect('reports a different account snapshot unavailable and explicitly repairs its logical binding', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      const other = {...config, user: 'another'};
      expect((yield* readRecallIndexData(other, {includeInactive: false}).pipe(Effect.result))._tag).toBe('Failure');
      yield* loadRecallIndexData(other, {includeInactive: false});
      expect((yield* recallIndexStatus(other, false)).ready).toBe(true);
      expect((yield* readRecallIndexData(config, {includeInactive: false}).pipe(Effect.result))._tag).toBe('Failure');
    }).pipe(provide),
  );
  effectIt.effect('preserves the content generation when logical scopes contain identical resources', () =>
    Effect.gen(function* () {
      const {fs, path, config} = yield* fixture;
      yield* fs.remove(path.join(config.agentContextHome, 'data/local/user'), {recursive: true});
      yield* fs.makeDirectory(path.join(config.agentContextHome, 'data/local/resources'), {recursive: true});
      yield* fs.writeFileString(path.join(config.agentContextHome, 'data/local/resources/a.md'), 'same alpha source');
      const initial = yield* loadRecallIndexData(config, {includeInactive: false, forceRefresh: true});
      for (const user of ['other', 'me', 'other', 'me']) {
        const result = yield* loadRecallIndexData({...config, user}, {includeInactive: false});
        expect(result.generation).toBe(initial.generation);
      }
    }).pipe(provide),
  );
  effectIt.effect(
    'reports exhausted retries unavailable and permits bounded progress for a new canonical generation',
    () =>
      Effect.gen(function* () {
        const {fs, path, config} = yield* fixture;
        const scope = {...config, includeInactive: false};
        const revision = yield* requestRecallLexicalRefresh(scope);
        for (let i = 0; i < 8; i++) yield* failRecallLexicalRefresh(scope, revision);
        expect((yield* requestRecallLexicalRefresh(scope).pipe(Effect.result))._tag).toBe('Failure');
        yield* advanceCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
        yield* requestRecallLexicalRefresh(scope);
        expect((yield* readRecallLexicalDemand(scope))?.failures).toBe(0);
      }).pipe(provide),
  );
  for (const change of ['project', 'archive'] as const)
    it(`reapplies hydrated ${change} metadata to index-only ranking candidates`, () => {
      const uri = 'threadnote://user/me/memories/durable/alpha.md';
      const indexed = indexCandidate(uri, body(), false);
      const live = parseMemoryDocument(
        uri,
        body(change === 'project' ? 'forbidden' : 'allowed', change === 'archive' ? 'archived' : 'active'),
      )!;
      const result = buildRecallSections([], [], 12, {
        query: 'alpha',
        now: new Date('2026-11-03'),
        includeInactive: false,
        minimumScore: 0,
        eligibility,
        indexedCandidates: [indexed],
        records: [live],
      });
      expect(result.ranked).toEqual([]);
    });
  effectIt.effect('does not wake completed sync work during its coalescing interval', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      const scope = {...config, includeInactive: false, work: {kind: 'synchronize' as const, sources: false}};
      let wakes = 0;
      const enqueue = requestRecallLexicalRefresh(scope).pipe(
        Effect.provideService(RecallEmbeddingWakePort, () =>
          Effect.sync(() => {
            wakes++;
          }),
        ),
      );
      const revision = yield* enqueue;
      expect(wakes).toBe(1);
      yield* completeRecallLexicalRefresh(scope, revision);
      expect(yield* enqueue).toBe('current');
      expect(yield* enqueue).toBe('current');
      expect(wakes).toBe(1);
    }).pipe(provide),
  );
  fcEffectProp(
    effectIt,
    'coalesces arbitrary anchor hints by route while preserving the latest desired event',
    {
      count: fc.integer({min: 1, max: 8}),
    },
    ({count}) =>
      Effect.gen(function* () {
        const {config} = yield* fixture;
        const scope = {
          ...config,
          includeInactive: false,
          work: {
            kind: 'anchors' as const,
            callerCwd: '/fixture/repo',
            repositoryId: 'repository',
            worktreeId: 'worktree',
            codeRefs: ['src/first.ts'],
          },
        };
        const first = yield* requestRecallLexicalRefresh(scope);
        const newer = {
          ...scope,
          work: {
            ...scope.work,
            callerCwd: `/fixture/repo/component-${count}`,
            codeRefs: Array.from({length: count}, (_, i) => `src/next-${i}.ts`),
          },
        };
        const latest = yield* requestRecallLexicalRefresh(newer);
        expect(recallLexicalDemandKey(newer)).toBe(recallLexicalDemandKey(scope));
        expect((yield* readRecallLexicalDemand(scope))?.work).toEqual(newer.work);
        expect(yield* completeRecallLexicalRefresh(scope, first)).toBe(false);
        expect(yield* completeRecallLexicalRefresh(scope, latest)).toBe(true);
      }).pipe(provide),
    {fastCheck: {numRuns: 8}},
  );
  for (const mode of ['alias-moved', 'primary-deleted-alias-moved', 'primary-deleted-alias-live'] as const)
    it(`prunes post-hydration aliases for ${mode}`, () => {
      const primary = 'threadnote://user/me/memories/durable/primary.md';
      const alias = 'threadnote://user/me/memories/durable/alias.md';
      const candidate = {...indexCandidate(primary, body(), false), equivalentUris: [alias]};
      const records = [
        ...(mode === 'alias-moved' ? [parseMemoryDocument(primary, body())!] : []),
        parseMemoryDocument(alias, body(mode === 'primary-deleted-alias-live' ? 'allowed' : 'forbidden'))!,
      ];
      const result = buildRecallSections([], [], 12, {
        query: 'alpha',
        now: new Date('2026-11-03'),
        includeInactive: false,
        minimumScore: 0,
        eligibility,
        indexedCandidates: [candidate],
        records,
        absentMemoryUris: mode === 'alias-moved' ? [] : [primary],
      });
      if (mode === 'alias-moved') {
        expect(EffectArray.map(result.ranked, hit => hit.uri)).toEqual([primary]);
        expect(result.ranked[0]?.equivalentUris).toBeUndefined();
      } else expect(result.ranked).toEqual([]);
    });
  fcEffectProp(
    effectIt,
    'preserves reconciliation intent through ordinary coalescing and stale completion',
    {requests: fc.array(fc.boolean(), {minLength: 1, maxLength: 6})},
    ({requests}) =>
      Effect.gen(function* () {
        const {config} = yield* fixture;
        const scope = {...config, includeInactive: false};
        const revisions: string[] = [];
        let required = false;
        for (const reconcile of [true, ...requests]) {
          revisions.push(yield* requestRecallLexicalRefresh(scope, {reconcile}));
          required ||= reconcile;
          const state = yield* readRecallLexicalDemand(scope);
          expect(state?.version).toBe(2);
          expect(state?.reconcile).toBe(required);
        }
        for (const revision of revisions.slice(0, -1))
          expect(yield* completeRecallLexicalRefresh(scope, revision)).toBe(false);
        expect((yield* readRecallLexicalDemand(scope))?.reconcile).toBe(true);
        expect(yield* completeRecallLexicalRefresh(scope, revisions.at(-1)!)).toBe(true);
        expect((yield* readRecallLexicalDemand(scope))?.reconcile).toBeUndefined();
        yield* requestRecallLexicalRefresh(scope);
        expect((yield* readRecallLexicalDemand(scope))?.reconcile).toBe(false);
      }).pipe(provide),
    {fastCheck: {numRuns: 8}},
  );
  effectIt.effect('upgrades legacy demand and retains force escalation across exhausted backoff', () =>
    Effect.gen(function* () {
      const {fs, path, config} = yield* fixture;
      const scope = {...config, includeInactive: false};
      const revision = yield* requestRecallLexicalRefresh(scope);
      const filename = path.join(
        config.agentContextHome,
        'recall',
        'lexical-demand-v1',
        recallLexicalDemandKey(scope) + '.json',
      );
      const previous = JSON.parse(yield* fs.readFileString(filename));
      delete previous.reconcile;
      previous.version = 1;
      yield* fs.writeFileString(filename, JSON.stringify(previous));
      expect((yield* readRecallLexicalDemand(scope))?.version).toBe(1);
      yield* failRecallLexicalRefresh(scope, revision, true);
      expect((yield* readRecallLexicalDemand(scope))?.version).toBe(2);
      expect((yield* requestRecallLexicalRefresh(scope, {reconcile: true}).pipe(Effect.result))._tag).toBe('Failure');
      const retained = yield* readRecallLexicalDemand(scope);
      expect(retained?.reconcile).toBe(true);
      expect(retained?.failures).toBe(8);
      expect(retained?.revision).not.toBe(revision);
      expect(yield* completeRecallLexicalRefresh(scope, revision)).toBe(false);
      expect((yield* requestRecallLexicalRefresh(scope).pipe(Effect.result))._tag).toBe('Failure');
      expect((yield* readRecallLexicalDemand(scope))?.reconcile).toBe(true);
    }).pipe(provide),
  );
  fcEffectProp(
    effectIt,
    'cannot clear any newer queued maintenance event with an earlier completion',
    {
      count: fc.integer({min: 2, max: 8}),
    },
    ({count}) =>
      Effect.gen(function* () {
        const {config} = yield* fixture;
        const scope = {...config, includeInactive: false};
        const revisions: string[] = [];
        for (let i = 0; i < count; i++) revisions.push(yield* requestRecallLexicalRefresh(scope));
        for (const revision of revisions.slice(0, -1))
          expect(yield* completeRecallLexicalRefresh(scope, revision)).toBe(false);
        expect((yield* readRecallLexicalDemand(scope))?.revision).toBe(revisions.at(-1));
        expect(yield* completeRecallLexicalRefresh(scope, revisions.at(-1)!)).toBe(true);
      }).pipe(provide),
    {fastCheck: {numRuns: 8}},
  );
});
