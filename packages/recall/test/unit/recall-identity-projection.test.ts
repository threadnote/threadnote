import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  consumeResourceRecallInvalidationReceipt,
  CurrentResourceRecallInvalidationObserver,
  makeResourceRecallInvalidationObservation,
} from '@threadnote/store/resource/recall-invalidation';
import {
  loadRecallIndexData,
  loadRecallMemoryIdentities,
  recallIndexDatabaseFilename,
  expireRecallIndexValidation,
} from '@threadnote/recall/index';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {resolveMemoryIdentityAliases} from '@threadnote/recall/memory/identity';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'identity-projection-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: env => ({...env}),
        sanitizeExternal: env => ({...env}),
      }),
    ),
  ),
);
const base = Layer.mergeAll(BunServices.layer, system, recallResourceInvalidationLayer);
const layer = Layer.merge(base, ResourceStore.layer.pipe(Layer.provide(base)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const root = 'threadnote://user/me/memories/durable';
const uri = `${root}/source.md`;
const body = (text: string, id = 'tn_projection', status = 'active') =>
  `MEMORY\nkind: durable\nstatus: ${status}\nmemory_id: ${id}\nproject: test\ntimestamp: 2026-10-27T00:00:00.000Z\n\n${text}`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'identity-projection-'});
  const config = {account: 'local', agentContextHome: home, user: 'me'};
  const store = yield* ResourceStore;
  const location = {home, account: 'local', user: 'me'};
  const database = path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
  const identity = (ids = ['tn_projection'], scopes: readonly string[] = [root]) =>
    loadRecallMemoryIdentities(config, {memoryIds: ids, allowedUriScopes: scopes, engine: 'identity-projection'});
  const lexical = (forceRefresh = false) => loadRecallIndexData(config, {includeInactive: false, forceRefresh});
  const snapshot = () =>
    Effect.sync(() => {
      const db = new Database(database);
      try {
        return {
          metadata: new Map(
            (db.query('SELECT key, value FROM metadata').all() as {key: string; value: string}[]).map(row => [
              row.key,
              row.value,
            ]),
          ),
          lexical: db.query('SELECT uri, candidate_json FROM documents ORDER BY uri').all(),
          identity: db.query('SELECT uri, candidate_json FROM identity_documents ORDER BY uri').all(),
          postings: db.query('SELECT * FROM postings ORDER BY term, document_id').all(),
        };
      } finally {
        db.close();
      }
    });
  return {fs, path, home, config, location, store, database, identity, lexical, snapshot};
});

it.effect('advances each projection alone and preserves the other marker/cursor, then converges full candidates', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.store.write(f.location, uri, body('first searchable words'), {mode: 'create'});
    yield* f.lexical();
    expect((yield* f.snapshot()).metadata.get('identity_initialized')).toBeUndefined();
    yield* f.identity();
    const baseline = yield* f.snapshot();
    yield* f.store.write(f.location, uri, body('second searchable words'), {mode: 'replace'});
    const lexicalMarker = yield* f.fs.readFileString(`${f.database}.stale`);
    const current = yield* f.identity();
    expect(current[0]?.text).toContain('second');
    const advanced = yield* f.snapshot();
    expect(advanced.lexical).toEqual(baseline.lexical);
    expect(advanced.postings).toEqual(baseline.postings);
    for (const key of ['canonical_mutation_generation', 'stale_generation', 'content_generation', 'integrity_sequence'])
      expect(advanced.metadata.get(key)).toBe(baseline.metadata.get(key));
    expect(yield* f.fs.readFileString(`${f.database}.stale`)).toBe(lexicalMarker);
    const identityMarker = yield* f.fs.readFileString(`${f.database}.identity.stale`);
    yield* f.lexical();
    const converged = yield* f.snapshot();
    expect(converged.lexical).toEqual(converged.identity);
    expect(yield* f.fs.readFileString(`${f.database}.identity.stale`)).toBe(identityMarker);
    expect(converged.metadata.get('identity_canonical_mutation_generation')).toBe(
      advanced.metadata.get('identity_canonical_mutation_generation'),
    );
    expect((yield* f.snapshot()).metadata.get('identity_source_validation_required')).toBe('false');
    yield* f.lexical(true);
    expect((yield* f.snapshot()).metadata.get('identity_source_validation_required')).toBe('false');
  }).pipe(TestClock.withLive, provide),
);

