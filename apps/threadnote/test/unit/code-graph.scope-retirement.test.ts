import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {Database} from 'bun:sqlite';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '@threadnote/graph/types';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {withCodeGraphTargetWorktreeLock} from '@threadnote/graph/maintenance/gate';
import {recordVerifiedCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import {queueCodeGraphScopeRetirements, reconcileCodeGraphScopeRetirements} from '@threadnote/graph/scope/retirement';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';

import {SystemInfo} from '@threadnote/platform/system';
import type {ProjectManifest, RuntimeConfig, SeedManifest} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const layer = Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer).pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

const fixture = Effect.fn('test.scopeRetirementFixture')(function* (options: {readonly initialize?: boolean} = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({prefix: 'threadnote-scope-retirement-'})
    .pipe(Effect.flatMap(fs.realPath));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(repo);
  yield* fs.makeDirectory(home, {mode: 0o700});
  yield* Effect.sync(() => {
    for (const args of [
      ['init', '-q'],
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'],
    ]) {
      const result = Bun.spawnSync(['git', '-C', repo, ...args]);
      if (result.exitCode !== 0) throw TestError.make({message: result.stderr.toString()});
    }
  });
  const identity = yield* resolveRepositoryIdentity(repo);
  yield* recordVerifiedCodeGraphLocalAssociation(home, identity);
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  const config: RuntimeConfig = {
    account: 'local',
    agentId: 'test',
    agentContextHome: home,
    user: 'test',
    manifestPath: path.join(root, 'manifest.yaml'),
  };
  const project: ProjectManifest = {
    name: 'api',
    path: identity.repoRoot,
    uri: 'threadnote://resources/repos/api',
    seed: [],
    graph: {roots: ['api'], closure: 'dependencies'},
  };
  const manifest = (projects: readonly ProjectManifest[]): SeedManifest => ({version: 1, projects});
  const store = yield* CodeGraphStore;
  if (options.initialize !== false) yield* store.initialize(layout.databasePath);
  const seed = (uri: string, index: number, worktreeId = identity.worktreeId) =>
    Effect.sync(() => {
      const scopeId = uri === 'full' ? 'full-repository' : `code-graph-scope:${sha256HexSync(uri)}`;
      const snapshotId = `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`;
      const database = new Database(layout.databasePath);
      try {
        database
          .query(
            `INSERT OR IGNORE INTO repositories (id, display_name, object_format, created_at, last_used_at) VALUES (?, 'test', 'sha1', ?, ?)`,
          )
          .run(identity.repositoryId, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
        database
          .query(
            `INSERT INTO snapshots (id, repository_id, worktree_id, scope_id, commit_id, extractor_set, dirty, state, file_count, symbol_count, edge_count, started_at, completed_at) VALUES (?, ?, ?, ?, ?, 'test', 0, 'ready', 0, 0, 0, ?, ?)`,
          )
          .run(
            snapshotId,
            identity.repositoryId,
            worktreeId,
            scopeId,
            identity.headCommit,
            '2026-09-20T00:00:00.000Z',
            '2026-09-20T00:00:00.000Z',
          );
        database
          .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
          .run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
        database
          .query('INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at) VALUES (?, ?, ?, ?)')
          .run(worktreeId, scopeId, snapshotId, '2026-09-20T00:00:00.000Z');
      } finally {
        database.close();
      }
      return {scopeId, snapshotId};
    });
  const active = () =>
    Effect.sync(() => {
      const database = new Database(layout.databasePath, {readonly: true});
      try {
        return database
          .query('SELECT worktree_id, scope_id, snapshot_id FROM active_snapshots ORDER BY snapshot_id')
          .all();
      } finally {
        database.close();
      }
    });
  const input = {checkoutId: identity.checkoutId, databasePath: layout.databasePath, threadnoteHome: home};
  const writeManifest = (projects: readonly ProjectManifest[]) =>
    fs.writeFileString(config.manifestPath, JSON.stringify(manifest(projects)));
  return {fs, path, repo, home, identity, layout, config, project, manifest, seed, active, input, writeManifest};
});

describe('configured graph scope retirement', () => {
  fcEffectProp(
    effectIt,
    'drains repeated configured-scope churn without indexing and keeps the intent directory bounded',
    [fc.uniqueArray(fc.integer({min: 0, max: 1_000_000}), {minLength: 4, maxLength: 16})],
    ([suffixes]) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const f = yield* fixture({initialize: false});
          let current = f.project;
          let maximumIntentFiles = 0;
          for (const suffix of suffixes) {
            const next = {...current, uri: `threadnote://resources/repos/api-${suffix}`};
            yield* queueCodeGraphScopeRetirements(f.config, f.manifest([current]), f.manifest([next]));
            yield* f.writeManifest([next]);
            const root = f.path.join(f.home, 'scope-retirements-v1');
            maximumIntentFiles = Math.max(
              maximumIntentFiles,
              EffectArray.filter(
                yield* f.fs.readDirectory(root),
                __effectArrayValue =>
                  !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
              ).length,
            );
            expect(yield* reconcileCodeGraphScopeRetirements(f.input)).toBeUndefined();
            expect(
              EffectArray.filter(
                yield* f.fs.readDirectory(root),
                __effectArrayValue =>
                  !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
              ),
            ).toEqual([]);
            current = next;
          }
          expect(maximumIntentFiles).toBeLessThanOrEqual(1);
        }).pipe(provideTestLayer(layer)),
      ),
    {fastCheck: {numRuns: 6}},
  );

  effectIt.effect('bounds globally queued requests when reconciliation cannot drain them', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture({initialize: false});
        let failures = 0;
        for (let index = 0; index < 70; index++) {
          const project = {...f.project, uri: `threadnote://resources/repos/pending-${index}`};
          const exit = yield* queueCodeGraphScopeRetirements(f.config, f.manifest([project]), f.manifest([])).pipe(
            Effect.exit,
          );
          if (exit._tag === 'Failure') failures += 1;
        }
        const files = EffectArray.filter(
          yield* f.fs.readDirectory(f.path.join(f.home, 'scope-retirements-v1')),
          __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
        );
        expect(failures).toBe(6);
        expect(files).toHaveLength(64);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('retires repeated URI churn while preserving full, sibling-project and sibling-worktree views', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed('full', 1);
        yield* f.seed('threadnote://resources/repos/sibling', 2);
        yield* f.seed(f.project.uri, 3, Effect2.pipe('e', EffectString.repeat(64)));
        let current = f.project;
        for (let index = 0; index < 6; index++) {
          yield* f.seed(current.uri, 10 + index);
          const next = {...current, uri: `threadnote://resources/repos/api-${index}`};
          yield* queueCodeGraphScopeRetirements(f.config, f.manifest([current]), f.manifest([next]));
          yield* queueCodeGraphScopeRetirements(f.config, f.manifest([current]), f.manifest([next]));
          yield* f.writeManifest([next]);
          expect((yield* reconcileCodeGraphScopeRetirements(f.input))?.result.state).toBe('removed');
          expect(yield* f.active()).toHaveLength(3);
          expect(yield* f.fs.readDirectory(f.path.join(f.home, 'scope-retirements-v1'))).toEqual([]);
          current = next;
        }
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('defers a live scoped builder and rechecks a reintroduced or shared manifest reference', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const selected = yield* f.seed(f.project.uri, 1);
        yield* queueCodeGraphScopeRetirements(f.config, f.manifest([f.project]), f.manifest([]));
        yield* f.writeManifest([]);
        yield* withCodeGraphTargetWorktreeLock(
          f.home,
          f.identity.checkoutId,
          f.identity.worktreeId,
          Effect.gen(function* () {
            expect(yield* reconcileCodeGraphScopeRetirements(f.input)).toBeUndefined();
            expect(yield* f.active()).toHaveLength(1);
            expect(yield* f.fs.readDirectory(f.path.join(f.home, 'scope-retirements-v1'))).toHaveLength(1);
          }),
          selected.scopeId,
        );
        yield* f.writeManifest([{...f.project, name: 'renamed'}]);
        expect(yield* reconcileCodeGraphScopeRetirements(f.input)).toBeUndefined();
        expect(yield* f.active()).toHaveLength(1);
        expect(yield* f.fs.readDirectory(f.path.join(f.home, 'scope-retirements-v1'))).toHaveLength(1);
        yield* f.writeManifest([]);
        expect((yield* reconcileCodeGraphScopeRetirements(f.input))?.result.state).toBe('removed');
        expect(yield* f.fs.readDirectory(f.path.join(f.home, 'scope-retirements-v1'))).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('uses persisted provenance after a configured checkout disappears', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(f.project.uri, 1);
        yield* f.fs.remove(f.repo, {recursive: true});
        expect(yield* queueCodeGraphScopeRetirements(f.config, f.manifest([f.project]), f.manifest([]))).toEqual([]);
        yield* f.writeManifest([]);
        expect((yield* reconcileCodeGraphScopeRetirements(f.input))?.result.state).toBe('removed');
        expect(yield* f.active()).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('retains a path-only no-op until missing-worktree provenance can identify its checkout', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture({initialize: false});
        yield* f.fs.remove(f.repo, {recursive: true});
        expect(yield* queueCodeGraphScopeRetirements(f.config, f.manifest([f.project]), f.manifest([]))).toEqual([]);
        yield* f.writeManifest([]);
        expect(yield* reconcileCodeGraphScopeRetirements(f.input)).toBeUndefined();
        expect(yield* f.fs.readDirectory(f.path.join(f.home, 'scope-retirements-v1'))).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('preserves snapshots when intent data is corrupt or linked outside the private ledger', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const selected = yield* f.seed(f.project.uri, 1);
        yield* queueCodeGraphScopeRetirements(f.config, f.manifest([f.project]), f.manifest([]));
        yield* f.writeManifest([]);
        const file = f.path.join(f.home, 'scope-retirements-v1', `${sha256HexSync(selected.scopeId)}.json`);
        yield* f.fs.writeFileString(file, 'invalid');
        expect(yield* reconcileCodeGraphScopeRetirements(f.input)).toBeUndefined();
        expect(yield* f.active()).toHaveLength(1);
        expect(
          yield* queueCodeGraphScopeRetirements(f.config, f.manifest([f.project]), f.manifest([f.project])),
        ).toEqual([]);
        if ((yield* SystemInfo).platform === 'win32') return;
        const outside = f.path.join(f.home, 'outside');
        yield* f.fs.writeFileString(outside, 'outside marker');
        yield* f.fs.remove(file);
        yield* f.fs.symlink(outside, file);
        expect(yield* reconcileCodeGraphScopeRetirements(f.input)).toBeUndefined();
        expect(yield* f.fs.readFileString(outside)).toBe('outside marker');
        expect(yield* f.active()).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );
});
