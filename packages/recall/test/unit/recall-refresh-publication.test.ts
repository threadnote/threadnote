import {Database} from 'bun:sqlite';
import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {ApplicationError} from '@threadnote/platform/errors';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {
  loadRecallIndexData,
  readRecallIndexData,
  recallIndexDatabaseFilename,
  recallIndexStatus,
  expireRecallIndexValidation,
  type RecallIndexProgress,
} from '@threadnote/recall/index';
import {recallLogicalScope, RECALL_INVENTORY_POLICY_CHANGED_REASON} from '../../src/index/freshness.js';
import {readRecallIdentityAdmissionCut} from '../../src/index/admission.js';
import {readRecallLexicalDemand} from '@threadnote/recall/background/lexical-demand';
import {normalizeRecallHydrationChanges} from '../../src/index/refresh_cut.js';
import {readRecallStaleMarker} from '../../src/index/stale_marker.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
    ),
  ),
);
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, system, recallResourceInvalidationLayer);
const services = ResourceStore.layer.pipe(Layer.provideMerge(platform));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(services).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const document = (id: string, body: string) =>
  `MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_${id}\nsource_agent_client: test\ntimestamp: 2026-11-03T00:00:00.000Z\n\n${body}`;

const fixture = Effect.fn('test.recallPublicationFixture')(function* (count: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ResourceStore;
  const temporaryHome = yield* fs.makeTempDirectoryScoped({prefix: 'recall-publication-'});
  const home = yield* fs.realPath(temporaryHome);
  const root = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable');
  yield* fs.makeDirectory(root, {recursive: true});
  for (let i = 0; i < count; i++)
    yield* fs.writeFileString(path.join(root, `${i}.md`), document(String(i), `alpha old ${i}`));
  const manifestPath = path.join(home, 'manifest.json');
  const sourceRoot = path.join(home, 'source-repo');
  const sourcePath = path.join(sourceRoot, 'unrelated.md');
  const canonicalRoot = path.join(home, 'data', 'local', 'resources', 'repo');
  yield* fs.makeDirectory(sourceRoot, {recursive: true});
  yield* fs.makeDirectory(canonicalRoot, {recursive: true});
  yield* fs.writeFileString(sourcePath, 'seeded alpha evidence');
  yield* fs.copyFile(sourcePath, path.join(canonicalRoot, 'unrelated.md'));
  const sourceInfo = yield* fs.stat(sourcePath);
  yield* fs.writeFileString(
    manifestPath,
    JSON.stringify({
      version: 1,
      projects: [{name: 'Repo', path: sourceRoot, uri: 'threadnote://resources/repo', seed: ['**/*.md']}],
    }),
  );
  yield* fs.writeFileString(
    path.join(home, 'seed-state.json'),
    JSON.stringify({
      version: 1,
      files: {
        'threadnote://resources/repo/unrelated.md': {
          size: Number(sourceInfo.size),
          mtimeMs: sourceInfo.mtime._tag === 'Some' ? sourceInfo.mtime.value.getTime() : 0,
        },
      },
    }),
  );
  const config = {account: 'local', user: 'me', agentContextHome: home, manifestPath};
  const location = {account: 'local', user: 'me', home};
  const write = (id: number, body: string) =>
    store.mutateChecked(
      location,
      [
        {
          type: 'write',
          uri: `threadnote://user/me/memories/durable/${id}.md`,
          content: document(String(id), body),
          options: {mode: 'upsert'},
        },
      ],
      Effect.void,
    );
  const refresh = (onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>) =>
    loadRecallIndexData(config, {includeInactive: false, memoryIds: [], onProgress});
  // Tracked-publication examples need a managed baseline; no-clock legacy fallback is covered separately.
  yield* store.mutateChecked(
    location,
    [
      {
        type: 'write',
        uri: 'threadnote://resources/repo/unrelated.md',
        content: 'seeded alpha evidence',
        options: {mode: 'upsert'},
      },
    ],
    Effect.void,
  );
  let publicationStarted: number | undefined;
  let publicationMilliseconds = 0;
  yield* refresh(progress =>
    Effect.gen(function* () {
      if (progress.phase === 'writing' && publicationStarted === undefined)
        publicationStarted = yield* Clock.currentTimeMillis;
      if (progress.phase === 'activating' && publicationStarted !== undefined)
        publicationMilliseconds = (yield* Clock.currentTimeMillis) - publicationStarted;
    }),
  );
  const remove = (id: number) =>
    store.mutateChecked(
      location,
      [{type: 'remove', uri: `threadnote://user/me/memories/durable/${id}.md`}],
      Effect.void,
    );
  return {fs, path, home, root, config, sourcePath, write, remove, refresh, publicationMilliseconds};
});