it.effect(
  'discovers untracked additions/removals and dirties a generation-current peer without cursor advancement',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.store.write(f.location, uri, body('original'), {mode: 'create'});
      yield* f.lexical();
      yield* f.identity();
      const before = yield* f.snapshot();
      const raw = f.path.join(f.home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'untracked.md');
      yield* f.fs.writeFileString(raw, body('outside store', 'tn_untracked'));
      yield* f.lexical(true);
      const dirty = yield* f.snapshot();
      expect(dirty.metadata.get('identity_source_validation_required')).toBe('true');
      expect(dirty.metadata.get('identity_canonical_mutation_generation')).toBe(
        before.metadata.get('identity_canonical_mutation_generation'),
      );
      expect((yield* f.identity(['tn_untracked'])).map(candidate => candidate.memoryId)).toEqual(['tn_untracked']);
      yield* f.fs.remove(raw);
      yield* expireRecallIndexValidation(f.home, false, []);
      expect(yield* f.identity(['tn_untracked'])).toEqual([]);
      expect((yield* f.snapshot()).metadata.get('source_validation_required')).toBe('true');
      yield* f.lexical();
      const final = yield* f.snapshot();
      expect(final.lexical).toEqual(final.identity);
    }).pipe(TestClock.withLive, provide),
);

it.effect('detects an untracked same-URI postimage after the peer consumed a managed generation', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.store.write(f.location, uri, body('initial'), {mode: 'create'});
    yield* f.lexical();
    yield* f.identity();
    yield* f.store.write(f.location, uri, body('managed generation'), {mode: 'replace'});
    yield* f.identity();
    const before = yield* f.snapshot();
    const canonical = f.path.join(f.home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'source.md');
    // Lexical still has the valid managed URI hint, but the peer has already consumed its postimage.
    yield* f.fs.writeFileString(
      canonical,
      body('out of band body and project policy').replace('project: test', 'project: changed'),
    );
    yield* f.lexical(true);
    const discovered = yield* f.snapshot();
    expect(discovered.metadata.get('identity_source_validation_required')).toBe('true');
    expect(discovered.metadata.get('identity_canonical_mutation_generation')).toBe(
      before.metadata.get('identity_canonical_mutation_generation'),
    );
    const [current] = yield* f.identity();
    expect(current?.text).toContain('out of band');
    expect(current?.fields?.project).toBe('changed');
    expect((yield* f.snapshot()).metadata.get('source_validation_required')).toBe('false');
    yield* f.lexical(true);
    expect((yield* f.snapshot()).metadata.get('identity_source_validation_required')).toBe('false');
  }).pipe(TestClock.withLive, provide),
);

it.effect('recovers missing continuity, overflow/legacy markers and logical corruption conservatively', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.store.write(f.location, uri, body('base'), {mode: 'create'});
    yield* f.identity();
    for (const marker of ['missing', 'legacy', 'overflow', 'corruption']) {
      yield* f.store.write(f.location, uri, body(marker), {mode: 'replace'});
      if (marker === 'missing') yield* f.fs.remove(`${f.database}.identity.stale`);
      if (marker === 'legacy') yield* f.fs.writeFileString(`${f.database}.identity.stale`, 'old legacy generation');
      if (marker === 'overflow')
        yield* expireRecallIndexValidation(
          f.home,
          false,
          Array.from({length: 1025}, (_, index) => `${root}/${index}.md`),
        );
      if (marker === 'corruption')
        yield* Effect.sync(() => {
          const db = new Database(f.database);
          try {
            db.exec("UPDATE identity_documents SET candidate_json = '{}' ");
          } finally {
            db.close();
          }
        });
      expect((yield* f.identity())[0]?.text).toContain(marker);
    }
  }).pipe(TestClock.withLive, provide),
);

