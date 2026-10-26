import {describe, expect, it} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphDatabaseSession} from '@threadnote/graph/store/session';
import {CodeGraphIndexer, extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '../../src/citation/capture.js';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const unexpected = () => Effect.die('Citation capture must not index or request maintenance');
const packs = createCodeGraphLanguagePackRegistry([]);
const base = Layer.mergeAll(
  citationPlatformLayer,
  Layer.succeed(CodeGraphLanguagePackRegistry, packs),
  Layer.succeed(CodeGraphIndexer, CodeGraphIndexer.of({index: unexpected, ensureCommit: unexpected})),
  Layer.succeed(
    CodeGraphMaintenanceCoordinator,
    CodeGraphMaintenanceCoordinator.of({
      request: unexpected,
      tick: unexpected,
      kickOrdinary: unexpected,
      kickReconciliation: unexpected,
      kickResidual: unexpected,
    }),
  ),
  Layer.succeed(
    CodeGraphEmbeddingIndex,
    CodeGraphEmbeddingIndex.of({
      check: () => Effect.succeed({state: 'unavailable', reason: 'fixture'}),
      ensure: unexpected,
      search: unexpected,
    }),
  ),
);
const dependencies = CodeGraphStore.layer.pipe(Layer.provideMerge(base));
const source = 'export const value = 1;\n';

const fixture = (options: {legacy?: boolean; drift?: boolean; interrupt?: boolean} = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'citation-session-'});
    const repo = paths.join(root, 'repo');
    const home = paths.join(root, 'home');
    yield* fs.makeDirectory(repo);
    yield* fs.makeDirectory(home);
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
    yield* git(['init', '--quiet']);
    yield* fs.writeFileString(paths.join(repo, 'source.ts'), source);
    yield* git(['add', 'source.ts']);
    yield* git([
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
    const identity = yield* resolveRepositoryIdentity(repo);
    const layout = codeGraphLayout(paths, home, identity.checkoutId, identity.worktreeId);
    const bytes = new TextEncoder().encode(source);
    const snapshot: CodeGraphSnapshot = {
      id: `cgsn_${'1'.repeat(40)}`,
      commit: identity.headCommit,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
      extractorSet: extractorSetIdentityFromPackProvenance([]),
      dirty: false,
      edgeCount: 0,
      fileCount: 1,
      symbolCount: 0,
      state: 'ready',
      completedAt: '2026-10-26T00:00:00.000Z',
    };
    yield* store.activate(
      layout.databasePath,
      identity,
      snapshot,
      [
        {
          blobId: (yield* git(['rev-parse', 'HEAD:source.ts'])).stdout.trim(),
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
    yield* store.promote(layout.databasePath, identity, snapshot.id);
    yield* recordCodeGraphSnapshotAdmission(
      layout,
      snapshot,
      yield* observeCodeGraphAdmissionEnvironment(identity),
      packs,
      false,
    );
    const config = {
      account: 'test',
      user: 'test',
      agentId: 'test',
      agentContextHome: home,
      manifestPath: paths.join(home, 'manifest.yaml'),
      manifestSource: 'bundled-example' as const,
    };
    const events: string[] = [];
    const clients: unknown[] = [];
    let active = false;
    let leased = false;
    const observedStore = CodeGraphStore.of({
      ...store,
      readySnapshot: (...args) =>
        Effect.gen(function* () {
          const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
          clients.push(Option.isSome(session) ? session.value.sql : undefined);
          return yield* store.readySnapshot(...args);
        }),
      acquireSnapshotLease: (...args) =>
        store.acquireSnapshotLease(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(active).toBe(!options.legacy);
              leased = true;
              events.push('lease');
            }),
          ),
        ),
      releaseSnapshotLease: (...args) =>
        store.releaseSnapshotLease(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(active).toBe(!options.legacy);
              leased = false;
              events.push('release');
            }),
          ),
        ),
      effectiveSnapshotCitationEvidence: (...args) =>
        Effect.gen(function* () {
          expect(leased).toBe(true);
          events.push('evidence');
          if (options.interrupt) return yield* Effect.interrupt;
          return yield* store.effectiveSnapshotCitationEvidence(...args);
        }),
    });
    const context = yield* Layer.build(CodeGraphQueryService.layer).pipe(
      Effect.provideService(CodeGraphStore, observedStore),
    );
    const query = Context.get(context, CodeGraphQueryService);
    const withSession = query.withStatusSession;
    if (!withSession) throw new Error('Expected the real graph status session API');
    const observedQuery = CodeGraphQueryService.of({
      ...query,
      withStatusSession: options.legacy
        ? undefined
        : (home, cwd, expected, routing, use) =>
            withSession(home, cwd, expected, routing, status =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  expect(expected).toBeUndefined();
                  expect(routing).toMatchObject({observeWorktree: true, requestMaintenance: false});
                  active = true;
                  events.push('opening');
                }),
                () => use(status),
                () =>
                  Effect.sync(() => {
                    expect(leased).toBe(false);
                    active = false;
                    events.push('session-end');
                  }),
              ),
            ),
      status: (home, cwd, routing) =>
        Effect.gen(function* () {
          events.push(leased ? 'closing' : 'opening');
          expect(active).toBe(!options.legacy);
          if (leased && options.drift)
            yield* fs.writeFileString(paths.join(repo, 'source.ts'), 'export const value = 2;\n');
          return yield* query.status(home, cwd, routing);
        }),
    });
    return {
      clients,
      events,
      capture: captureMemoryCodeCitations(config, {
        callerCwd: repo,
        refs: ['source.ts'],
        expectedCallerIdentity: identity,
        expectedProjectScope: {kind: 'full'},
      }).pipe(
        Effect.provideService(CodeGraphQueryService, observedQuery),
        Effect.provideService(CodeGraphStore, observedStore),
      ),
    };
  });