function useDatabase<A>(filename: string, use: (db: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(filename, {create: false})),
    db => Effect.sync(() => use(db)),
    db => Effect.sync(() => db.close()),
  );
}

effectIt.effect('clears published invalidations when the configured home uses a filesystem alias', () =>
  Effect.gen(function* () {
    const f = yield* fixture(2);
    const aliasDirectory = yield* f.fs.makeTempDirectoryScoped({prefix: 'recall-home-alias-'});
    const alias = f.path.join(aliasDirectory, 'home');
    yield* f.fs.symlink(f.home, alias);
    const config = {...f.config, agentContextHome: alias};
    const markerPath = f.path.join(f.home, 'indexes', 'lexical', 'active-v13.sqlite');
    for (let i = 0; i < 2; i++) {
      yield* f.write(0, `alpha updated ${i}`);
      const events: RecallIndexProgress[] = [];
      yield* loadRecallIndexData(config, {
        includeInactive: false,
        memoryIds: [],
        onProgress: event =>
          Effect.sync(() => {
            events.push(event);
          }),
      });
      expect((yield* readRecallStaleMarker(f.fs, markerPath))?.invalidatedUris).toEqual([]);
      expect(EffectArray.filter(events, event => event.phase === 'indexing')[0]).toMatchObject({
        scanned: 1,
        total: 1,
      });
      expect((yield* recallIndexStatus(config)).ready).toBe(true);
    }
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('preserves hydration permission failures and programming defects', () =>
  Effect.gen(function* () {
    const denied = ApplicationError.make({
      operation: 'source-read',
      cause: {code: 'EACCES'},
      message: 'permission denied',
    });
    expect(yield* normalizeRecallHydrationChanges(Effect.fail(denied)).pipe(Effect.flip)).toBe(denied);
    const defect = new Error('programming defect');
    const exit = yield* normalizeRecallHydrationChanges(Effect.die(defect)).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
  }),
);

effectIt.effect('keeps a later client WAL after activating a recovered generation', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    const database = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
    yield* f.fs.writeFileString(database, 'not SQLite');
    let later: Database | undefined;
    let active = '';
    yield* Effect.gen(function* () {
      yield* f.refresh(progress =>
        progress.phase !== 'activating'
          ? Effect.void
          : Effect.gen(function* () {
              const directory = f.path.join(f.home, 'indexes', 'lexical', 'generations');
              const names = yield* f.fs.readDirectory(directory);
              const filename = Option.getOrUndefined(
                EffectArray.findFirst(names, name => EffectString.endsWith('.sqlite')(name)),
              );
              expect(filename).toBeDefined();
              active = f.path.join(directory, filename!);
              yield* Effect.sync(() => {
                later = new Database(active, {create: false});
                later.exec(
                  "PRAGMA journal_mode=WAL; CREATE TABLE later_writer(value TEXT); INSERT INTO later_writer VALUES ('durable')",
                );
              });
            }),
      );
      expect(yield* f.fs.exists(active + '-wal')).toBe(true);
      expect(yield* useDatabase(active, db => db.query('SELECT value FROM later_writer').all())).toEqual([
        {value: 'durable'},
      ]);
    }).pipe(Effect.ensuring(Effect.sync(() => later?.close())));
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('rejects raw recreation before a missing-file classification returns', () =>
  Effect.gen(function* () {
    const f = yield* fixture(2);
    yield* f.remove(0);
    const target = f.path.join(f.root, '0.md');
    let recreated = false;
    const observed = FileSystem.FileSystem.of({
      ...f.fs,
      stat: filename =>
        f.fs.stat(filename).pipe(
          Effect.tapError(error => {
            if (filename !== target || recreated || error.reason._tag !== 'NotFound') return Effect.void;
            recreated = true;
            return f.fs.writeFileString(target, document('0', 'recreated before classification returned'));
          }),
        ),
    });
    const result = yield* f.refresh().pipe(Effect.provideService(FileSystem.FileSystem, observed), Effect.result);
    expect(recreated).toBe(true);
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') expect(result.failure).toMatchObject({_tag: 'RecallIndexSourceChanged'});
    expect((yield* recallIndexStatus(f.config)).ready).toBe(false);
    yield* f.refresh();
    expect(
      (yield* readRecallIndexData(f.config, {includeInactive: false, memoryIds: ['tn_0']})).candidates[0]?.text,
    ).toContain('recreated before classification returned');
  }).pipe(provide, TestClock.withLive),
);

for (const uncertain of [false, true])
  effectIt.effect(
    `walks ${uncertain ? 'one full' : 'no unrelated'} inventory for ${uncertain ? 'unsupported' : 'archived'} invalidations`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(2);
        const store = yield* ResourceStore;
        yield* store.mutateChecked(
          {home: f.home, account: 'local', user: 'me'},
          [
            {type: 'remove', uri: 'threadnote://user/me/memories/durable/0.md'},
            {
              type: 'write',
              uri: 'threadnote://user/me/memories/archived/0.md',
              content: document('0', 'inactive'),
              options: {mode: 'upsert'},
            },
          ],
          Effect.void,
        );
        if (uncertain)
          yield* expireRecallIndexValidation(f.home, false, ['threadnote://user/unknown/memories/ambiguous.md']);
        let checks = 0;
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          stat: filename => {
            if (filename === f.path.join(f.root, '1.md')) checks++;
            return f.fs.stat(filename);
          },
        });
        yield* f.refresh().pipe(Effect.provideService(FileSystem.FileSystem, observed));
        expect(checks).toBe(uncertain ? 1 : 0);
        expect((yield* recallIndexStatus(f.config)).documentCount).toBe(2);
      }).pipe(provide, TestClock.withLive),
  );