it.effect('replaces a logically corrupt ordinary identity read only after its leases unwind', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.store.write(f.location, uri, body('live recovery source'), {mode: 'create'});
    yield* f.identity();
    yield* Effect.sync(() => {
      const db = new Database(f.database);
      try {
        db.exec("UPDATE identity_documents SET candidate_json = json_set(candidate_json, '$.text', 123)");
        // A selected malformed row is recoverable even when its persisted counter witness matches.
        db.exec(
          "UPDATE metadata SET value = (SELECT value FROM metadata WHERE key = 'identity_mutation_sequence') WHERE key = 'identity_integrity_sequence'",
        );
      } finally {
        db.close();
      }
    });
    expect((yield* f.identity())[0]?.text).toContain('live recovery source');
    const pointer = JSON.parse(yield* f.fs.readFileString(f.database.replace(/\.sqlite$/, '.pointer.json'))) as {
      database: string;
    };
    expect(pointer.database).toMatch(/^generations\//);
    const replacement = f.path.join(f.home, 'indexes', 'lexical', pointer.database);
    const state = yield* Effect.sync(() => {
      const db = new Database(replacement);
      try {
        return db.query("SELECT value FROM metadata WHERE key = 'initialized'").get();
      } finally {
        db.close();
      }
    });
    expect(state).toBeNull();
    expect(
      yield* f.fs.exists(
        f.path.join(f.home, 'locks', 'indexes', 'lexical', `${recallIndexDatabaseFilename(false)}.lock`),
      ),
    ).toBe(false);
  }).pipe(TestClock.withLive, provide),
);

it.effect(
  'acknowledges both projection markers in both scopes through a prebuilt real store, including partial failure',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const fail of [false, true]) {
        const inactive = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(true));
        if (fail) {
          yield* f.fs.remove(`${inactive}.identity.stale`);
          yield* f.fs.makeDirectory(`${inactive}.identity.stale`, {recursive: true});
        }
        const observation = makeResourceRecallInvalidationObservation(f.location);
        observation.expect([uri]);
        yield* f.store
          .write(f.location, uri, body(String(fail)), {mode: fail ? 'replace' : 'create'})
          .pipe(Effect.provideService(CurrentResourceRecallInvalidationObserver, observation.observer));
        observation.verify([uri]);
        expect(consumeResourceRecallInvalidationReceipt(observation.finish(true, [uri]), f.location, [uri])).toBe(
          !fail,
        );
        for (const file of [f.database, inactive]) {
          expect(yield* f.fs.exists(`${file}.stale`)).toBe(true);
          expect(yield* f.fs.exists(`${file}.identity.stale`)).toBe(true);
        }
        expect(yield* f.store.read(f.location, uri)).toBe(body(String(fail)));
      }
    }).pipe(TestClock.withLive, provide),
);

fcEffectProp(
  it,
  'preserves alias active/conflict outcomes and exact full candidate parity over bounded generated corpora',
  {
    rows: fc.array(
      fc.record({id: fc.integer({min: 0, max: 2}), text: fc.integer({min: 0, max: 3}), active: fc.boolean()}),
      {minLength: 1, maxLength: 7},
    ),
  },
  ({rows}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const [index, row] of rows.entries())
        yield* f.store.write(
          f.location,
          `${root}/${index}.md`,
          body(String(row.text), `tn_generated${row.id}`, row.active ? 'active' : 'archived'),
          {mode: 'create'},
        );
      const ids = ['tn_generated0', 'tn_generated1', 'tn_generated2'];
      const lexical = yield* loadRecallMemoryIdentities(f.config, {memoryIds: ids, allowedUriScopes: [root]});
      const identity = yield* f.identity(ids);
      expect(identity).toEqual(lexical);
      for (const memoryId of ids) {
        const resolve = (engine: 'lexical' | 'identity-projection') =>
          Effect.result(resolveMemoryIdentityAliases(f.config, [`threadnote://memory/${memoryId}`], [root], {engine}));
        expect(yield* resolve('identity-projection')).toEqual(yield* resolve('lexical'));
      }
    }).pipe(TestClock.withLive, provide),
  {fastCheck: {numRuns: 8, seed: 20261027}},
);