describe('repository citation capture session', () => {
  it.layer(dependencies)(test => {
    test.effect(
      'keeps real opening/evidence/closing observations in one session and allocates a new session per capture',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const first = yield* f.capture;
          const second = yield* f.capture;
          expect(first).toEqual(second);
          expect(first).toHaveLength(1);
          expect(f.events).toEqual([
            'opening',
            'lease',
            'evidence',
            'closing',
            'release',
            'session-end',
            'opening',
            'lease',
            'evidence',
            'closing',
            'release',
            'session-end',
          ]);
          expect(f.clients).toHaveLength(4);
          expect(f.clients[0]).toBeDefined();
          expect(f.clients[0]).toBe(f.clients[1]);
          expect(f.clients[2]).toBe(f.clients[3]);
          expect(f.clients[0]).not.toBe(f.clients[2]);
        }).pipe(TestClock.withLive),
    );

    test.effect('preserves the independent closing fence and releases the real lease when source changes', () =>
      Effect.gen(function* () {
        const f = yield* fixture({drift: true});
        expect(yield* f.capture.pipe(Effect.flip)).toBeInstanceOf(MemoryCodeCitationCaptureError);
        expect(f.events).toEqual(['opening', 'lease', 'evidence', 'closing', 'release', 'session-end']);
      }).pipe(TestClock.withLive),
    );

    test.effect('releases the real lease before closing an interrupted capture session', () =>
      Effect.gen(function* () {
        const f = yield* fixture({interrupt: true});
        expect((yield* f.capture.pipe(Effect.exit))._tag).toBe('Failure');
        expect(f.events).toEqual(['opening', 'lease', 'evidence', 'release', 'session-end']);
      }).pipe(TestClock.withLive),
    );

    test.effect('retains the original observation path when the optional query session API is absent', () =>
      Effect.gen(function* () {
        const f = yield* fixture({legacy: true});
        expect(yield* f.capture).toHaveLength(1);
        expect(f.events).toEqual(['opening', 'lease', 'evidence', 'closing', 'release']);
        expect(f.clients).toEqual([undefined, undefined]);
      }).pipe(TestClock.withLive),
    );
  });
});