effectIt.effect('reconciles legacy inactive inventory before admitting current writer identity', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    const archived = f.path.join(f.home, 'data', 'local', 'user', 'me', 'memories', 'archived', 'alias.md');
    yield* f.fs.makeDirectory(f.path.dirname(archived), {recursive: true});
    yield* f.fs.writeFileString(archived, document('0', 'divergent inactive alias'));
    yield* loadRecallIndexData(f.config, {includeInactive: true, memoryIds: []});
    const directory = f.path.join(f.home, 'indexes', 'lexical');
    const database = f.path.join(directory, recallIndexDatabaseFilename(false));
    yield* f.fs.copyFile(f.path.join(directory, recallIndexDatabaseFilename(true)), database);
    yield* useDatabase(database, db => {
      db.run("DELETE FROM metadata WHERE key IN ('inventory_policy_version','inventory_policy_content_generation')");
      db.run("UPDATE metadata SET value=? WHERE key='logical_scope'", [recallLogicalScope(f.config, false)]);
      db.run("UPDATE metadata SET value='false' WHERE key='include_inactive'");
    });
    expect((yield* recallIndexStatus(f.config)).reason).toBe(RECALL_INVENTORY_POLICY_CHANGED_REASON);
    const current = readRecallIdentityAdmissionCut({
      account: f.config.account,
      home: f.home,
      databasePath: Effect.succeed(database),
      fixedDatabasePath: database,
      pointerPath: EffectString.replace(/\.sqlite$/, '.pointer.json')(database),
      schemaVersion: 13,
      logicalScope: recallLogicalScope(f.config, false),
    });
    expect(yield* current.pipe(Effect.flip)).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
    const stale = yield* readRecallIndexData(f.config, {includeInactive: false, memoryIds: ['tn_0']});
    expect(stale.readState).toMatchObject({freshness: 'stale', maintenance: 'queued'});
    expect((yield* readRecallLexicalDemand({...f.config, includeInactive: false}))?.revision).toBeDefined();
    yield* f.refresh();
    expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
    const data = yield* readRecallIndexData(f.config, {includeInactive: false, memoryIds: ['tn_0']});
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0]?.identityConflict).not.toBe(true);
    expect(data.candidates[0]?.uri).toBe('threadnote://user/me/memories/durable/0.md');
    expect(
      yield* readRecallIdentityAdmissionCut({
        account: f.config.account,
        home: f.home,
        databasePath: Effect.succeed(database),
        fixedDatabasePath: database,
        pointerPath: EffectString.replace(/\.sqlite$/, '.pointer.json')(database),
        schemaVersion: 13,
        logicalScope: recallLogicalScope({...f.config, user: 'other'}, false),
      }).pipe(Effect.flip),
    ).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('rejects an older writer generation that inherited a newer inventory stamp', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    const database = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
    yield* useDatabase(database, db => {
      db.run(
        "UPDATE metadata SET value='older-writer-new-content' WHERE key IN ('content_generation','memory_identity_conflict_generation','logical_scope_content_generation')",
      );
    });
    expect((yield* recallIndexStatus(f.config)).reason).toBe(RECALL_INVENTORY_POLICY_CHANGED_REASON);
    yield* f.refresh();
    expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('refreshes one managed URI without walking 2000 unrelated canonical documents', () =>
  Effect.gen(function* () {
    const f = yield* fixture(2000);
    expect(f.publicationMilliseconds).toBeLessThan(2000);
    yield* Effect.logInfo({canonicalDocuments: 2001, fullPublicationUpperBoundMs: f.publicationMilliseconds});
    yield* f.write(0, 'alpha updated');
    let walks = 0;
    const checkedPaths = new Set<string>();
    const observed = FileSystem.FileSystem.of({
      ...f.fs,
      stat: name => {
        if (
          (EffectString.startsWith(f.root + f.path.sep)(name) &&
            EffectString.endsWith('.md')(name) &&
            name !== f.path.join(f.root, '0.md')) ||
          name === f.sourcePath
        ) {
          walks++;
          return Effect.die('targeted refresh inspected an unrelated canonical document');
        }
        return f.fs.stat(name);
      },
      readDirectory: (name, options) => {
        if (EffectString.startsWith(f.path.join(f.home, 'data') + f.path.sep)(name)) {
          walks++;
          return Effect.die('targeted refresh walked canonical data');
        }
        return f.fs.readDirectory(name, options);
      },
      realPath: name => {
        if (EffectString.startsWith(f.root + f.path.sep)(name)) checkedPaths.add(name);
        return f.fs.realPath(name);
      },
    });
    yield* f.refresh().pipe(Effect.provideService(FileSystem.FileSystem, observed));
    expect(walks).toBe(0);
    expect([...checkedPaths]).toEqual([f.path.join(f.root, '0.md')]);
    expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
    const data = yield* readRecallIndexData(f.config, {includeInactive: false, memoryIds: ['tn_0']});
    expect(data.candidates[0]?.text).toContain('alpha updated');
  }).pipe(provide, TestClock.withLive),
);

const childScript = `
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {Effect, Layer} from 'effect';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {withRecallIdentityAdmission, recallIndexDatabaseFilename} from '@threadnote/recall/index';
const [home, mode] = process.argv.slice(-2);
const config = {account:'local', user:'me', agentContextHome:home, manifestPath:home+'/manifest.json'};
if (mode==='sqlite') {
 const db=new Database(home+'/indexes/lexical/'+recallIndexDatabaseFilename(false), {create:false});
 db.exec('PRAGMA busy_timeout=50; BEGIN IMMEDIATE');
 db.exec("INSERT OR REPLACE INTO metadata VALUES ('independent_probe','committed')");
 db.exec('COMMIT');db.close();
} else {
 const system=SystemInfo.layer.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint,{developmentEntrypoint:import.meta.path}),
  Layer.succeed(ChildEnvironmentPolicy,{preserveIntendedChild:e=>e,sanitizeExternal:e=>e}),
 )));
 const platform=Layer.mergeAll(BunServices.layer,cryptoLayer,system,recallResourceInvalidationLayer);
 const layers=ResourceStore.layer.pipe(Layer.provideMerge(platform));
 await Effect.runPromise(Effect.gen(function*(){
  const store=yield* ResourceStore;
  const write=check=>store.mutateChecked({home,account:'local',user:'me'},[{
   type:'write',uri:'threadnote://user/me/memories/durable/1.md',
   content:'MEMORY\\nkind: durable\\nstatus: active\\nmemory_id: tn_1\\nsource_agent_client: test\\ntimestamp: 2026-11-03T00:00:00.000Z\\n\\nalpha child '+mode,
   options:{mode:'upsert'},
  }],check);
  if(mode==='strict') yield* withRecallIdentityAdmission(config,Effect.void,write);
  else yield* write(Effect.void);
 }).pipe(Effect.provide(layers)));
}
`;

function runChild(home: string, mode: string) {
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.spawn([process.execPath, '--eval', childScript, home, mode], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    ),
    child =>
      Effect.gen(function* () {
        const code = yield* Effect.promise(() => child.exited);
        const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
        expect(code, stderr).toBe(0);
      }).pipe(Effect.timeout('8 seconds')),
    child =>
      Effect.promise(async () => {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }),
  );
}

for (const race of [
  'writers',
  'metadata',
  'pointer',
  'policy',
  'raw-source',
  'tombstone',
  'recovery',
  'interrupt',
] as const)
  effectIt.effect(`releases hydration writers and rejects a changed ${race} publication cut`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(2);
      yield* f.write(0, 'alpha prepared');
      const database = f.path.join(f.home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
      if (race === 'tombstone') yield* f.remove(0);
      if (race === 'recovery') yield* f.fs.writeFileString(database, 'not a SQLite database');
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const phase = race === 'raw-source' || race === 'tombstone' ? 'writing' : 'indexing';
      const preparation = yield* f
        .refresh(progress =>
          progress.phase === phase && 'completed' in progress && progress.completed === 0
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        )
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.gen(function* () {
        yield* Deferred.await(entered).pipe(Effect.timeout('3 seconds'));
        if (race === 'writers') {
          // Each real child returns before the parent hydration barrier is released.
          yield* runChild(f.home, 'canonical');
          yield* runChild(f.home, 'strict');
          yield* runChild(f.home, 'sqlite');
        } else if (race === 'metadata') yield* runChild(f.home, 'sqlite');
        else if (race === 'pointer') {
          const replacement = f.path.join(f.home, 'indexes', 'lexical', 'generations', 'raced.sqlite');
          yield* f.fs.makeDirectory(f.path.dirname(replacement), {recursive: true});
          yield* f.fs.copyFile(database, replacement);
          yield* f.fs.writeFileString(
            EffectString.replace(/\.sqlite$/, '.pointer.json')(database),
            JSON.stringify({version: 1, database: 'generations/raced.sqlite'}),
          );
        } else if (race === 'policy') {
          const raw = yield* f.fs.readFileString(f.config.manifestPath);
          yield* f.fs.writeFileString(f.config.manifestPath, raw + '\n');
        } else if (race === 'raw-source' || race === 'tombstone') {
          const filename = f.path.join(f.root, '0.md');
          const original = yield* f.fs.stat(filename).pipe(Effect.option);
          yield* f.fs.writeFileString(filename, document('0', 'alpha tampered'));
          if (original._tag === 'Some' && original.value.mtime._tag === 'Some')
            yield* f.fs.utimes(filename, original.value.mtime.value, original.value.mtime.value);
        } else if (race === 'recovery') yield* runChild(f.home, 'canonical');
        else yield* Fiber.interrupt(preparation).pipe(Effect.timeout('3 seconds'));
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      if (race === 'interrupt') {
        expect((yield* recallIndexStatus(f.config)).ready).toBe(false);
        yield* runChild(f.home, 'canonical');
        yield* runChild(f.home, 'sqlite');
      } else {
        const result = yield* Fiber.join(preparation);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({_tag: 'RecallIndexSourceChanged'});
        expect((yield* recallIndexStatus(f.config)).ready).toBe(false);
      }
      if (race === 'recovery')
        expect(yield* f.fs.exists(EffectString.replace(/\.sqlite$/, '.pointer.json')(database))).toBe(false);
      yield* f.refresh();
      expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
      const data = yield* readRecallIndexData(f.config, {includeInactive: false, memoryIds: ['tn_1']});
      expect(data.candidates[0]?.text).toContain(
        race === 'writers'
          ? 'alpha child strict'
          : race === 'recovery' || race === 'interrupt'
            ? 'alpha child canonical'
            : 'alpha old 1',
      );
      if (race === 'raw-source' || race === 'tombstone') {
        const recreated = yield* readRecallIndexData(f.config, {includeInactive: false, memoryIds: ['tn_0']});
        expect(recreated.candidates[0]?.text).toContain('alpha tampered');
      }
    }).pipe(provide, TestClock.withLive),
  );
